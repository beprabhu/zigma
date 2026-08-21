'use client';

// Cleanup's adapter into the file store.
//
// This is lib/bg/autosave.ts's recordOf (:379-415), Signature (:439-458) and the page's
// itemFromAutosave (app/bg-remover/page.tsx:255-303) re-cut against the generic shape: the plain
// fields become `data`, the two binaries become `blobs`, and everything the old AutosaveRecord said
// about WHY a field is or is not persisted still holds and is repeated where it applies.
//
// Three things this codec persists that the old crash net did not, all of them paid inference or a
// human decision that has been quietly dying on every reload:
//   semantic    a second, different-architecture model's verdict (BgSemantic) — billed per item
//   manualFlag  the operator's override of the computed verdict, set from the compare dialog
//   tileFit     the per-item pin that overrides the global toggle

import type {
  BgCutout,
  BgItem,
  BgItemSource,
  BgSemantic,
  BgVerify,
  CsvOrigin,
} from '../../bg/batch';
import type { DetectedBand } from '../../bg/bands';
import type { InkFootprint, OriginalComponentReport, RegionReport } from '../../bg/regions';
import type { SubjectBounds } from '../../bg/safe-area';
import type { ItemPayload, ItemRecord, ToolCodec } from '../types';

/** Blob slot names. Stable strings — they are on disk. */
export const CUTOUT_BLOB = 'cutout';
export const SOURCE_BLOB = 'source';

/**
 * The plain half of one row. Everything here must survive a structured clone, which rules out the
 * decoded original (an HTMLImageElement, and re-decodable from `source` anyway).
 */
export interface BgItemData {
  name: string;
  /** Display provenance for restored rows: a file name, a URL, or a project label. */
  origin: string;
  /** URL sources survive as URLs so redo still works after a restore. */
  sourceUrl: string | null;
  sourceFileName: string | null;
  bounds: SubjectBounds | null;
  width: number;
  height: number;
  residueFraction?: number;
  csv?: CsvOrigin;
  /** Where the row came from before an AI edit replaced its source. URL only, reference only. */
  originalSourceUrl?: string;
  batch?: number;
  regions?: RegionReport[];
  removedRegions?: number;
  originalInk?: InkFootprint;
  components?: OriginalComponentReport[];
  verify?: BgVerify;
  semantic?: BgSemantic;
  bands?: DetectedBand[];
  manualFlag?: 'flag' | 'clear';
  tileFit?: boolean;
}

/** Cleanup's document identity. Deliberately tiny — see ToolCodec.docOf's size rule. */
export interface BgDoc {
  sessionName: string;
  /**
   * The export high-water mark. Two numbers, monotone by construction, and the ONLY thing that
   * keeps continuous file numbering across ZIPs honest across a reload: a BatchRecord rebuilt from
   * disk has offset 0, so nextAllocation (lib/bg/ledger.ts:207-211) would compute max(count)
   * instead of the running sum and the next export would renumber straight over files already
   * sitting in the user's downloads folder.
   */
  allocFloor: { batch: number; offset: number } | null;
  /**
   * Which record ids each sealed batch contained. Lives here rather than on the rows because
   * stamping a 500-item cohort must not re-put 500 cutout blobs to record one number each — the
   * same argument that keeps `batch` out of the signature below.
   */
  batchIds: [number, number[]][];
  /** Rows in the imported sheet, for the homepage card. 0 for a file-dropped batch. */
  rowCount: number;
}

const EMPTY_DOC: BgDoc = { sessionName: '', allocFloor: null, batchIds: [], rowCount: 0 };

function originOf(item: BgItem): string {
  if (item.source.kind === 'file') return item.source.file.name;
  if (item.source.kind === 'url') return item.source.url;
  return item.source.label;
}

/** The AI-regenerated source — the output that cost money. Ordinary sources are re-fetchable. */
function regeneratedFile(item: BgItem): File | null {
  return item.source.kind === 'file' && item.source.regenerated ? item.source.file : null;
}

