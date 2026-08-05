// File-size budget for PNG exports.
//
// PNG is lossless, so size follows image complexity and identical dimensions never mean
// identical bytes. Hitting a CDN budget therefore means removing information, in this order of
// increasing damage: full colour -> fewer palette colours -> fewer pixels. The ladder below
// stops at the first rung that fits, so a generous budget costs one encode and loses nothing.

import { encodePng8, isPng8Supported } from './png8';

export interface BudgetOptions {
  /** Ceiling per file, in bytes. */
  maxBytes: number;
  /** Allow shrinking dimensions when no palette size fits. */
  allowDownscale: boolean;
  /** Never scale the long edge below this many pixels. */
  minEdge?: number;
  dither?: boolean;
}

export interface BudgetResult {
  bytes: Uint8Array;
  /** null when the original truecolor PNG already fit. */
  colors: number | null;
  /** 1 when dimensions were untouched. */
  scale: number;
  width: number;
  height: number;
  withinBudget: boolean;
}

// Each rung is a palette size. 256 already lands a worst-case 512px tile near 57 KB, so the
// lower rungs exist for tight budgets rather than everyday use.
const PALETTE_LADDER = [256, 128, 64, 32];
const SCALE_STEP = 0.85;
const DEFAULT_MIN_EDGE = 256;

function canvasPixels(canvas: HTMLCanvasElement): ImageData {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function scaleCanvas(source: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(source.width * scale));
  out.height = Math.max(1, Math.round(source.height * scale));
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, out.width, out.height);
  return out;
}

function truecolorPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('PNG encoding failed'));
        return;
      }
      blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
    }, 'image/png');
  });
}

/**
 * Encodes `canvas` as the highest-quality PNG that fits `maxBytes`.
 *
 * Returns the smallest result it managed even when nothing fits, with withinBudget=false — an
 * over-budget file is still more useful to the caller than an exception, and the UI reports it.
 */
export async function fitToBudget(
  canvas: HTMLCanvasElement,
  opts: BudgetOptions,
): Promise<BudgetResult> {
  const minEdge = opts.minEdge ?? DEFAULT_MIN_EDGE;
  const dither = opts.dither === true;

  // Rung 0: what we ship today. Often already under a generous budget, and loses nothing.
  const original = await truecolorPng(canvas);
  const base: BudgetResult = {
    bytes: original,
    colors: null,
    scale: 1,
    width: canvas.width,
    height: canvas.height,
    withinBudget: original.length <= opts.maxBytes,
  };
  if (base.withinBudget || !isPng8Supported()) return base;

  let best = base;
  let working = canvas;
  let scale = 1;

  for (;;) {
    const pixels = canvasPixels(working);
    for (const colors of PALETTE_LADDER) {
      const bytes = await encodePng8(pixels, { colors, dither });
      // Track the smallest attempt regardless, so a miss still returns the best effort.
      if (bytes.length < best.bytes.length) {
        best = {
          bytes,
          colors,
          scale,
          width: working.width,
          height: working.height,
          withinBudget: bytes.length <= opts.maxBytes,
        };
      }
      if (bytes.length <= opts.maxBytes) {
        return {
          bytes,
          colors,
          scale,
          width: working.width,
          height: working.height,
          withinBudget: true,
        };
      }
    }

    if (!opts.allowDownscale) return best;
    const nextScale = scale * SCALE_STEP;
    const nextEdge = Math.round(Math.max(canvas.width, canvas.height) * nextScale);
    if (nextEdge < minEdge) return best;
    scale = nextScale;
    working = scaleCanvas(canvas, scale);
  }
}

/** One-line summary of what a file needed, for the export report. */
export function describeBudget(result: BudgetResult): string {
  const parts: string[] = [];
  if (result.colors !== null) parts.push(`${result.colors} colours`);
  if (result.scale !== 1) parts.push(`${result.width}×${result.height}`);
  return parts.join(' · ') || 'full quality';
}
