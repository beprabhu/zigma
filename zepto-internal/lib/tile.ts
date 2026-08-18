// Tile renderer — data-driven template. Defaults replicate the Figma "SKU tile" frame (75×96).
// Horizontal position = centered + xOffset. Vertical: title hangs from the top (y),
// image and offer are anchored to the frame bottom (bottom = offset of the layer's
// bottom edge relative to the frame bottom; negative = above it).

export interface FrameLayer {
  width: number;
  height: number;
  radius: number;
  bg: string;
}

export interface TitleLayer {
  visible: boolean;
  xOffset: number;
  y: number;
  width: number;
  size: number;
  lineHeight: number;
  weight: number;
  color: string;
  maxLines: number;
  align: 'left' | 'center' | 'right';
}

export interface ImageLayer {
  visible: boolean;
  xOffset: number;
  bottom: number;
  width: number;
  height: number;
  fit: 'cover' | 'contain';
}

export interface OfferLayer {
  visible: boolean;
  xOffset: number;
  bottom: number;
  width: number;
  height: number;
  radius: number;
  pad: number;
  bg: string;
  color: string;
  size: number;
  weight: number;
}

export type ContentLayerName = 'title' | 'image' | 'offer';
export type LayerName = ContentLayerName | 'frame';

export interface TileTemplate {
  frame: FrameLayer;
  layerOrder: ContentLayerName[]; // draw order; last = topmost
  title: TitleLayer;
  image: ImageLayer;
  offer: OfferLayer;
}

export interface TileOpts {
  title: string;
  offerText: string;
  offerVisible: boolean;
  /**
   * What goes in the image box. One element is the finished composite — the export path, and
   * the only shape a generated tile ever uses. An array is the pre-generation preview: the
   * row's several source photos packed into the one box by how many there are. Null slots are
   * photos still loading; their cell is reserved from the start, so nothing shifts as they land.
   */
  image: HTMLImageElement | (HTMLImageElement | null)[] | null;
  /** Sources past the four the box can hold, drawn as a "+N" chip. Preview only. */
  extraImages?: number;
}

export const DEFAULT_TEMPLATE: TileTemplate = {
  frame: { width: 75, height: 96, radius: 12, bg: '#ffffff' },
  layerOrder: ['image', 'title', 'offer'],
  title: {
    visible: true, xOffset: 0, y: 8, width: 59,
    size: 11, lineHeight: 12, weight: 600, color: '#424957', maxLines: 2, align: 'center',
  },
  image: { visible: true, xOffset: 0, bottom: -12, width: 75, height: 75, fit: 'cover' },
  offer: {
    visible: true, xOffset: 0, bottom: 0, width: 104, height: 20, radius: 0, pad: 4,
    bg: '#ef4372', color: '#ffffff', size: 10, weight: 700,
  },
};

// Brand face for tile text; system stack as fallback while it loads.
const FONT_STACK = '"Zepto Norms", -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

// Resolves when Zepto Norms is usable on canvas. Callers re-render after this
// so tiles never ship with the fallback face baked in.
export function tileFontsReady(): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return Promise.resolve();
  const weights = [400, 500, 600, 700, 800, 900];
  return Promise.all(weights.map((w) => document.fonts.load(`${w} 12px "Zepto Norms"`)))
    .then(() => undefined)
    .catch(() => undefined);
}
/** Output PNG width at 1×, regardless of the tile's frame units. Multiplied by renderTile's scale. */
export const EXPORT_WIDTH = 600;

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export interface LayerRect { x: number; y: number; w: number; h: number }

// Bounding rect of a layer in tile units — shared by the renderer and hit testing.
export function tileLayerRect(tpl: TileTemplate, name: LayerName): LayerRect {
  const W = tpl.frame.width, H = tpl.frame.height;
  if (name === 'frame') return { x: 0, y: 0, w: W, h: H };
  if (name === 'title') {
    const t = tpl.title;
    return { x: (W - t.width) / 2 + t.xOffset, y: t.y, w: t.width, h: t.lineHeight * t.maxLines };
  }
  const l = tpl[name];
  const x = (W - l.width) / 2 + l.xOffset;
  return { x, y: H + l.bottom - l.height, w: l.width, h: l.height };
}

