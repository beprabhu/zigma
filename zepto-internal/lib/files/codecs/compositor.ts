'use client';

// Compose's adapter into the file store.
//
// The last of the four and the awkward one, for two reasons that pull in opposite directions.
//
// ITS RESULT IS AN ELEMENT, like Generate's — a composed tile held as an HTMLImageElement over a
// data: URL. Same conversion at write time, same memoised decode.
//
// ITS INPUTS ARE FILES, unlike Generate's. A folder drop can be gigabytes of product shots, and
// those shots are still sitting on the user's disk. So they are NOT persisted, and the rule for
// which rows are worth keeping falls out of that:
//
//   a CSV row          always kept. Its identity is text — the record, the mapped title and
//                      offer, the image URLs — and the URLs are re-fetchable, so the row rebuilds
//                      into something useful whether or not it has been composed yet.
//   a dropped image    kept ONLY once it has a composed tile. Before that the row is a file the
//                      user still has, and a restored placeholder with no picture and no source
//                      is worse than no row at all: it looks like work that survived, and isn't.
//
// A restored image-mode row can therefore be exported but not re-composed — the same trade
// Compress makes, and for the same reason. Re-drop the folder to run it again.

import type { CsvRecord } from '../../csv';
import type { GridBand, ItemStatus, QueueItem } from '../../types';
import type { ItemPayload, ItemRecord, ToolCodec } from '../types';

export const RESULT_BLOB = 'result';

/** The plain half of one tile. */
export interface ComposeItemData {
  row: number;
  bandId?: string;
  record: CsvRecord;
  urls: string[];
  /**
   * The names of the dropped files behind this tile — names only, never the bytes.
   *
   * Enough for the row to say what it was made from and for the export to name it, and small
   * enough that a 3,000-tile folder drop costs kilobytes instead of the gigabytes the files
   * themselves would.
   */
  sourceNames?: string[];
  title: string;
  offer: string;
  status: ItemStatus;
  errorMsg?: string;
}

/**
 * Compose's document identity.
 *
 * `bands` is here but STRIPPED of the two fields that make GridBand expensive — every band
 * carries its own `headers` and `records`, and a six-band grid over real sheets is megabytes.
 * Those live in a meta singleton instead (see BANDS_KEY), because listFiles() reads every doc on
 * every homepage mount and a doc that scales with the sheets would make the grid crawl.
 */
export interface ComposeDoc {
  sessionName: string;
  mode: 'csv' | 'images' | null;
  fileName: string | null;
  headers: string[];
  imageCols: string[];
  titleCols: string[];
  offerCol: string;
  /** Bands without their sheets. Re-joined with BANDS_KEY on open. */
  bands: LeanBand[];
  /** Template preview text, which is document state — it is drawn onto every tile. */
  tplTitle: string;
  tplOffer: string;
  offerVisible: boolean;
  /**
   * The id counter. Persisted because ids come from a counter rather than a sheet position in
   * grid mode, so a restore that recomputed it from the queue would hand a new row an id a
   * deleted one already used — and the export names by id.
   */
  nextItemId: number;
  rowCount: number;
}

/** A GridBand with the two heavy fields removed. */
export type LeanBand = Omit<GridBand, 'headers' | 'records'>;

/** Meta singleton: every band's sheet, by band id. */
export const BANDS_KEY = 'bands';

export interface BandSheets {
  [bandId: string]: { headers: string[]; records: CsvRecord[] };
}

export const EMPTY_COMPOSE_DOC: ComposeDoc = {
  sessionName: '',
  mode: null,
  fileName: null,
  headers: [],
  imageCols: [],
  titleCols: [],
  offerCol: '',
  bands: [],
  tplTitle: 'Tile name',
  tplOffer: '20% OFF',
  offerVisible: true,
  nextItemId: 0,
  rowCount: 0,
};

