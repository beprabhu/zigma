// Shared post-processing steps — the right pane's "processing space". Any product's result can
// be pushed through the same two steps the BG Remover pioneered:
//
//   1. remove background  — the in-browser model (lib/bg/engine), same weights, same cache
//   2. tile fit           — safe-area composition (lib/bg/safe-area), same config shape
//
// One implementation, four products. Compression is deliberately NOT here: it operates on
// encoded bytes, not pixels, so it lives in lib/compress.ts and runs after these.

import { DEFAULT_MODEL_ID, removeBackground } from './bg/engine';
import { renderTile, subjectBounds, type SafeAreaConfig } from './bg/safe-area';
import { releaseCanvas } from './bg/batch';

export interface ProcessSteps {
  /** Run the background-removal model on the source first. */
  removeBg: boolean;
  /** Fit the (possibly cut-out) subject into this safe area; null = keep the source frame. */
  tileFit: SafeAreaConfig | null;
}

export function isProcessingActive(steps: ProcessSteps): boolean {
  return steps.removeBg || steps.tileFit !== null;
}

/**
 * Applies the enabled steps and returns a NEW canvas (the input is never touched; intermediate
 * canvases are released). With both steps off this is the identity — callers can skip encoding
 * work by checking isProcessingActive first.
 *
 * Bounds for tile fit are measured with the same subjectBounds the BG Remover uses: on a
 * cutout that is the subject's box, and on a fully opaque source it is simply the whole frame,
 * so tile fit without removal degrades gracefully to "fit the image".
 */
export async function processCanvas(
  source: HTMLCanvasElement,
  steps: ProcessSteps,
): Promise<HTMLCanvasElement> {
  let current = source;
  let owned = false; // whether `current` is ours to release

  if (steps.removeBg) {
    const { canvas } = await removeBackground(current, {
      model: DEFAULT_MODEL_ID,
      refine: false,
      zoomPass: false,
    });
    current = canvas;
    owned = true;
  }

  if (steps.tileFit) {
    const ctx = current.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    const pixels = ctx.getImageData(0, 0, current.width, current.height);
    const bounds = subjectBounds(pixels);
    const tiled = renderTile(current, steps.tileFit, { bounds });
    if (owned) releaseCanvas(current);
    current = tiled;
    owned = true;
  }

  if (!owned) {
    // Identity — hand back a copy so callers can uniformly release what they receive.
    const copy = document.createElement('canvas');
    copy.width = source.width;
    copy.height = source.height;
    copy.getContext('2d')!.drawImage(source, 0, 0);
    current = copy;
  }
  return current;
}

/** Convenience for callers holding an HTMLImageElement rather than a canvas. */
export async function processImage(
  image: HTMLImageElement,
  steps: ProcessSteps,
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  canvas.getContext('2d')!.drawImage(image, 0, 0);
  if (!isProcessingActive(steps)) return canvas;
  const out = await processCanvas(canvas, steps);
  releaseCanvas(canvas);
  return out;
}