// Topmost visible layer at a point (tile units); frame is the fallback.
export function hitTestTile(tpl: TileTemplate, x: number, y: number): LayerName {
  for (let i = tpl.layerOrder.length - 1; i >= 0; i--) {
    const name = tpl.layerOrder[i];
    if (!tpl[name].visible) continue;
    const r = tileLayerRect(tpl, name);
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return name;
  }
  return 'frame';
}

// Wrap text into at most maxLines, ellipsizing the last line.
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width <= maxWidth || !line) {
      line = test;
    } else {
      lines.push(line);
      line = w;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length > maxLines) lines.length = maxLines;
  const joined = lines.join(' ');
  if (joined.replace(/\s+/g, ' ') !== String(text).trim().replace(/\s+/g, ' ')) {
    let last = lines[lines.length - 1] || '';
    while (last && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
    lines[lines.length - 1] = last + '…';
  }
  return lines;
}

// Draw an image into a rect with cover/contain fit.
function drawImageFit(
  ctx: CanvasRenderingContext2D, img: HTMLImageElement,
  x: number, y: number, w: number, h: number, fit: 'cover' | 'contain',
) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const scale = fit === 'contain' ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih);
  const dw = iw * scale, dh = ih * scale;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
}

/**
 * Where several sources sit inside the one image box, as fractions of it — index = cells - 1.
 * Four is the ceiling: past that each photo is too small to tell a product from a prop, so the
 * last cell counts the remainder rather than the pack thinning into slivers. The count goes in
 * a cell, not a corner chip, because the corners of this box belong to the title and offer
 * layers — whichever way the template stacks them.
 */
const IMAGE_PACKS: [number, number, number, number][][] = [
  [[0, 0, 1, 1]],
  [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]],
  [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0.25, 0.5, 0.5, 0.5]],
  [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]],
];

/** The empty state of the image box — also what a preview shows until its first photo lands. */
function drawImagePlaceholder(ctx: CanvasRenderingContext2D, r: LayerRect) {
  ctx.fillStyle = '#f2f3f6';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = '#c3c8d2';
  ctx.font = `500 6px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('image', r.x + r.w / 2, r.y + r.h / 2);
}

/** The last cell of an overflowing pack: "+3" standing for the sources there was no room for. */
function drawCountCell(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, n: number,
) {
  ctx.fillStyle = '#eceef3';
  roundedRectPath(ctx, x, y, w, h, Math.min(w, h) * 0.08);
  ctx.fill();
  ctx.fillStyle = '#7c8598';
  ctx.font = `700 ${Math.min(w, h) * 0.28}px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`+${n}`, x + w / 2, y + h / 2);
}

/**
 * How far a wrapped title pushes the image down.
 *
 * The image is positioned to sit directly under a one-line title. A second line grows the title
 * block downwards by exactly one lineHeight, and without this the image would simply be drawn
 * over it. So the image follows the text instead: one line, no push; two lines, one lineHeight.
 *
 * It is measured at draw time rather than stored, because it is a property of the ROW, not of
 * the template — two products in the same sheet wrap differently, and each tile has to answer
 * for its own title.
 */
function titlePush(ctx: CanvasRenderingContext2D, tpl: TileTemplate, opts: TileOpts): number {
  const t = tpl.title;
  if (!t.visible) return 0;
  ctx.save();
  ctx.font = `${t.weight} ${t.size}px ${FONT_STACK}`;
  const lines = wrapText(ctx, opts.title || '', t.width, t.maxLines).length;
  ctx.restore();
  return Math.max(0, lines - 1) * t.lineHeight;
}

function drawImageLayer(
  ctx: CanvasRenderingContext2D, tpl: TileTemplate, opts: TileOpts, push = 0,
) {
  const base = tileLayerRect(tpl, 'image');
  const r = { ...base, y: base.y + push };
  const list = Array.isArray(opts.image) ? opts.image : opts.image ? [opts.image] : [];
  const extra = opts.extraImages ?? 0;
  const cells = Math.min(list.length + (extra > 0 ? 1 : 0), IMAGE_PACKS.length);
  if (!list.some(Boolean)) {
    drawImagePlaceholder(ctx, r);
    return;
  }
  // One source is the layer as designed — the template's own cover/contain fit, untouched.
  // This is the only shape a generated tile ever takes, so its rendering is never packed.
  if (cells === 1) {
    drawImageFit(ctx, list[0]!, r.x, r.y, r.w, r.h, tpl.image.fit);
    return;
  }
  const pack = IMAGE_PACKS[cells - 1];
  const gap = Math.min(r.w, r.h) * 0.02;
  pack.forEach(([fx, fy, fw, fh], i) => {
    const x = r.x + fx * r.w + gap;
    const y = r.y + fy * r.h + gap;
    const w = fw * r.w - gap * 2;
    const h = fh * r.h - gap * 2;
    if (extra > 0 && i === cells - 1) {
      drawCountCell(ctx, x, y, w, h, extra);
      return;
    }
    const img = list[i];
    if (!img) return;
    // Contain, whatever the layer's fit says: photos cropped to fill a quarter each would lose
    // the very edges that say which product it is. Cover is for the one composite that ships.
    drawImageFit(ctx, img, x, y, w, h, 'contain');
  });
}

