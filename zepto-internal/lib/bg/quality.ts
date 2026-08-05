// Post-removal quality triage: flags cutouts worth a second look without re-scanning any
// pixels. Every signal below is already sitting on the BgItem after a batch run — the subject
// bbox from safe-area's alpha scan, and the per-region report keepProductRegions produces
// while stripping graphic panels (bounds, area, fillRatio, touchesEdge, removed). This module
// only reads that data and turns it into a per-item verdict + a sortable rank.
//
// Deliberately conservative: a false "ok" costs a human catching it in the grid anyway; a false
// "bad" on every third image would make the flag useless. Thresholds below are geometric
// sanity checks (empty matte, near-zero or near-total subject area, edge-touching fragments,
// heavy-handed filtering), not a replacement for looking at the picture.

import type { BgItem } from './batch';

export type QualityLevel = 'ok' | 'warn' | 'bad';

export interface QualityAssessment {
  level: QualityLevel;
  reasons: string[];
}

const OK: QualityAssessment = { level: 'ok', reasons: [] };

/** Subject bbox smaller than this share of the canvas reads as a missed or truncated cutout. */
const TINY_SUBJECT_FRACTION = 0.015;
/** Subject bbox this close to the full canvas, with nothing filtered, suggests bg wasn't removed. */
const HUGE_SUBJECT_FRACTION = 0.97;
/** More kept regions than this, mostly small, reads as leftover speckle rather than a real product. */
const MANY_FRAGMENTS = 5;
/** A kept region below this share of the canvas counts as a "small" fragment for the check above. */
const FRAGMENT_MAX_AREA_FRACTION = 0.02;
/** Share of ALL detected regions the product-only filter removed — high means aggressive trimming. */
const HEAVY_REMOVAL_FRACTION = 0.6;
/** A kept region below this share of the canvas that also touches the frame edge reads as a crop. */
const EDGE_FRAGMENT_MAX_FRACTION = 0.5;
/** Subject bbox within this many px of a canvas edge counts as flush against it. */
const EDGE_SLACK = 1;
/** A kept region at or above this share of the canvas is a real object, not debris — two of
 *  them means the matte kept a scene prop (a bowl of beans beside the drink) or a second
 *  product. Measured on a real miss: the prop was 3.5% of the canvas, far above any speck. */
const SUBSTANTIAL_REGION_FRACTION = 0.01;

/** Pure — safe to call on every render; no image decode, just arithmetic over stored fields. */
export function assessQuality(item: BgItem): QualityAssessment {
  if (item.status !== 'done' || !item.cutout) return OK;
  const { bounds, width, height } = item.cutout;

  if (!bounds) {
    return { level: 'bad', reasons: ['No subject detected — the matte came back empty'] };
  }

  const canvasArea = width * height;
  if (canvasArea <= 0) return OK;
  const bboxArea = bounds.w * bounds.h;
  const bboxFraction = bboxArea / canvasArea;

  const reasons: string[] = [];

  if (bboxFraction < TINY_SUBJECT_FRACTION) {
    reasons.push('Subject occupies a tiny fraction of the frame — possible missed detection or bad crop');
  }

  // A scene photo cropped mid-product leaves the subject flush against a frame edge (a jar or
  // glass cut off at the bottom). A deliberate full-bleed crop also lands here — that is a
  // catalogue-quality problem in its own right, so the flag is still earned.
  const flushEdges =
    (bounds.x <= EDGE_SLACK ? 1 : 0) +
    (bounds.y <= EDGE_SLACK ? 1 : 0) +
    (bounds.x + bounds.w >= width - EDGE_SLACK ? 1 : 0) +
    (bounds.y + bounds.h >= height - EDGE_SLACK ? 1 : 0);
  if (flushEdges > 0 && bboxFraction >= TINY_SUBJECT_FRACTION) {
    reasons.push('Subject is flush with the frame edge — likely cropped mid-product');
  }

  const regions = item.regionReport ?? [];
  const kept = regions.filter((r) => !r.removed);
  const removedCount = item.removedRegions ?? 0;

  if (bboxFraction > HUGE_SUBJECT_FRACTION && removedCount === 0 && regions.length <= 1) {
    reasons.push('Subject fills the whole frame and nothing was filtered — background may not have been removed');
  }

  const smallFragments = kept.filter((r) => r.area / canvasArea < FRAGMENT_MAX_AREA_FRACTION);
  if (kept.length > MANY_FRAGMENTS && smallFragments.length >= kept.length - 1) {
    reasons.push(`${kept.length} disconnected regions kept — likely leftover background speckle`);
  }

  // Two or more meaningfully-sized kept regions = the matte kept something besides the product:
  // a scene prop (bean bowl beside a drink) or a second item. An accessory set trips this too —
  // acceptable, the flag means "look", not "reject".
  const substantial = kept.filter((r) => r.area / canvasArea >= SUBSTANTIAL_REGION_FRACTION);
  if (substantial.length >= 2) {
    reasons.push(`${substantial.length} separate objects kept — a scene prop may have survived the cutout`);
  }

  if (regions.length > 1 && removedCount / regions.length > HEAVY_REMOVAL_FRACTION) {
    reasons.push(`${removedCount}/${regions.length} regions removed — check the kept product wasn't over-trimmed`);
  }

  const edgeFragments = kept.filter(
    (r) => r.touchesEdge && r.area / canvasArea < EDGE_FRAGMENT_MAX_FRACTION,
  );
  if (edgeFragments.length > 0 && kept.length <= 2) {
    reasons.push('Kept region touches the frame edge — check the subject wasn’t cropped');
  }

  if (!reasons.length) return OK;
  const bad = reasons.some((r) => r.startsWith('No subject'));
  return { level: bad ? 'bad' : 'warn', reasons };
}

export function qualityRank(level: QualityLevel): number {
  return level === 'bad' ? 0 : level === 'warn' ? 1 : 2;
}

/** Worst-first, stable within a tier (Array#sort is stable, so ties keep queue order). */
export function sortByQuality<T extends BgItem>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => qualityRank(assessQuality(a).level) - qualityRank(assessQuality(b).level),
  );
}

export function countFlagged(items: BgItem[]): number {
  let n = 0;
  for (const item of items) {
    if (assessQuality(item).level !== 'ok') n++;
  }
  return n;
}