/** See Generate's codec — same conversion, same reason for memoising it. */
const blobCache = new WeakMap<HTMLImageElement, Promise<Blob | null>>();
const thumbBlobs = new WeakMap<HTMLImageElement, Blob>();

function toBlob(image: HTMLImageElement): Promise<Blob | null> {
  const hit = blobCache.get(image);
  if (hit) return hit;
  const task = (async () => {
    try {
      const res = await fetch(image.src);
      return await res.blob();
    } catch {
      return null;
    }
  })();
  blobCache.set(image, task);
  return task;
}

export function rememberBlobs(image: HTMLImageElement, blob: Blob): void {
  blobCache.set(image, Promise.resolve(blob));
  thumbBlobs.set(image, blob);
}

/**
 * Where a row that was mid-run comes back. 'fetching', 'generating' and 'removing-bg' all died
 * with the tab, so a row still wearing one would render as a spinner nothing can finish.
 */
function statusFrom(stored: ItemStatus, hasResult: boolean): ItemStatus {
  if (stored === 'error' || stored === 'no-images') return stored;
  return hasResult ? 'done' : 'ready';
}

export const composeCodec: ToolCodec<QueueItem, ComposeDoc> = {
  tool: 'compositor',
  schema: 1,

  idOf: (item) => item.id,

  // `compressed` is deliberately absent: it is a cache the page invalidates whenever the template
  // changes, so putting it in the signature would rewrite every row on a slider drag — and putting
  // it in the record would store bytes that are wrong the moment the template moves.
  signatureOf: (item) => [item.resultImage, item.title, item.offer, item.status],

  async recordOf(item: QueueItem): Promise<ItemPayload | null> {
    const hasResult = !!item.resultImage;
    const fromSheet = item.urls.length > 0;
    // The drafts rule, in the shape this tool needs it — see the header.
    if (!hasResult && !fromSheet) return null;

    const data: ComposeItemData = {
      row: item.row,
      record: item.record,
      urls: item.urls,
      title: item.title,
      offer: item.offer,
      status: item.status,
      ...(item.bandId ? { bandId: item.bandId } : null),
      ...(item.localSources?.length
        ? { sourceNames: item.localSources.map((source) => source.name) }
        : null),
      ...(item.errorMsg ? { errorMsg: item.errorMsg } : null),
    };

    const blobs: Record<string, Blob> = {};
    if (item.resultImage) {
      const blob = await toBlob(item.resultImage);
      // Same rule Generate learned the hard way: a row whose picture cannot be read must not be
      // written at all, or the record on disk is replaced by one without it and nothing ever puts
      // it back.
      if (!blob) return null;
      blobs[RESULT_BLOB] = blob;
      thumbBlobs.set(item.resultImage, blob);
    }
    return { data, blobs };
  },

  itemFrom: (record, id) => itemFromRecord(record, id as number),

  docOf: (doc) => ({ ...doc }),
  docFrom: (raw) => parseDoc(raw),

  hasContent: (doc, items) =>
    items.length > 0 || doc.rowCount > 0 || doc.sessionName.trim().length > 0,

  countOf: (doc, items) => (items.length ? items.length : doc.rowCount),

  thumbSourceOf: (items) => {
    const first = items.find((item) => item.resultImage);
    if (!first?.resultImage) return null;
    return thumbBlobs.get(first.resultImage) ?? null;
  },
};

export function itemFromRecord(record: ItemRecord, id: number): QueueItem {
  const d = (record.data ?? {}) as ComposeItemData;
  const blob = record.blobs?.[RESULT_BLOB];
  return {
    id,
    row: d.row ?? 0,
    record: d.record ?? {},
    urls: d.urls ?? [],
    title: d.title ?? '',
    offer: d.offer ?? '',
    status: statusFrom(d.status ?? 'ready', !!blob),
    resultImage: null, // filled in by hydrateResults — decoding is async
    compressed: null,
    ...(d.bandId ? { bandId: d.bandId } : null),
    // Names without bytes: the row can say what it came from, and re-composing it needs the
    // folder dropped again. A blob URL is deliberately NOT minted here — there is nothing behind
    // it, and an <img> pointing at a fabricated URL is worse than an empty frame.
    ...(d.sourceNames?.length
      ? { localSources: d.sourceNames.map((name) => ({ name, url: '' })) }
      : null),
    ...(d.errorMsg ? { errorMsg: d.errorMsg } : null),
  };
}