function drawTitleLayer(ctx: CanvasRenderingContext2D, tpl: TileTemplate, opts: TileOpts) {
  const t = tpl.title;
  const r = tileLayerRect(tpl, 'title');
  ctx.fillStyle = t.color;
  ctx.font = `${t.weight} ${t.size}px ${FONT_STACK}`;
  ctx.textBaseline = 'alphabetic';
  const lines = wrapText(ctx, opts.title || '', t.width, t.maxLines);
  const tx = t.align === 'left' ? r.x : t.align === 'right' ? r.x + r.w : r.x + r.w / 2;
  ctx.textAlign = t.align;
  lines.forEach((line, i) => {
    ctx.fillText(line, tx, t.y + t.size * 0.8 + i * t.lineHeight);
  });
}

function drawOfferLayer(ctx: CanvasRenderingContext2D, tpl: TileTemplate, opts: TileOpts) {
  if (!(opts.offerText || '').trim()) return;
  const o = tpl.offer;
  const r = tileLayerRect(tpl, 'offer');
  ctx.fillStyle = o.bg;
  roundedRectPath(ctx, r.x, r.y, r.w, r.h, o.radius);
  ctx.fill();
  ctx.fillStyle = o.color;
  ctx.font = `${o.weight} ${o.size}px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // single line, ellipsized to visible width minus padding (bar may be wider than the tile)
  let text = String(opts.offerText);
  const maxW = Math.min(r.w, tpl.frame.width) - o.pad * 2;
  while (text && ctx.measureText(text).width > maxW) text = text.slice(0, -1);
  if (text !== String(opts.offerText)) text = text.slice(0, -1) + '…';
  ctx.fillText(text, r.x + r.w / 2, r.y + r.h / 2 + 0.5);
}

/**
 * @param scale Export multiplier, Figma-style: 1× is EXPORT_WIDTH across, 3× is three times
 * that. Frame units stay the same — only the pixels the tile is rasterised into change — so a
 * template tuned at 1× needs no adjustment to ship at 3×.
 */
export function renderTile(
  canvas: HTMLCanvasElement, opts: TileOpts, tpl: TileTemplate = DEFAULT_TEMPLATE, scale = 1,
) {
  const W = tpl.frame.width, H = tpl.frame.height;
  const S = (EXPORT_WIDTH * scale) / W;
  canvas.width = Math.round(W * S);
  canvas.height = Math.round(H * S);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.save();
  ctx.scale(S, S);

  // Frame: bg, rounded, clips all layers
  roundedRectPath(ctx, 0, 0, W, H, tpl.frame.radius);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = tpl.frame.bg;
  ctx.fillRect(0, 0, W, H);

  // Measured before anything is drawn: the image's position depends on how the title wrapped,
  // and the layer order does not guarantee the title is measured first.
  const push = titlePush(ctx, tpl, opts);

  for (const name of tpl.layerOrder) {
    if (!tpl[name].visible) continue;
    if (name === 'image') drawImageLayer(ctx, tpl, opts, push);
    else if (name === 'title') drawTitleLayer(ctx, tpl, opts);
    else if (name === 'offer' && opts.offerVisible) drawOfferLayer(ctx, tpl, opts);
  }

  ctx.restore(); // clip
  ctx.restore(); // scale
}

// Draw a dashed selection outline on top of a rendered tile (preview only, never exported).
export function drawSelectionOutline(canvas: HTMLCanvasElement, tpl: TileTemplate, layer: LayerName) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const S = canvas.width / tpl.frame.width;
  const r = tileLayerRect(tpl, layer);
  ctx.save();
  ctx.strokeStyle = '#ef4372';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(r.x * S, r.y * S, r.w * S, r.h * S);
  ctx.restore();
}

export function tileToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'));
}
