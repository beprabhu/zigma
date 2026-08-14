// Save/load for BG Remover working files (.zesku) — so a finished batch can be reopened later
// and go straight to tile fitting without re-running inference.
//
// A project is a STORE-method ZIP (our own writer/reader in lib/zip.ts):
//   manifest.json       version, safe-area config, per-item metadata (name, bounds, provenance)
//   cutouts/NNN.webp    the lossless WebP masters, byte-identical to what the workers produced
//   originals/NNN.*     (v2, optional) the input files, so a reopened project keeps its inputs
//   source.csv          (v2, optional) the sheet the queue was imported from, verbatim
//
// The cutouts are ordinary images on purpose: rename .zesku to .zip and the file opens anywhere.
//
// v1 saved only finished cutouts and dropped every input (restored sources were 'archived'
// labels) — which read as data loss on reopen: no originals to view, no Redo, no AI edit, and
// unprocessed queue rows simply gone. v2 saves EVERY item; URL sources cost only their string,
// file sources embed their bytes under originals/ (skippable via includeOriginals for huge
// batches). v1 files still load exactly as before.

import { buildZipStream, readZipIndex, type ZipStreamEntry } from '../zip';
import type { BgCutout, BgItem, BgItemSource, BgVerify, CsvOrigin } from './batch';
import type { InkFootprint, OriginalComponentReport, RegionReport } from './regions';
import { ANCHORS, DEFAULT_SAFE_AREA, type SafeAreaConfig, type SubjectBounds } from './safe-area';

export const PROJECT_EXTENSION = '.zesku';
const MANIFEST = 'manifest.json';
const CSV_ENTRY = 'source.csv';
const FORMAT = 'zesku-bg-remover-project';
// Stays 2 while the format only GAINS keys. loadProject — here and in every build already on a
// colleague's machine — hard-rejects a version it does not recognise, so a bump makes today's
// files unopenable there, whereas an unknown key is skipped without a word. The CSV entry, the
// per-item csv/originalSourceUrl/batch fields and anything else additive therefore ride under
// v2; only a change that makes an old file misread earns the next number.
const VERSION = 2;

export function isProjectFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(PROJECT_EXTENSION);
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04", every non-empty zip starts with it

/**
 * Extension check plus a content fallback: save dialogs can strip the suffix (a 3.3 GB
 * extensionless "Continue" was a real case), and the format doc explicitly blesses renaming
 * to .zip. A file qualifies when it is named .zesku, OR when its name claims nothing else
 * (no extension, or .zip) and its first bytes are the zip magic. Images and CSVs keep their
 * own routes — they never reach the byte sniff. A non-project zip that slips through fails
 * in loadProject with a readable "no manifest.json" error, which is the right message anyway.
 */
export async function sniffProjectFile(file: File): Promise<boolean> {
  if (isProjectFile(file)) return true;
  const name = file.name.toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  if (ext && ext !== 'zip') return false;
  if (file.size < 22) return false; // smaller than even an empty zip
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    return ZIP_MAGIC.every((byte, i) => head[i] === byte);
  } catch {
    return false;
  }
}

