'use client';

// Generate's adapter into the file store.
//
// The tool with the most to lose. Every finished row is a paid Azure call, and until this landed
// they survived a hop to another product and nothing else — a reload, a crash or a closed tab took
// the lot. Cleanup's cutouts are at least re-derivable from the source images at the cost of GPU
// time; a generated image is not re-derivable at all. The same prompt run twice returns a
// different picture.
//
// Two things make this codec different from the other three:
//
// THE RESULT IS NOT A BLOB. GenItem.image is an HTMLImageElement, which cannot be structured-
// cloned. Its `src` is a data: URL though (lib/pipeline.ts's b64ToImage builds it that way), so
// there is a Blob to be had — it just has to be decoded out at write time. See toBlob below for
// why that conversion is memoised rather than repeated.
//
// EVERY ROW IS WORTH KEEPING, generated or not. The other codecs drop draft rows because a draft
// there is a file the user still has on disk. A draft here is authored text — a name, a typed
// subject, a column mapping already applied — that exists nowhere else once the tab closes, and it
// costs a fraction of a kilobyte. Persisting all of them also removes the reconciliation problem
// entirely: the queue comes back exactly as it was, with no merge between "rows restored from
// disk" and "rows rebuilt from the sheet" to get subtly wrong.

import type { CsvRecord } from '../../csv';
import type { GenItem, GenStatus } from '../../gen';
import type { ItemPayload, ItemRecord, ToolCodec } from '../types';

export const RESULT_BLOB = 'result';

/** The plain half of one row. */
export interface GenItemData {
  name: string;
  record: CsvRecord;
  subject?: string;
  /**
   * The prompt actually sent. NOT re-derivable: the live preview is built from the current brief
   * and column selection, so a row generated before the brief was edited would come back claiming
   * it used the edited one. It is also the only record of what produced an image nothing can
   * reproduce.
   */
  sentPrompt?: string;
  durationMs?: number;
  errorMsg?: string;
  /** Only 'done' and 'error' are stored — see statusFrom for why the rest come back as 'ready'. */
  status: GenStatus;
}

/** Generate's document identity. Small by contract — the brief and the sheet are meta singletons. */
export interface GenDoc {
  sessionName: string;
  briefName: string | null;
  csvName: string | null;
  headers: string[];
  nameCols: string[];
  excluded: string[];
  rowCount: number;
}

export const EMPTY_GEN_DOC: GenDoc = {
  sessionName: '',
  briefName: null,
  csvName: null,
  headers: [],
  nameCols: [],
  excluded: [],
  rowCount: 0,
};

/**
 * The image's bytes, without re-encoding it.
 *
 * `src` is a data: URL, so fetch() decodes the base64 for us — no canvas, no re-compression, and
 * the bytes that reach disk are the bytes Azure returned.
 *
 * Memoised per element because the pump asks for a payload whenever a row's signature moves, and
 * an element that has not changed must not pay to be decoded twice. Weak, so a superseded image
 * is collected with its entry rather than pinned by this cache — the same argument the ledger's
 * shipped WeakSet makes.
 */
const blobCache = new WeakMap<HTMLImageElement, Promise<Blob | null>>();

function toBlob(image: HTMLImageElement): Promise<Blob | null> {
  const hit = blobCache.get(image);
  if (hit) return hit;
  const task = (async () => {
    try {
      const res = await fetch(image.src);
      return await res.blob();
    } catch {
      // A src that is not a data: URL, or one whose object URL has been revoked. recordOf turns
      // this into "write nothing at all" rather than "write the row without its picture".
      return null;
    }
  })();
  blobCache.set(image, task);
  return task;
}

/**
 * Where a row that was mid-flight comes back.
 *
 * 'generating' can never be restored as itself: the request it was waiting on died with the tab,
 * so the row would spin forever and the page would refuse to re-run it, reading the status as
 * "a request is already out for this one". A row with a picture rests at 'done', one without at
 * 'ready' — the same rule lib/session-store.ts applies across the suite.
 */
function statusFrom(stored: GenStatus, hasImage: boolean): GenStatus {
  if (stored === 'error') return 'error';
  return hasImage ? 'done' : 'ready';
}

