// Safe-area tile fitting: take an already background-removed (transparent) image, find the
// subject's bbox, and scale/anchor it inside a customisable safe area on a fixed-size tile.
// The alpha>128 bbox scan and the 6% side / 8% top / 4% bottom margin ratios are ported from
// the two-product composer's layout engine; there is no pairing, overlap or z-order here.
//
// Self-contained by design: pure TS + Canvas, no imports, safe to call on every slider tick.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Subject bbox in SOURCE pixel coordinates (w/h rather than width/height to keep it visibly
// distinct from tile-space rects at call sites).
export interface SubjectBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type TileSource = HTMLImageElement | HTMLCanvasElement | ImageBitmap;

export interface TilePreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

// 600x768 is the Figma "SKU tile" frame (75x96, see lib/tile.ts DEFAULT_TEMPLATE) at 8x —
// the size the existing compositor exports at, so cutouts drop straight into it.
export const TILE_PRESETS: TilePreset[] = [
  { id: 'sku-tile', label: 'SKU tile · 600 × 768', width: 600, height: 768 },
  { id: 'square-150', label: 'Square · 150 × 150', width: 150, height: 150 },
  { id: 'square-512', label: 'Square · 512 × 512', width: 512, height: 512 },
  { id: 'square-1024', label: 'Square · 1024 × 1024', width: 1024, height: 1024 },
  { id: 'square-2048', label: 'Square · 2048 × 2048', width: 2048, height: 2048 },
];

export type SafeAreaAnchor =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'middle-left'
  | 'middle-center'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

// Row-major, so a UI can map this straight onto a 3x3 grid of buttons.
export const ANCHORS: readonly SafeAreaAnchor[] = [
  'top-left', 'top-center', 'top-right',
  'middle-left', 'middle-center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right',
];

export const ANCHOR_LABELS: Record<SafeAreaAnchor, string> = {
  'top-left': 'Top left',
  'top-center': 'Top center',
  'top-right': 'Top right',
  'middle-left': 'Middle left',
  'middle-center': 'Middle center',
  'middle-right': 'Middle right',
  'bottom-left': 'Bottom left',
  'bottom-center': 'Bottom center',
  'bottom-right': 'Bottom right',
};

// Fraction of the leftover space that goes before the subject on each axis.
export const ANCHOR_FACTORS: Record<SafeAreaAnchor, { fx: number; fy: number }> = {
  'top-left': { fx: 0, fy: 0 },
  'top-center': { fx: 0.5, fy: 0 },
  'top-right': { fx: 1, fy: 0 },
  'middle-left': { fx: 0, fy: 0.5 },
  'middle-center': { fx: 0.5, fy: 0.5 },
  'middle-right': { fx: 1, fy: 0.5 },
  'bottom-left': { fx: 0, fy: 1 },
  'bottom-center': { fx: 0.5, fy: 1 },
  'bottom-right': { fx: 1, fy: 1 },
};

export interface SafeAreaMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type MarginUnit = 'px' | 'percent';

export interface SafeAreaConfig {
  tile: { width: number; height: number };
  margins: SafeAreaMargins;
  marginUnit: MarginUnit;
  anchor: SafeAreaAnchor;
  // 0..1 fraction of the safe area the subject may occupy — the scale up / scale down control.
  fill: number;
  // false pins the subject at at most 1 source px per tile px, so a small cutout is never
  // blown up past its own resolution.
  allowUpscale: boolean;
  // 'transparent' leaves the tile backdrop clear; anything else is used as a CSS colour.
  background: string;
}

export const TRANSPARENT = 'transparent';

// Margins mirror the composer's ratios (side 6%, top 8%, bottom 4%): products sit on a shelf
// line near the bottom with generous headroom, which is what the bottom-center anchor gives.
export const DEFAULT_SAFE_AREA: SafeAreaConfig = {
  tile: { width: 600, height: 768 },
  margins: { top: 8, right: 6, bottom: 4, left: 6 },
  marginUnit: 'percent',
  anchor: 'bottom-center',
  fill: 1,
  allowUpscale: true,
  background: TRANSPARENT,
};

// Matches the composer's silhouette threshold: anti-aliased cutout fringes below this are not
// treated as subject, so a soft matte edge does not inflate the bbox.
export const ALPHA_THRESHOLD = 128;

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

// Percentages resolve per axis against the tile's own width (left/right) and height
// (top/bottom). Negative margins are honoured: they bleed the safe area past the tile edge.
export function resolveSafeArea(cfg: SafeAreaConfig): Rect {
  const W = Math.max(0, cfg.tile.width);
  const H = Math.max(0, cfg.tile.height);
  // Empty number inputs arrive as NaN; treat those as no margin rather than poisoning the rect.
  const toPx = (v: number, basis: number) =>
    !Number.isFinite(v) ? 0 : cfg.marginUnit === 'percent' ? (v / 100) * basis : v;
  const left = toPx(cfg.margins.left, W);
  const right = toPx(cfg.margins.right, W);
  const top = toPx(cfg.margins.top, H);
  const bottom = toPx(cfg.margins.bottom, H);
  return {
    x: left,
    y: top,
    width: Math.max(0, W - left - right),
    height: Math.max(0, H - top - bottom),
  };
}