interface ManifestItem {
  name: string;
  /** Cutout entry path. v2: '' for items saved before they were processed. */
  path: string;
  /** Cutout dimensions; 0×0 when there is no cutout (v2 unprocessed items). */
  width: number;
  height: number;
  bounds: SubjectBounds | null;
  /** Where the image originally came from — display fallback when nothing richer survives. */
  origin: string;
  /** v2: restores a real URL source (view original, Redo and AI edit keep working). */
  sourceUrl?: string;
  /** v2: zip path of the embedded input file, when the save included originals. */
  originalPath?: string;
  /** v2: the input's original filename, so the reconstructed File keeps it. */
  originalName?: string;
  /** v2: per-item tile-fit override (absent = follows the global switch). */
  tileFit?: boolean;
  /**
   * v2: the embedded original is an AI edit's output, not a dropped input. Autosave decides
   * which file sources are worth persisting from this flag (lib/bg/autosave.ts recordOf), so
   * losing it on a reopen quietly drops paid Azure bytes out of crash recovery.
   */
  regenerated?: boolean;
  /**
   * v2: the CSV cell this row was read out of. A reopened project without it cannot answer
   * "which row are you?", and the whole remap UI depends on that answer — renaming reaches no
   * row, and a re-pick of the image columns mints duplicates for rows already in the queue.
   */
  csv?: { row: number; column: string };
  /**
   * v2: where the row came from before an AI edit replaced its source. URL only and reference
   * only — the pre-edit bytes are deliberately not embedded a second time, since doubling the
   * archive to keep a copy of something still sitting on the CDN is a bad trade.
   */
  originalSourceUrl?: string;
  /** v2: batch grouping, so a reopened project keeps the grouping it was saved with. */
  batch?: number;
  /**
   * The evidence behind the row's quality verdict. Eight of the eleven checks read the region
   * analysis, the removal count or the residue measurement, and all three are produced only by
   * an actual inference run — so a project saved without them reopened with those checks unable
   * to fire, and every row whose only complaint was residue or a surviving prop came back
   * indistinguishable from a clean one. On a 14,105-image project that silently moved 2,716
   * images from flagged to clean.
   */
  regions?: RegionReport[];
  removedRegions?: number;
  residueFraction?: number;
  /** The original's pre-matte footprint — what the coverage-collapse check reads. */
  originalInk?: InkFootprint;
  /** v2-additive: per-element survival of the original's ink against the pre-filter matte. */
  components?: OriginalComponentReport[];
  /** v2-additive: the second-model cross-check verdict, when the verify sweep ran one. */
  verify?: BgVerify;
}

/** Where the CSV text lives and how its columns were mapped; the text itself is a zip entry. */
interface ManifestCsv {
  fileName: string;
  nameColumn: string;
  imageColumns: string[];
  /** v2-additive: columns sent with the AI-edit prompt. Absent on files saved before it. */
  promptColumns?: string[];
  path: string;
}

interface Manifest {
  format: string;
  version: number;
  /**
   * Marks a file whose items carry their quality evidence. Absent on everything written before
   * that was saved, and the distinction has to be explicit: "this row had no regions" and "this
   * file never stored any" produce identical item records, and only the second means the verdict
   * cannot be trusted.
   */
  qualitySignals?: true;
  savedAt: string;
  safeArea: SafeAreaConfig;
  outputBg: string;
  csv?: ManifestCsv;
  items: ManifestItem[];
}

/** The sheet a queue was imported from, with the column choices that shaped it. */
export interface ProjectCsv {
  fileName: string;
  /** Raw CSV text, exactly as it was read — headers are re-derived by re-parsing it. */
  text: string;
  /** Column that names each image; '' means names come from the URL's filename. */
  nameColumn: string;
  imageColumns: string[];
  /**
   * Columns whose cells ride along with the AI-edit prompt. Optional: sheets saved before this
   * existed reopen sending nothing extra, which is exactly what they were sent with.
   */
  promptColumns?: string[];
}

/**
 * Region measurements, trimmed for the manifest. The ratios come out of the analysis as full
 * doubles, and 0.8912345678901234 costs four times what 0.891 does across five regions on
 * fourteen thousand rows — while every threshold that reads them is coarse enough that the
 * digits being dropped could never change a verdict.
 */
/**
 * Rebuilds region records field by field, like every other manifest read here. A region drives
 * arithmetic the verdict depends on, and a wrong-typed area or a missing flag would either throw
 * or — worse — read as "nothing to complain about" and quietly clear a flag.
 */
