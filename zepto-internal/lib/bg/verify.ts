// Second-model cross-check for ambiguous cutouts (see quality.needsVerify for what routes
// here). The idea: two different architectures rarely make the SAME mistake, so when RMBG's
// cutout and BiRefNet's disagree on a meaningful share of the frame, something is wrong with
// one of them — and which one doesn't matter for a FLAG, a human (or the AI-fix ladder) looks
// either way. Agreement, conversely, is strong evidence the ambiguity was benign (a legit
// shadow removed, a genuinely big product), which is what lets the ambiguous band stay quiet
// instead of flooding the grid with maybes.
//
// This module owns the model choice and the mask comparison; the page owns orchestration
// (when to sweep, what to patch) the same way it does for AI-fix.

import type { BgModelId } from './engine';
import type { BgVerify, BgItem } from './batch';
import type { SubjectBounds } from './safe-area';

/**
 * BiRefNet: the strongest in-browser model that is NOT the batch default, already vendored
 * under public/models/ (the 512 static export — the dynamic one crashes onnxruntime-web).
 * Deliberately a different architecture from RMBG-1.4: the whole point is decorrelated errors.
 */
export const VERIFY_MODEL_ID: BgModelId = 'birefnet';

/**
 * Mask IoU at or above which the two models are telling the same story. Initial value, set
 * from the shape of the problem rather than a golden set (matte edges alone cost a few points
 * of IoU on soft subjects; a kept ottoman or an eaten roll-side costs tens): the verify record
 * persists iou itself, so the bar is retunable offline like every other threshold.
 */
export const VERIFY_AGREE_IOU = 0.85;

/** Comparison resolution. Masks are compared as shapes, and shape disagreement that matters
 *  (a pedestal, half a roll) survives any sane downscale — while full-res comparison would
 *  decode two multi-MP images per item for no verdict change. */
const COMPARE_EDGE = 512;

/** Alpha above which a pixel counts as kept — matches the region pass's foreground bar. */
const COMPARE_ALPHA = 128;

/**
 * The areas the product-only filter deleted from this item's cutout, as don't-care rects for
 * compareCutouts. The checker always runs unfiltered (see the sweep), so these are exactly
 * the pixels where the two sides were never asked the same question.
 *
 * Known gap: band strips (lib/bg/bands.ts) are masked before the region pass and leave no
 * region entry, so a banded cutout can still show a strip of honest-looking disagreement.
 * `item.bands` now survives both the file store and a .zesku round trip, so closing this is a
 * matter of folding those strips in here — the data is no longer the obstacle.
 */
export function filteredRects(item: BgItem): SubjectBounds[] {
  return (item.regionReport ?? []).filter((r) => r.removed).map((r) => r.bounds);
}

function toMask(bitmap: ImageBitmap, w: number, h: number): Uint8Array {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const c2d = canvas.getContext('2d', { willReadFrequently: true })!;
  c2d.drawImage(bitmap, 0, 0, w, h);
  const data = c2d.getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) {
    if (data[i * 4 + 3] > COMPARE_ALPHA) mask[i] = 1;
  }
  canvas.width = 0;
  canvas.height = 0;
  return mask;
}

/**
 * IoU + disputed share between two cutouts of the SAME source. Both are drawn to one
 * comparison size (they share a source, so their aspect matches; drawing normalises any
 * resolution difference between the primary's post-cap size and the checker's).
 *
 * `excluded` marks rectangles the comparison must ignore — the regions the product-only
 * filter deliberately deleted from the primary. Without them the check answers the wrong
 * question: the primary's blob is post-filter and the checker's is a raw matte, so every
 * correctly-removed marketing banner reads as the two models disagreeing about the product
 * when they in fact agree and only the filter ran on one side. Rects are in the PRIMARY's
 * full-resolution coordinates and are scaled into comparison space here.
 */
export async function compareCutouts(
  primary: Blob,
  checker: Blob,
  model: string,
  excluded: SubjectBounds[] = [],
): Promise<BgVerify> {
  const [a, b] = await Promise.all([createImageBitmap(primary), createImageBitmap(checker)]);
  try {
    const scale = Math.min(1, COMPARE_EDGE / Math.max(a.width, a.height));
    const w = Math.max(1, Math.round(a.width * scale));
    const h = Math.max(1, Math.round(a.height * scale));
    const maskA = toMask(a, w, h);
    const maskB = toMask(b, w, h);

    // Don't-care mask. Built by rect rather than by exact region shape because the stored
    // evidence is bounding boxes; a bbox only ever widens the ignored area, so the check can
    // lose sensitivity here but can never invent a disagreement out of a filtered panel.
    const ignore = new Uint8Array(w * h);
    let ignored = 0;
    for (const rect of excluded) {
      const x0 = Math.max(0, Math.floor(rect.x * scale));
      const y0 = Math.max(0, Math.floor(rect.y * scale));
      const x1 = Math.min(w, Math.ceil((rect.x + rect.w) * scale));
      const y1 = Math.min(h, Math.ceil((rect.y + rect.h) * scale));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * w + x;
          if (!ignore[i]) {
            ignore[i] = 1;
            ignored++;
          }
        }
      }
    }

    let inter = 0;
    let union = 0;
    let disputed = 0;
    for (let i = 0; i < maskA.length; i++) {
      if (ignore[i]) continue;
      const x = maskA[i];
      const y = maskB[i];
      if (x & y) inter++;
      if (x | y) union++;
      if (x !== y) disputed++;
    }
    // Two empty masks agree vacuously — but an empty PRIMARY mask never reaches the sweep
    // (needsVerify requires bounds), so union 0 here means the checker also found nothing.
    const iou = union ? inter / union : 1;
    const compared = maskA.length - ignored;
    return {
      model,
      iou,
      disputedFraction: compared > 0 ? disputed / compared : 0,
      agree: iou >= VERIFY_AGREE_IOU,
    };
  } finally {
    a.close();
    b.close();
  }
}