export const genCodec: ToolCodec<GenItem, GenDoc> = {
  tool: 'image-generator',
  schema: 1,

  idOf: (item) => item.id,

  // Identity on the element, not its src: a regenerate assigns a whole new HTMLImageElement, and
  // comparing the src string would mean hashing a megabyte of base64 on every render of every row.
  // `sentPrompt` earns its place beside it — it is written once per row at send time, and it is
  // the half of the record that cannot be reconstructed from anything else.
  signatureOf: (item) => [item.image, item.sentPrompt ?? null, item.name, item.status],

  async recordOf(item: GenItem): Promise<ItemPayload | null> {
    const data: GenItemData = {
      name: item.name,
      record: item.record,
      status: item.status,
      ...(item.subject !== undefined ? { subject: item.subject } : null),
      ...(item.sentPrompt ? { sentPrompt: item.sentPrompt } : null),
      ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : null),
      ...(item.errorMsg ? { errorMsg: item.errorMsg } : null),
    };
    const blobs: Record<string, Blob> = {};
    if (item.image) {
      const blob = await toBlob(item.image);
      if (!blob) {
        /**
         * The row HAS a picture but its bytes could not be read — a revoked object URL, a src
         * that is not fetchable. Refusing to write is the only safe answer: a record put here
         * would replace the one on disk with an identical text half and NO image, and since the
         * pump only writes rows whose signature moved, nothing would ever put the picture back.
         *
         * This is not hypothetical. The first version of hydrateImages handed restored rows a
         * revoked object URL; the next pass converted them, got nothing, wrote the rows back
         * without their blobs, and a reload showed three empty tiles where three paid images had
         * been. Null leaves the good record exactly where it is.
         */
        return null;
      }
      blobs[RESULT_BLOB] = blob;
      // So thumbSourceOf, which must answer synchronously, has something to answer with.
      rememberThumbBlob(item.image, blob);
    }
    // Never null: see the header. A row with no image is still authored state — its name, its
    // typed subject, the column mapping already applied to it — and it costs a fraction of a
    // kilobyte to keep.
    return { data, blobs };
  },

  itemFrom: (record, id) => itemFromRecord(record, id as number),

  docOf: (doc) => ({
    sessionName: doc.sessionName,
    briefName: doc.briefName,
    csvName: doc.csvName,
    headers: doc.headers,
    nameCols: doc.nameCols,
    excluded: doc.excluded,
    rowCount: doc.rowCount,
  }),

  docFrom: (raw) => parseDoc(raw),

  hasContent: (doc, items) =>
    items.length > 0 || doc.rowCount > 0 || doc.sessionName.trim().length > 0,

  countOf: (doc, items) => (items.length ? items.length : doc.rowCount),

  // The first generated image. By reference, so an unchanged first result never re-encodes the
  // card's thumbnail — but this codec's blobs are produced asynchronously, so the header writer
  // sees null until one lands and then a stable value after.
  thumbSourceOf: (items) => {
    const first = items.find((item) => item.image);
    if (!first?.image) return null;
    return thumbBlobs.get(first.image) ?? null;
  },
};

/**
 * Thumbnail sources, filled in as blobs are produced.
 *
 * thumbSourceOf has to be synchronous — it is called from a render-time memo — while the blob it
 * wants is only available after an async decode. So the pump's own conversion populates this on
 * the way past, and the header writer picks it up on the next pass. One render late, which for a
 * card thumbnail is not late at all.
 */
const thumbBlobs = new WeakMap<HTMLImageElement, Blob>();

/** Called by recordOf's conversion so thumbSourceOf can answer synchronously next time. */
export function rememberThumbBlob(image: HTMLImageElement, blob: Blob): void {
  thumbBlobs.set(image, blob);
}

/**
 * Seeds the write-side cache for an image that came OFF disk.
 *
 * Without it the first pass after a restore would decode every restored row's data: URL back into
 * the very bytes it was just built from, and re-put a file's worth of blobs that never changed.
 */
export function rememberBlob(image: HTMLImageElement, blob: Blob): void {
  blobCache.set(image, Promise.resolve(blob));
}

export function itemFromRecord(record: ItemRecord, id: number): GenItem {
  const d = (record.data ?? {}) as GenItemData;
  const blob = record.blobs?.[RESULT_BLOB];
  return {
    id,
    record: d.record ?? {},
    name: d.name ?? '',
    status: statusFrom(d.status ?? 'ready', !!blob),
    image: null, // filled in by the caller — decoding is async, see hydrateImages below
    ...(d.subject !== undefined ? { subject: d.subject } : null),
    ...(d.sentPrompt ? { sentPrompt: d.sentPrompt } : null),
    ...(d.durationMs !== undefined ? { durationMs: d.durationMs } : null),
    ...(d.errorMsg ? { errorMsg: d.errorMsg } : null),
  };
}

/**
 * The stored pictures, decoded back into elements.
 *
 * Separate from itemFrom because that is synchronous and this cannot be: an HTMLImageElement is
 * only usable once it has loaded. The page therefore gets its rows immediately — names, prompts,
 * statuses, the whole panel — and the pictures fill in behind them, which is also the right order
 * for a 500-row set where the text is what the user is looking for first.
 *
 * Rebuilt as a data: URL, not an object URL, so a restored row is indistinguishable from a freshly
 * generated one — lib/pipeline.ts's b64ToImage produces exactly this shape. That matters more than
 * the bytes it costs: `image.src` is read by the exporter, by this codec's own toBlob and by the
 * cell, and an object URL would put a revocation deadline on all three. The first version did
 * revoke, one line after the decode, and every restored tile came back blank — the element had
 * loaded, but the src every later reader copied was already dead.
 */
export async function hydrateImages(
  records: readonly ItemRecord[],
  onImage: (id: number, image: HTMLImageElement, blob: Blob) => void,
): Promise<void> {
  for (const record of records) {
    const blob = record.blobs?.[RESULT_BLOB];
    if (!blob) continue;
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('stored image unreadable'));
        reader.readAsDataURL(blob);
      });
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('stored image failed to decode'));
        img.src = dataUrl;
      });
      // The blob is already the exact bytes on disk, so seeding both caches here means a restored
      // row is never re-encoded to be written back or to make a thumbnail.
      rememberThumbBlob(image, blob);
      rememberBlob(image, blob);
      onImage(record.id as number, image, blob);
    } catch {
      // One unreadable picture costs its row an image, not the whole restore.
    }
  }
}

/** Field by field, like every other read off disk here: a stored record is still input. */
function parseDoc(raw: unknown): GenDoc {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_GEN_DOC };
  const r = raw as Record<string, unknown>;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && !!v) : [];
  return {
    sessionName: typeof r.sessionName === 'string' ? r.sessionName : '',
    briefName: typeof r.briefName === 'string' ? r.briefName : null,
    csvName: typeof r.csvName === 'string' ? r.csvName : null,
    headers: strings(r.headers),
    nameCols: strings(r.nameCols),
    excluded: strings(r.excluded),
    rowCount:
      typeof r.rowCount === 'number' && Number.isFinite(r.rowCount)
        ? Math.max(0, Math.round(r.rowCount))
        : 0,
  };
}