function parseRegions(raw: unknown[]): RegionReport[] {
  const out: RegionReport[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Partial<RegionReport>;
    const bounds = parseBounds(r.bounds ?? null);
    if (!bounds) continue;
    out.push({
      bounds,
      area: num(r.area, 0),
      flatness: num(r.flatness, 0),
      paletteCoverage: num(r.paletteCoverage, 0),
      distinctColors: Math.round(num(r.distinctColors, 0)),
      fillRatio: num(r.fillRatio, 0),
      touchesEdge: r.touchesEdge === true,
      dominantBin: Math.round(num(r.dominantBin, -1)),
      removed: r.removed === true,
      ...(r.flagged === true ? { flagged: true } : null),
      ...(r.guarded === true ? { guarded: true } : null),
    });
  }
  return out;
}

function packRegions(regions: RegionReport[]): RegionReport[] {
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return regions.map((region) => ({
    ...region,
    flatness: r3(region.flatness),
    paletteCoverage: r3(region.paletteCoverage),
    fillRatio: r3(region.fillRatio),
  }));
}

/**
 * Trimmed for the manifest. No rounding happens here: measureComponentSurvival already
 * quantises every ratio at the source, precisely so the numbers a verdict is computed from
 * cannot change across a save. Rounding again here would reintroduce the drift that removes.
 */
function packComponents(components: OriginalComponentReport[]): OriginalComponentReport[] {
  return components.map((c) => ({
    bounds: c.bounds,
    areaFraction: c.areaFraction,
    survival: c.survival,
    edgeContact: c.edgeContact,
    chroma: c.chroma,
    flatness: c.flatness,
    gradSamples: c.gradSamples,
    lostChroma: c.lostChroma,
    lostBelow: c.lostBelow,
    lostFlatness: c.lostFlatness,
    lostGradSamples: c.lostGradSamples,
  }));
}

/** Field-by-field, like parseRegions — a wrong-typed survival would clear a verdict silently. */
function parseComponents(raw: unknown[]): OriginalComponentReport[] {
  const out: OriginalComponentReport[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const c = entry as Partial<OriginalComponentReport>;
    const bounds = parseBounds(c.bounds ?? null);
    if (!bounds) continue;
    const survival = num(c.survival, NaN);
    const areaFraction = num(c.areaFraction, NaN);
    if (!Number.isFinite(survival) || !Number.isFinite(areaFraction)) continue;
    out.push({
      bounds,
      areaFraction,
      survival,
      edgeContact: Math.round(num(c.edgeContact, 0)),
      chroma: num(c.chroma, 0),
      flatness: num(c.flatness, 0),
      // Absent on files written before texture sampling was recorded. 0 is the honest
      // default: it reads as "smoothness was never measured", which is what those files
      // mean, and the shadow gate refuses to suppress on unmeasured texture.
      gradSamples: Math.round(num(c.gradSamples, 0)),
      lostChroma: num(c.lostChroma, 0),
      lostBelow: num(c.lostBelow, 0),
      lostFlatness: num(c.lostFlatness, 0),
      // Absent on files written before the removed background's texture was recorded. 0 reads
      // as "never measured", and the variation gate refuses to act on unmeasured texture.
      lostGradSamples: Math.round(num(c.lostGradSamples, 0)),
    });
  }
  return out;
}

/**
 * All four fields or nothing: a verify verdict with a defaulted value would be an invented
 * one. `agree` is validated like the rest rather than coerced with `=== true` — coercing it
 * turns a truncated record into a permanent "the two models disagree" flag sitting next to a
 * printed 95% overlap, and because a stored verdict closes needsVerify, nothing would ever
 * re-check it. Rejecting instead leaves verify absent, which reopens the door.
 */
function parseVerify(raw: unknown): BgVerify | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Partial<BgVerify>;
  const iou = num(v.iou, NaN);
  const disputedFraction = num(v.disputedFraction, NaN);
  if (
    typeof v.model !== 'string' ||
    typeof v.agree !== 'boolean' ||
    !Number.isFinite(iou) ||
    !Number.isFinite(disputedFraction)
  ) {
    return null;
  }
  return { model: v.model, iou, disputedFraction, agree: v.agree };
}