export const bgCodec: ToolCodec<BgItem, BgDoc> = {
  tool: 'bg-remover',
  schema: 1,

  idOf: (item) => item.id,

  // Identity comparison throughout: a cutout blob or a regenerated file is only ever swapped
  // wholesale, so pointer checks do the work content hashing would (autosave.ts:417-419).
  //
  // What is NOT here is the load-bearing part. `batch` is excluded so sealing a 500-item cohort
  // rewrites no rows at all; what makes that safe is not that a stale stamp is harmless but that
  // BgDoc.batchIds holds the same membership in a record small enough to rewrite on every seal.
  // `csv` is excluded because it is fixed at import and never touched again — and it is an object,
  // so an identity check would rewrite the whole queue on any upstream `{...item}` rebuild.
  signatureOf: (item) => [
    item.cutout?.blob ?? null,
    regeneratedFile(item),
    item.name,
    // Each of these is written at most once per row — by the verify sweep, the semantic sidecar,
    // or a keypress — strictly after the cutout exists. One re-put per affected row, never a
    // queue-wide rewrite, which is what earns them a place here.
    item.verify ?? null,
    item.semantic ?? null,
    item.manualFlag ?? null,
    item.tileFit ?? null,
  ],

  async recordOf(item: BgItem): Promise<ItemPayload | null> {
    const regenerated = regeneratedFile(item);
    // The drafts rule: a row with neither a cutout nor a paid regenerated source holds nothing that
    // cannot be re-made from its URL or a re-drop, and writing every original would double the
    // batch's footprint in a store four tools now share.
    if (!item.cutout && !regenerated) return null;

    const data: BgItemData = {
      name: item.name,
      origin: originOf(item),
      sourceUrl: item.source.kind === 'url' ? item.source.url : null,
      sourceFileName: regenerated ? regenerated.name : null,
      bounds: item.cutout?.bounds ?? null,
      width: item.cutout?.width ?? 0,
      height: item.cutout?.height ?? 0,
      ...(item.cutout?.residueFraction !== undefined
        ? { residueFraction: item.cutout.residueFraction }
        : null),
      ...(item.csv ? { csv: { row: item.csv.row, column: item.csv.column } } : null),
      // URL only, and never the pre-edit bytes: those are still fetchable, while the regenerated
      // file below is the copy that cost money and exists nowhere else.
      ...(item.originalSource?.kind === 'url'
        ? { originalSourceUrl: item.originalSource.url }
        : null),
      ...(typeof item.batch === 'number' ? { batch: item.batch } : null),
      // The evidence the quality verdict is computed from, written beside the cutout it describes so
      // the two can never disagree. Without it a restored row is re-judged on its bounding box
      // alone — eight of the eleven checks unable to fire, and a row flagged for residue or a
      // surviving prop comes back looking clean.
      ...(item.regionReport?.length ? { regions: item.regionReport } : null),
      ...(item.removedRegions !== undefined ? { removedRegions: item.removedRegions } : null),
      ...(item.originalInk ? { originalInk: item.originalInk } : null),
      ...(item.originalComponents?.length ? { components: item.originalComponents } : null),
      ...(item.verify ? { verify: item.verify } : null),
      ...(item.semantic ? { semantic: item.semantic } : null),
      ...(item.bands?.length ? { bands: item.bands } : null),
      ...(item.manualFlag ? { manualFlag: item.manualFlag } : null),
      ...(item.tileFit !== undefined ? { tileFit: item.tileFit } : null),
    };

    const blobs: Record<string, Blob> = {};
    if (item.cutout) blobs[CUTOUT_BLOB] = item.cutout.blob;
    if (regenerated) blobs[SOURCE_BLOB] = regenerated;
    return { data, blobs };
  },

  itemFrom: (record, id) => itemFromRecord(record, id as number),

  docOf: (doc) => ({
    sessionName: doc.sessionName,
    allocFloor: doc.allocFloor,
    batchIds: doc.batchIds,
    rowCount: doc.rowCount,
  }),

  docFrom: (raw) => parseDoc(raw),

  hasContent: (doc, items) =>
    items.length > 0 || doc.rowCount > 0 || doc.sessionName.trim().length > 0,

  countOf: (doc, items) => (doc.rowCount > 0 ? doc.rowCount : items.length),

  // The first finished cutout. Returned by reference so the header writer's identity check sees an
  // unchanged thumbnail source as unchanged and does not re-encode on every commit.
  thumbSourceOf: (items) => items.find((item) => item.cutout)?.cutout?.blob ?? null,
};