export function subjectBounds(pixels: ImageData): SubjectBounds | null {
  const { width: w, height: h, data: d } = pixels;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[4 * (y * w + x) + 3] > ALPHA_THRESHOLD) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function sourceSize(source: TileSource): { width: number; height: number } {
  if ('naturalWidth' in source) {
    return { width: source.naturalWidth || source.width, height: source.naturalHeight || source.height };
  }
  return { width: source.width, height: source.height };
}

// Throws on a canvas tainted by a cross-origin source — images must come through the
// same-origin fetch proxy or be CORS-clean before they reach this module.
export function readPixels(source: TileSource): ImageData {
  const { width, height } = sourceSize(source);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.drawImage(source, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}

// One full-image alpha scan — run this ONCE per cutout and cache the result; every subsequent
// preview render takes the bbox as an argument instead of re-scanning.
export function measureSubject(source: TileSource): SubjectBounds | null {
  return subjectBounds(readPixels(source));
}

export interface SubjectPlacement extends Rect {
  scale: number;
}

// Uniform contain-scale into the safe rect, damped by fill, then anchored. Returns scale 0 and
// a zero-size rect (still anchored, so an overlay has somewhere to sit) when the subject or the
// safe area is degenerate.
export function fitToSafeArea(
  subject: { w: number; h: number },
  safe: Rect,
  cfg: SafeAreaConfig,
): SubjectPlacement {
  const fill = clamp(cfg.fill, 0, 1);
  const sw = Math.max(0, subject.w);
  const sh = Math.max(0, subject.h);
  const fits = sw > 0 && sh > 0 && safe.width > 0 && safe.height > 0;
  let scale = fits ? Math.min(safe.width / sw, safe.height / sh) * fill : 0;
  if (!cfg.allowUpscale) scale = Math.min(scale, 1);
  if (!Number.isFinite(scale) || scale < 0) scale = 0;
  const width = sw * scale;
  const height = sh * scale;
  const { fx, fy } = ANCHOR_FACTORS[cfg.anchor] ?? ANCHOR_FACTORS['bottom-center'];
  return {
    x: safe.x + (safe.width - width) * fx,
    y: safe.y + (safe.height - height) * fy,
    width,
    height,
    scale,
  };
}

export interface TileLayout {
  tile: Rect;
  safe: Rect;
  subject: SubjectPlacement | null;
}

// Everything an overlay needs, in tile pixels: the frame, the safe rect and where the subject
// lands. Cheap and canvas-free, so it can drive React state on every config change.
export function planTile(cfg: SafeAreaConfig, bounds: SubjectBounds | null): TileLayout {
  const tile: Rect = {
    x: 0,
    y: 0,
    width: Math.max(0, cfg.tile.width),
    height: Math.max(0, cfg.tile.height),
  };
  const safe = resolveSafeArea(cfg);
  return { tile, safe, subject: bounds ? fitToSafeArea(bounds, safe, cfg) : null };
}

// Tile pixels -> preview pixels; factor is previewWidth / cfg.tile.width.
/** Maps a subject bbox between resolutions of the same image (full-res <-> preview). */
export function scaleBounds(bounds: SubjectBounds, factor: number): SubjectBounds {
  return {
    x: bounds.x * factor,
    y: bounds.y * factor,
    w: bounds.w * factor,
    h: bounds.h * factor,
  };
}

export function scaleRect(rect: Rect, factor: number): Rect {
  return {
    x: rect.x * factor,
    y: rect.y * factor,
    width: rect.width * factor,
    height: rect.height * factor,
  };
}

export interface RenderTileOptions {
  // Precomputed bbox from measureSubject. Pass it to keep preview renders free of the alpha
  // scan; pass null to declare "already known to be empty"; omit to scan the source here.
  bounds?: SubjectBounds | null;
  // Reused across preview ticks so a slider drag does not allocate a canvas per frame.
  canvas?: HTMLCanvasElement;
}

export function renderTile(
  source: TileSource,
  cfg: SafeAreaConfig,
  opts: RenderTileOptions = {},
): HTMLCanvasElement {
  const canvas = opts.canvas ?? document.createElement('canvas');
  const W = Math.max(1, Math.round(cfg.tile.width));
  const H = Math.max(1, Math.round(cfg.tile.height));
  // Resize only on change; the explicit clear below covers the reused-canvas case.
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.clearRect(0, 0, W, H);
  if (cfg.background !== TRANSPARENT) {
    ctx.fillStyle = cfg.background;
    ctx.fillRect(0, 0, W, H);
  }

  const bounds = opts.bounds !== undefined ? opts.bounds : measureSubject(source);
  if (!bounds || bounds.w <= 0 || bounds.h <= 0) return canvas;

  const dest = fitToSafeArea(bounds, resolveSafeArea(cfg), cfg);
  // drawImage raises IndexSizeError on a zero-width source rect and no-ops on a zero-width
  // destination, so bail before either can happen (fill = 0, or margins that ate the tile).
  if (dest.width <= 0 || dest.height <= 0) return canvas;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, bounds.x, bounds.y, bounds.w, bounds.h, dest.x, dest.y, dest.width, dest.height);
  return canvas;
}