function originOf(source: BgItemSource): string {
  if (source.kind === 'file') return source.file.name;
  if (source.kind === 'url') return source.url;
  return source.label;
}

/** Keeps the reconstructed File's type honest without trusting the manifest. */
function mimeFromName(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return (
    { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', gif: 'image/gif' }[ext]
    ?? 'application/octet-stream'
  );
}

export interface SkippedEntry {
  name: string;
  lost: 'cutout' | 'original';
  origin: string;
  reason: string;
}

/** Packs EVERY item (finished or not) plus the current settings into a project blob. */
export async function saveProject(
  items: BgItem[],
  safeArea: SafeAreaConfig,
  outputBg: string,
  opts: {
    includeOriginals?: boolean;
    /** Fired (once, before packing) when unreadable blobs were dropped from the save — the
        call site must warn while the live queue still holds the recoverable rows; a silent
        skip behind a success toast reads as "everything saved" right when it is not. */
    onSkip?: (skipped: SkippedEntry[]) => void;
    /** The CSV behind the queue. Omitted for file/paste batches, which have no sheet. */
    csv?: ProjectCsv;
  } = {},
): Promise<Blob> {
  const includeOriginals = opts.includeOriginals ?? true;
  const entries: ZipStreamEntry[] = [];
  const manifestItems: ManifestItem[] = [];
  // A blob backed by a file that changed on disk after it was dropped throws NotReadableError
  // on first touch — and one dead reference must not sink a save carrying hours of batch work.
  // Each blob is probed with a one-byte read; unreadable halves are dropped from the item (a
  // v2 manifest row with path '' is a legitimate unprocessed item) and reported in
  // skipped.json inside the archive. The full bytes are never materialized here: entries go
  // into buildZipStream as Blob references, so a queue-scale save cannot exhaust the tab.
  const skipped: SkippedEntry[] = [];
  const readable = async (blob: Blob) => {
    try {
      await blob.slice(0, 1).arrayBuffer();
      return true;
    } catch {
      return false;
    }
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const n = String(i + 1).padStart(3, '0');

    let path = '';
    let saved: BgCutout | null = null;
    if (item.cutout) {
      if (await readable(item.cutout.blob)) {
        path = `cutouts/${n}.webp`;
        saved = item.cutout;
        entries.push({ name: path, data: item.cutout.blob });
      } else {
        skipped.push({ name: item.name, lost: 'cutout', origin: originOf(item.source), reason: 'unreadable blob' });
        console.warn(`save: skipping unreadable cutout for "${item.name}"`);
      }
    }

    let originalPath: string | undefined;
    let originalName: string | undefined;
    if (includeOriginals && item.source.kind === 'file') {
      const file = item.source.file;
      if (await readable(file)) {
        const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '.png';
        originalPath = `originals/${n}${ext.toLowerCase()}`;
        originalName = file.name;
        entries.push({ name: originalPath, data: file });
      } else {
        skipped.push({ name: item.name, lost: 'original', origin: originOf(item.source), reason: 'unreadable blob' });
        console.warn(`save: skipping unreadable original for "${item.name}"`);
      }
    }

    manifestItems.push({
      name: item.name,
      path,
      width: saved?.width ?? 0,
      height: saved?.height ?? 0,
      bounds: saved?.bounds ?? null,
      origin: originOf(item.source),
      ...(item.source.kind === 'url' ? { sourceUrl: item.source.url } : null),
      ...(originalPath ? { originalPath, originalName } : null),
      // Only meaningful next to the bytes it describes: with originals off (or an unreadable
      // blob skipped above) the source restores as 'archived', and a marker on a row the
      // loader can never rebuild into a file source would just be a lie in the manifest.
      ...(originalPath && item.source.kind === 'file' && item.source.regenerated
        ? { regenerated: true }
        : null),
      ...(item.tileFit !== undefined ? { tileFit: item.tileFit } : null),
      // Saved for every item that has them, independent of the cutout's own readability probe:
      // the verdict has to survive the round trip or a reopened project quietly downgrades its
      // own flagged rows to clean.
      ...(item.regionReport?.length ? { regions: packRegions(item.regionReport) } : null),
      ...(item.removedRegions !== undefined ? { removedRegions: item.removedRegions } : null),
      ...(saved?.residueFraction !== undefined
        ? { residueFraction: Math.round(saved.residueFraction * 1e5) / 1e5 }
        : null),
      ...(item.originalInk
        ? {
            originalInk: {
              bbox: Math.round(item.originalInk.bbox * 1000) / 1000,
              ink: Math.round(item.originalInk.ink * 1000) / 1000,
            },
          }
        : null),
      ...(item.originalComponents?.length
        ? { components: packComponents(item.originalComponents) }
        : null),
      ...(item.verify
        ? {
            verify: {
              model: item.verify.model,
              iou: Math.round(item.verify.iou * 1000) / 1000,
              disputedFraction: Math.round(item.verify.disputedFraction * 1000) / 1000,
              agree: item.verify.agree,
            },
          }
        : null),
      ...(item.csv ? { csv: { row: item.csv.row, column: item.csv.column } } : null),
      // Only a URL survives the round trip: an original that was a dropped FILE is already
      // embedded under originals/ when the save includes them, and re-embedding it a second
      // time to record "this is what it used to be" would double the archive for nothing.
      ...(item.originalSource?.kind === 'url'
        ? { originalSourceUrl: item.originalSource.url }
        : null),
      ...(typeof item.batch === 'number' ? { batch: item.batch } : null),
    });
  }

  if (skipped.length) {
    entries.push({ name: 'skipped.json', data: new TextEncoder().encode(JSON.stringify(skipped, null, 1)) });
    opts.onSkip?.(skipped);
  }

  // The sheet is its own entry rather than a manifest field: a 3,000-row export runs to
  // megabytes of text, and manifest.json is JSON.parsed in full before the first cutout can be
  // listed — burying the CSV in it would tax every open, including opens that never touch the
  // column mapping. Saved verbatim so the remap re-parses the same bytes the import did; a
  // re-serialized sheet would drift on quoting and take the row numbering with it.
  const csv = opts.csv;
  let manifestCsv: ManifestCsv | undefined;
  if (csv && csv.text) {
    entries.push({ name: CSV_ENTRY, data: new TextEncoder().encode(csv.text) });
    manifestCsv = {
      fileName: csv.fileName,
      nameColumn: csv.nameColumn,
      imageColumns: [...csv.imageColumns],
      ...(csv.promptColumns?.length ? { promptColumns: [...csv.promptColumns] } : null),
      path: CSV_ENTRY,
    };
  }

  const manifest: Manifest = {
    format: FORMAT,
    version: VERSION,
    qualitySignals: true,
    savedAt: new Date().toISOString(),
    safeArea,
    outputBg,
    ...(manifestCsv ? { csv: manifestCsv } : null),
    items: manifestItems,
  };
  // Manifest first, so even a truncated file fails with a readable error about the right entry.
  entries.unshift({ name: MANIFEST, data: new TextEncoder().encode(JSON.stringify(manifest, null, 1)) });
  return buildZipStream(entries);
}

export interface RestoredItem {
  name: string;
  source: BgItemSource;
  /** null for v2 items that were saved before they were processed. */
  cutout: BgCutout | null;
  /** Per-item tile-fit override, round-tripped from the manifest. */
  tileFit?: boolean;
  /** Which CSV cell the row came from; absent for file/paste rows and for v1 files. */
  csv?: CsvOrigin;
  /** Pre-AI-edit provenance, URL only — the caller rebuilds a {kind:'url'} source from it. */
  originalSourceUrl?: string;
  batch?: number;
  regions?: RegionReport[];
  removedRegions?: number;
  originalInk?: InkFootprint;
  components?: OriginalComponentReport[];
  verify?: BgVerify;
}

export interface RestoredProject {
  items: RestoredItem[];
  /**
   * False for a file written before quality evidence was saved. Its rows can only be re-judged
   * on their bounding box, so the caller must not present them as verified — see
   * BgItem.qualityUnknown.
   */
  qualitySignals: boolean;
  safeArea: SafeAreaConfig;
  outputBg: string;
  savedAt: string;
  /** Absent when the project was saved without a sheet, or when its entry did not survive. */
  csv?: ProjectCsv;
}

/** Number-shaped guard: manifests come from disk and deserve zero trust. */
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function parseBounds(v: unknown): SubjectBounds | null {
  if (!v || typeof v !== 'object') return null;
  const b = v as Record<string, unknown>;
  if ([b.x, b.y, b.w, b.h].some((n) => typeof n !== 'number' || !Number.isFinite(n))) return null;
  return { x: b.x as number, y: b.y as number, w: b.w as number, h: b.h as number };
}

/** Both halves or nothing: a row number without its column names no cell the remap can find. */
function parseCsvOrigin(v: unknown): CsvOrigin | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  if (typeof c.row !== 'number' || !Number.isFinite(c.row) || c.row < 0) return null;
  if (typeof c.column !== 'string' || !c.column) return null;
  return { row: Math.round(c.row), column: c.column };
}

