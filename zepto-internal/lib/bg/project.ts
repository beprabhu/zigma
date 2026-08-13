// Save/load for BG Remover working files (.zesku) — so a finished batch can be reopened later
// and go straight to tile fitting without re-running inference.
//
// A project is a STORE-method ZIP (our own writer/reader in lib/zip.ts):
//   manifest.json       version, safe-area config, per-item metadata (name, bounds, provenance)
//   cutouts/NNN.webp    the lossless WebP masters, byte-identical to what the workers produced
//   originals/NNN.*     (v2, optional) the input files, so a reopened project keeps its inputs
//
// The cutouts are ordinary images on purpose: rename .zesku to .zip and the file opens anywhere.
//
// v1 saved only finished cutouts and dropped every input (restored sources were 'archived'
// labels) — which read as data loss on reopen: no originals to view, no Redo, no AI edit, and
// unprocessed queue rows simply gone. v2 saves EVERY item; URL sources cost only their string,
// file sources embed their bytes under originals/ (skippable via includeOriginals for huge
// batches). v1 files still load exactly as before.

import { buildZip, readZipIndex, type ZipFileEntry } from '../zip';
import type { BgCutout, BgItem, BgItemSource } from './batch';
import { ANCHORS, DEFAULT_SAFE_AREA, type SafeAreaConfig, type SubjectBounds } from './safe-area';

export const PROJECT_EXTENSION = '.zesku';
const MANIFEST = 'manifest.json';
const FORMAT = 'zesku-bg-remover-project';
const VERSION = 2;

export function isProjectFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(PROJECT_EXTENSION);
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
}

interface Manifest {
  format: string;
  version: number;
  savedAt: string;
  safeArea: SafeAreaConfig;
  outputBg: string;
  items: ManifestItem[];
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

/** Packs EVERY item (finished or not) plus the current settings into a project blob. */
export async function saveProject(
  items: BgItem[],
  safeArea: SafeAreaConfig,
  outputBg: string,
  opts: { includeOriginals?: boolean } = {},
): Promise<Blob> {
  const includeOriginals = opts.includeOriginals ?? true;
  const entries: ZipFileEntry[] = [];
  const manifestItems: ManifestItem[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const n = String(i + 1).padStart(3, '0');

    let path = '';
    if (item.cutout) {
      path = `cutouts/${n}.webp`;
      entries.push({ name: path, data: new Uint8Array(await item.cutout.blob.arrayBuffer()) });
    }

    let originalPath: string | undefined;
    let originalName: string | undefined;
    if (includeOriginals && item.source.kind === 'file') {
      const file = item.source.file;
      const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '.png';
      originalPath = `originals/${n}${ext.toLowerCase()}`;
      originalName = file.name;
      entries.push({ name: originalPath, data: new Uint8Array(await file.arrayBuffer()) });
    }

    manifestItems.push({
      name: item.name,
      path,
      width: item.cutout?.width ?? 0,
      height: item.cutout?.height ?? 0,
      bounds: item.cutout?.bounds ?? null,
      origin: originOf(item.source),
      ...(item.source.kind === 'url' ? { sourceUrl: item.source.url } : null),
      ...(originalPath ? { originalPath, originalName } : null),
      ...(item.tileFit !== undefined ? { tileFit: item.tileFit } : null),
    });
  }

  const manifest: Manifest = {
    format: FORMAT,
    version: VERSION,
    savedAt: new Date().toISOString(),
    safeArea,
    outputBg,
    items: manifestItems,
  };
  // Manifest first, so even a truncated file fails with a readable error about the right entry.
  entries.unshift({ name: MANIFEST, data: new TextEncoder().encode(JSON.stringify(manifest, null, 1)) });
  return buildZip(entries);
}

export interface RestoredItem {
  name: string;
  source: BgItemSource;
  /** null for v2 items that were saved before they were processed. */
  cutout: BgCutout | null;
  /** Per-item tile-fit override, round-tripped from the manifest. */
  tileFit?: boolean;
}

export interface RestoredProject {
  items: RestoredItem[];
  safeArea: SafeAreaConfig;
  outputBg: string;
  savedAt: string;
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
        cutout = { blob, bounds: parseBounds(rec.bounds), width, height };
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
        source = { kind: 'file', file: new File([originalSlice], fileName, { type: mimeFromName(fileName) }) };
      } else if (typeof rec.sourceUrl === 'string' && /^https?:\/\//i.test(rec.sourceUrl)) {
        source = { kind: 'url', url: rec.sourceUrl };
      }

      if (!cutout && source.kind === 'archived') {
        // Nothing restorable at all (no cutout, no input) — a dead row would only confuse.
        continue;
      }

      items.push({
        name: typeof rec.name === 'string' && rec.name ? rec.name : 'restored',
        source,
        cutout,
        ...(typeof rec.tileFit === 'boolean' ? { tileFit: rec.tileFit } : null),
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

  return {
    items,
    safeArea,
    outputBg:
      typeof manifest.outputBg === 'string' && manifest.outputBg ? manifest.outputBg : 'transparent',
    savedAt: typeof manifest.savedAt === 'string' ? manifest.savedAt : '',
  };
}