/**
 * Rebuilds a queue row. `id` is passed in rather than taken from the record because the caller may
 * have to re-mint it — see the id-collision note in use-file-store.ts.
 */
export function itemFromRecord(record: ItemRecord, id: number): BgItem {
  const d = (record.data ?? {}) as BgItemData;
  const cutoutBlob = record.blobs?.[CUTOUT_BLOB] ?? null;
  const sourceBlob = record.blobs?.[SOURCE_BLOB] ?? null;

  const source: BgItemSource = d.sourceUrl
    ? { kind: 'url', url: d.sourceUrl }
    : sourceBlob
      ? {
          kind: 'file',
          file: new File([sourceBlob], d.sourceFileName || `${d.name}.png`, {
            type: sourceBlob.type || 'image/png',
          }),
          regenerated: true,
        }
      : { kind: 'archived', label: d.origin ?? d.name ?? '' };

  const cutout: BgCutout | null = cutoutBlob
    ? {
        blob: cutoutBlob,
        bounds: d.bounds ?? null,
        width: d.width ?? 0,
        height: d.height ?? 0,
        ...(d.residueFraction !== undefined ? { residueFraction: d.residueFraction } : null),
      }
    : null;

  return {
    id,
    name: d.name ?? '',
    source,
    original: null,
    cutout,
    // A record with no cutout is an AI-regenerated source that crashed before re-removal: it comes
    // back queued, one "Remove backgrounds" away from where it left off.
    status: cutout ? 'done' : 'ready',
    // Provenance has to come back with the row. One CSV row's images repeat across rows, so without
    // it a later remap has only the URL to go on and every duplicate takes the first row's title.
    ...(d.csv ? { csv: d.csv } : null),
    ...(d.originalSourceUrl
      ? { originalSource: { kind: 'url' as const, url: d.originalSourceUrl } }
      : null),
    ...(d.batch !== undefined ? { batch: d.batch } : null),
    ...(d.regions?.length ? { regionReport: d.regions } : null),
    ...(d.removedRegions !== undefined ? { removedRegions: d.removedRegions } : null),
    ...(d.originalInk ? { originalInk: d.originalInk } : null),
    ...(d.components?.length ? { originalComponents: d.components } : null),
    ...(d.verify ? { verify: d.verify } : null),
    ...(d.semantic ? { semantic: d.semantic } : null),
    ...(d.bands?.length ? { bands: d.bands } : null),
    ...(d.manualFlag ? { manualFlag: d.manualFlag } : null),
    ...(d.tileFit !== undefined ? { tileFit: d.tileFit } : null),
  };
}

/** Field by field, like every other read off disk here: a stored record is still input. */
function parseDoc(raw: unknown): BgDoc {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_DOC };
  const r = raw as Record<string, unknown>;

  const floor = r.allocFloor;
  let allocFloor: BgDoc['allocFloor'] = null;
  if (floor && typeof floor === 'object') {
    const f = floor as Record<string, unknown>;
    if (typeof f.batch === 'number' && Number.isFinite(f.batch) && typeof f.offset === 'number' && Number.isFinite(f.offset)) {
      allocFloor = { batch: Math.round(f.batch), offset: Math.round(f.offset) };
    }
  }

  const batchIds: [number, number[]][] = [];
  if (Array.isArray(r.batchIds)) {
    for (const entry of r.batchIds) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [batch, ids] = entry as [unknown, unknown];
      if (typeof batch !== 'number' || !Number.isFinite(batch)) continue;
      if (!Array.isArray(ids)) continue;
      const clean = ids.filter((id): id is number => typeof id === 'number' && Number.isFinite(id));
      // An entry that parses down to no usable ids is not evidence that anything shipped, and
      // keeping it would under-count the files already written — the number continuous ZIP
      // numbering is derived from.
      if (!clean.length) continue;
      batchIds.push([Math.round(batch), clean.map((id) => Math.round(id))]);
    }
  }

  return {
    sessionName: typeof r.sessionName === 'string' ? r.sessionName : '',
    allocFloor,
    batchIds,
    rowCount: typeof r.rowCount === 'number' && Number.isFinite(r.rowCount) ? Math.max(0, Math.round(r.rowCount)) : 0,
  };
}

export { EMPTY_DOC as EMPTY_BG_DOC };