/**
 * The stored tiles, decoded back into elements.
 *
 * Data URLs, not object URLs — see the note on Generate's hydrateImages. `resultImage.src` is read
 * by the exporter and by this codec's own conversion, and an object URL would put a revocation
 * deadline on both.
 */
export async function hydrateResults(
  records: readonly ItemRecord[],
  onResult: (id: number, image: HTMLImageElement) => void,
): Promise<void> {
  for (const record of records) {
    const blob = record.blobs?.[RESULT_BLOB];
    if (!blob) continue;
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('stored tile unreadable'));
        reader.readAsDataURL(blob);
      });
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('stored tile failed to decode'));
        img.src = dataUrl;
      });
      // Seeds both caches so a restored tile is never re-encoded to be written back.
      rememberBlobs(image, blob);
      onResult(record.id as number, image);
    } catch {
      // One unreadable tile costs its row a picture, not the whole restore.
    }
  }
}

/** Strips a band down to what the doc may carry. */
export function leanBand(band: GridBand): LeanBand {
  return {
    id: band.id,
    presetId: band.presetId,
    count: band.count,
    columns: band.columns,
    fileName: band.fileName,
    imageCols: band.imageCols,
    titleCols: band.titleCols,
    offerCol: band.offerCol,
  };
}

/** Re-joins a stripped band with the sheet held in the meta singleton. */
export function fattenBand(band: LeanBand, sheets: BandSheets | undefined): GridBand {
  const sheet = sheets?.[band.id];
  return { ...band, headers: sheet?.headers ?? [], records: sheet?.records ?? [] };
}

/** Field by field, like every other read off disk here: a stored record is still input. */
function parseDoc(raw: unknown): ComposeDoc {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_COMPOSE_DOC };
  const r = raw as Record<string, unknown>;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && !!v) : [];
  const num = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback;

  const bands: LeanBand[] = Array.isArray(r.bands)
    ? r.bands.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const b = entry as Record<string, unknown>;
        if (typeof b.id !== 'string' || !b.id) return [];
        return [{
          id: b.id,
          presetId: typeof b.presetId === 'string' ? b.presetId : '',
          count: num(b.count, 0),
          columns: Math.max(1, num(b.columns, 1)),
          fileName: typeof b.fileName === 'string' ? b.fileName : null,
          imageCols: strings(b.imageCols),
          titleCols: strings(b.titleCols),
          offerCol: typeof b.offerCol === 'string' ? b.offerCol : '',
        }];
      })
    : [];

  const mode = r.mode === 'csv' || r.mode === 'images' ? r.mode : null;
  return {
    sessionName: typeof r.sessionName === 'string' ? r.sessionName : '',
    mode,
    fileName: typeof r.fileName === 'string' ? r.fileName : null,
    headers: strings(r.headers),
    imageCols: strings(r.imageCols),
    titleCols: strings(r.titleCols),
    offerCol: typeof r.offerCol === 'string' ? r.offerCol : '',
    bands,
    tplTitle: typeof r.tplTitle === 'string' ? r.tplTitle : EMPTY_COMPOSE_DOC.tplTitle,
    tplOffer: typeof r.tplOffer === 'string' ? r.tplOffer : EMPTY_COMPOSE_DOC.tplOffer,
    offerVisible: r.offerVisible !== false,
    nextItemId: num(r.nextItemId, 0),
    rowCount: num(r.rowCount, 0),
  };
}