/** Rebuilds queue-ready items (cutout blob + regenerated preview + bounds) from a project file. */
export async function loadProject(file: File): Promise<RestoredProject> {
  // Indexed, not read: a 3,000-image project is multiple GB, and reading one into a single
  // ArrayBuffer fails outright (browsers cap those near 1-2 GB). Every cutout below is a lazy
  // slice of this file, so opening a project costs almost no memory regardless of its size.
  const entries = await readZipIndex(file);
  const byName = new Map(entries.map((e) => [e.name, e.blob]));

  const manifestBlob = byName.get(MANIFEST);
  if (!manifestBlob) throw new Error(`${file.name} is not a Zigma project (no ${MANIFEST})`);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await manifestBlob.text()) as Manifest;
  } catch {
    throw new Error(`${file.name} has an unreadable manifest`);
  }
  // JSON.parse happily yields null/numbers/strings; property access on those throws, so the
  // shape check has to come before the first field read.
  if (!manifest || typeof manifest !== 'object' || manifest.format !== FORMAT) {
    throw new Error(`${file.name} is not a BG Remover project`);
  }
  if (manifest.version !== 1 && manifest.version !== VERSION) {
    throw new Error(
      `${file.name} was saved by a newer version of Zigma (format v${manifest.version}) — update the app to open it`,
    );
  }
  const v1 = manifest.version === 1;
  if (!Array.isArray(manifest.items)) throw new Error(`${file.name} has no items`);

  const items: RestoredItem[] = [];
  {
    for (const meta of manifest.items) {
      // Item records come from disk too: a null/primitive row or a non-string path must fail
      // with the file's name attached, not as a bare TypeError.
      const rec = (meta && typeof meta === 'object' ? meta : {}) as Partial<ManifestItem>;
      const path = typeof rec.path === 'string' ? rec.path : '';
      const slice = path ? byName.get(path) : undefined;
      // v1 items always carry a cutout; a v2 item saved unprocessed legitimately has none.
      if (!slice && (v1 || path)) {
        throw new Error(`${file.name} is missing ${path || 'a cutout entry'}`);
      }

      let cutout: BgCutout | null = null;
      if (slice) {
        // A typed Blob view over the same lazy slice — still no bytes read.
        const blob = slice.slice(0, slice.size, 'image/webp');
        // Dimensions come from the manifest rather than by decoding: probing every image would
        // mean thousands of decodes and gigabytes of bitmaps just to open a project. Previews
        // are decoded on demand for whatever is on screen (lib/bg/preview-store.ts).
        const width = Math.round(num(rec.width, 0));
        const height = Math.round(num(rec.height, 0));
        if (width <= 0 || height <= 0) {
          throw new Error(`${file.name}: ${path || 'an entry'} has no recorded dimensions`);
        }
        const residue = num(rec.residueFraction, NaN);
        cutout = {
          blob,
          bounds: parseBounds(rec.bounds),
          width,
          height,
          ...(Number.isFinite(residue) && residue >= 0 ? { residueFraction: residue } : null),
        };
      }

      // Source, richest first: embedded original file → URL → archived label (v1, or a file
      // source saved with originals off). File/URL sources restore the full workflow — view
      // original, Redo, AI edit — which is the point of v2.
      let source: BgItemSource = {
        kind: 'archived',
        label: typeof rec.origin === 'string' && rec.origin ? rec.origin : file.name,
      };
      const originalPath = typeof rec.originalPath === 'string' ? rec.originalPath : '';
      const originalSlice = originalPath ? byName.get(originalPath) : undefined;
      if (originalSlice) {
        const fileName =
          typeof rec.originalName === 'string' && rec.originalName
            ? rec.originalName
            : originalPath.slice(originalPath.lastIndexOf('/') + 1);
        // File over the lazy slice — bytes are only read when the input is actually used.
        source = {
          kind: 'file',
          file: new File([originalSlice], fileName, { type: mimeFromName(fileName) }),
          // Carried back so a reopened AI edit keeps autosaving its bytes, and so anything
          // that asks "is this AI output?" still gets the truth after a round trip.
          ...(rec.regenerated === true ? { regenerated: true } : null),
        };
      } else if (typeof rec.sourceUrl === 'string' && /^https?:\/\//i.test(rec.sourceUrl)) {
        source = { kind: 'url', url: rec.sourceUrl };
      }

      if (!cutout && source.kind === 'archived') {
        // Nothing restorable at all (no cutout, no input) — a dead row would only confuse.
        continue;
      }

      const csvOrigin = parseCsvOrigin(rec.csv);
      items.push({
        name: typeof rec.name === 'string' && rec.name ? rec.name : 'restored',
        source,
        cutout,
        ...(typeof rec.tileFit === 'boolean' ? { tileFit: rec.tileFit } : null),
        ...(csvOrigin ? { csv: csvOrigin } : null),
        ...(typeof rec.originalSourceUrl === 'string' && /^https?:\/\//i.test(rec.originalSourceUrl)
          ? { originalSourceUrl: rec.originalSourceUrl }
          : null),
        ...(Number.isFinite(num(rec.batch, NaN)) ? { batch: Math.round(num(rec.batch, 0)) } : null),
        // Trusted only as far as the shapes check out: a hand-edited manifest must not put a
        // wrong-typed region through arithmetic that reads NaN as "no complaint".
        ...(Array.isArray(rec.regions) ? { regions: parseRegions(rec.regions) } : null),
        ...(Number.isFinite(num(rec.removedRegions, NaN))
          ? { removedRegions: Math.round(num(rec.removedRegions, 0)) }
          : null),
        ...(rec.originalInk &&
        typeof rec.originalInk === 'object' &&
        Number.isFinite(num(rec.originalInk.bbox, NaN)) &&
        Number.isFinite(num(rec.originalInk.ink, NaN))
          ? { originalInk: { bbox: num(rec.originalInk.bbox, 0), ink: num(rec.originalInk.ink, 0) } }
          : null),
        ...(Array.isArray(rec.components) ? { components: parseComponents(rec.components) } : null),
        ...(() => {
          const verify = parseVerify(rec.verify);
          return verify ? { verify } : null;
        })(),
      });
    }
  }

  // Settings are rebuilt field by field over the defaults so a hand-edited or partial manifest
  // degrades gracefully. No blind spread: it would carry wrong-typed values (and arbitrary extra
  // keys) into React state and localStorage — SafeAreaControls calls background.trim(), which
  // throws on anything that is not a string.
  const rawSa = manifest.safeArea;
  const sa = (rawSa && typeof rawSa === 'object' && !Array.isArray(rawSa) ? rawSa : {}) as Partial<SafeAreaConfig>;
  const safeArea: SafeAreaConfig = {
    tile: {
      width: num(sa.tile?.width, DEFAULT_SAFE_AREA.tile.width),
      height: num(sa.tile?.height, DEFAULT_SAFE_AREA.tile.height),
    },
    margins: {
      top: num(sa.margins?.top, DEFAULT_SAFE_AREA.margins.top),
      right: num(sa.margins?.right, DEFAULT_SAFE_AREA.margins.right),
      bottom: num(sa.margins?.bottom, DEFAULT_SAFE_AREA.margins.bottom),
      left: num(sa.margins?.left, DEFAULT_SAFE_AREA.margins.left),
    },
    marginUnit:
      sa.marginUnit === 'px' || sa.marginUnit === 'percent' ? sa.marginUnit : DEFAULT_SAFE_AREA.marginUnit,
    anchor:
      typeof sa.anchor === 'string' && (ANCHORS as readonly string[]).includes(sa.anchor)
        ? sa.anchor
        : DEFAULT_SAFE_AREA.anchor,
    fill: num(sa.fill, DEFAULT_SAFE_AREA.fill),
    allowUpscale:
      typeof sa.allowUpscale === 'boolean' ? sa.allowUpscale : DEFAULT_SAFE_AREA.allowUpscale,
    background:
      typeof sa.background === 'string' && sa.background ? sa.background : DEFAULT_SAFE_AREA.background,
  };

  // Rebuilt field by field for the same reason as the settings above, and with the same stakes:
  // these strings land in the column pickers, which call .includes on imageColumns and hand
  // nameColumn to draftsFromCsv as a record key. A hand-edited manifest carrying a number where
  // a header belongs would take out the remap panel on every render.
  //
  // Nothing here may throw: the sheet only powers the remap UI, so a truncated or missing entry
  // must cost that panel alone — refusing to open a project whose cutouts are perfectly intact
  // over a side-car text file would be the worse failure by far.
  let csv: ProjectCsv | undefined;
  const rawCsv = manifest.csv;
  if (rawCsv && typeof rawCsv === 'object' && !Array.isArray(rawCsv)) {
    const c = rawCsv as Partial<ManifestCsv>;
    const csvPath = typeof c.path === 'string' && c.path ? c.path : CSV_ENTRY;
    const csvBlob = byName.get(csvPath);
    if (csvBlob) {
      try {
        const text = await csvBlob.text();
        if (text) {
          csv = {
            fileName:
              typeof c.fileName === 'string' && c.fileName
                ? c.fileName
                : csvPath.slice(csvPath.lastIndexOf('/') + 1),
            text,
            // '' is a legitimate value here — it means "name each image from its URL" — so an
            // absent or wrong-typed column must degrade to that, never to a header guess.
            nameColumn: typeof c.nameColumn === 'string' ? c.nameColumn : '',
            imageColumns: Array.isArray(c.imageColumns)
              ? c.imageColumns.filter((column): column is string => typeof column === 'string' && !!column)
              : [],
            // Absent means "send the prompt alone" — the same thing every pre-promptColumns
            // file was actually sent with, so an old project reopens sending what it always did.
            promptColumns: Array.isArray(c.promptColumns)
              ? c.promptColumns.filter((column): column is string => typeof column === 'string' && !!column)
              : [],
          };
        }
      } catch {
        console.warn(`${file.name}: ${csvPath} is unreadable — column remapping is unavailable`);
      }
    }
  }

  return {
    items,
    qualitySignals: manifest.qualitySignals === true,
    safeArea,
    outputBg:
      typeof manifest.outputBg === 'string' && manifest.outputBg ? manifest.outputBg : 'transparent',
    savedAt: typeof manifest.savedAt === 'string' ? manifest.savedAt : '',
    ...(csv ? { csv } : null),
  };
}
