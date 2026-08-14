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

//
// The back half of the file turns that verdict into the grid's filter/sort vocabulary. It stays
// here rather than in a UI module because "flagged" has to mean the same thing to the chip that
// counts it, the predicate that hides tiles, and the button that acts on them.

import type { BgItem } from './batch';
import type { RegionReport } from './regions';

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
/**
 * Companion test, measured against the LARGEST kept region instead of the canvas. "Is this a
 * separate object?" is a question about size relative to the product, and the canvas-relative
 * bar above only answers it when the shot is tightly cropped. On a padded catalogue frame a
 * genuine second object measures like noise: a vacuum's crevice tool came in around 1% of the
 * canvas (borderline) and its brush head at 0.7% (invisible), while both are 15-20% of the
 * vacuum — obviously separate objects to anyone looking. The coconut-water case is the same
 * shape one size down: a detached coconut chunk at 0.16% of canvas, ~2% of the bottle.
 *
 * Sits five times above the region pass's own speck bar (minAreaFraction 0.001 of the largest
 * region, lib/bg/regions.ts) so matte debris that survived filtering does not re-enter here as
 * a "companion", and roughly half the coconut chunk's measured share so the bar is not resting
 * on the exact case that motivated it. On a product covering a fifth of the frame the smallest
 * thing that fires is about a 20x20px blob — big enough to name when you look at the tile.
 *
 * Both misses were measured off screenshots, not off a stored regionReport. If a real batch
 * proves this noisy, raise it rather than adding a second condition — the canvas-relative bar
 * beside it already covers the large-companion end.
 */
const COMPANION_MIN_ANCHOR_FRACTION = 0.005;
/** Faint out-of-bbox coverage (measureFaintResidue) above this share of the canvas reads as
 *  ghosted overlay graphics or a stray soft shadow. Kept high on purpose: matte edges always
 *  bleed a little, and a flag that fires on every soft-edged cutout teaches people to ignore it. */
const RESIDUE_MIN_FRACTION = 0.01;

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
  //
  // Two views of "meaningfully-sized", because neither denominator catches both misses. Against
  // the CANVAS, a prop in a tight crop is unmissable but a real accessory in a padded frame is
  // not. Against the largest kept region, a small companion is unmissable but a genuinely huge
  // second object can drag the comparison the other way when the two are close in size — that
  // one the canvas view already has. Either signal firing is enough; the count reported is
  // whichever view saw more, so the reason never undercounts what the user is about to look at.
  const substantial = kept.filter((r) => r.area / canvasArea >= SUBSTANTIAL_REGION_FRACTION);
  const anchor = kept.reduce<RegionReport | null>((max, r) => (!max || r.area > max.area ? r : max), null);
  const companions = anchor
    ? kept.filter((r) => r !== anchor && r.area >= anchor.area * COMPANION_MIN_ANCHOR_FRACTION)
    : [];
  if (substantial.length >= 2 || companions.length > 0) {
    const objects = Math.max(substantial.length, companions.length + 1);
    reasons.push(`${objects} separate objects kept — a scene prop or accessory may have survived the cutout`);
  }

  // Analysis-only runs (Product only OFF) mark would-drop regions instead of deleting them.
  // This is the badge-collage catcher: green marketing circles, floating text columns.
  const flaggedGraphics = kept.filter((r) => r.flagged);
  if (flaggedGraphics.length > 0) {
    reasons.push(
      `${flaggedGraphics.length} region${flaggedGraphics.length === 1 ? '' : 's'} look like graphic overlays (badges/text) — the Product-only filter would drop them`,
    );
  }

  // Ghosted overlays live below the alpha threshold, invisible to every check above.
  if ((item.cutout.residueFraction ?? 0) >= RESIDUE_MIN_FRACTION) {
    reasons.push('Faint semi-transparent residue outside the subject — ghosted graphics or a leftover shadow');
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
  return sortByQualityWith(items, assessQuality);
}

export function countFlagged(items: BgItem[]): number {
  let n = 0;
  for (const item of items) {
    if (assessQuality(item).level !== 'ok') n++;
  }
  return n;
}

/**
 * A verdict the caller already has. assessQuality is cheap per call but not free per CELL per
 * RENDER: a virtualized 3,000-tile grid re-runs every predicate on each scroll frame, and the
 * comparator below would re-assess O(n log n) times per sort. Everything downstream therefore
 * takes the verdict as data. Build the table once per queue change with assessQueue().
 */
export type VerdictLookup = (item: BgItem) => QualityAssessment;

export function assessQueue(items: readonly BgItem[]): ReadonlyMap<number, QualityAssessment> {
  const verdicts = new Map<number, QualityAssessment>();
  for (const item of items) verdicts.set(item.id, assessQuality(item));
  return verdicts;
}

/**
 * Reader over an assessQueue() table. The miss case returns OK rather than assessing on the
 * spot: a miss means the table is a render behind the queue (an item added since the memo), and
 * silently re-assessing would hide exactly the staleness worth noticing while costing the work
 * the table exists to avoid.
 */
export function verdictLookup(verdicts: ReadonlyMap<number, QualityAssessment>): VerdictLookup {
  return (item) => verdicts.get(item.id) ?? OK;
}

/**
 * Which tiles the results grid is showing. Single-select on purpose: these are five views of
 * one queue, not facets to intersect. An intersection like "AI-generated AND severe" has no
 * operator behind it — no button in the product acts on that set — and multi-select would also
 * make the chip counts lie, since each count is measured against the whole queue.
 *
 * 'flagged' is any severity, 'flagged-severe' is the `bad` tier only (today: the empty-matte
 * case). 'errored' is a run STATUS, disjoint from the quality verdict — assessQuality returns
 * OK for anything not `done`, so a failed item is never also flagged.
 */
export const QUEUE_FILTERS = ['all', 'flagged', 'flagged-severe', 'ai', 'errored'] as const;

export type QueueFilter = (typeof QUEUE_FILTERS)[number];

/** Grid ordering. 'quality' is worst-first; 'queue' is insertion order. */
export type QueueSort = 'queue' | 'quality';

export type QueueFilterCounts = Record<QueueFilter, number>;

/**
 * An AI edit replaces the item's source with the file Azure produced, and that swap is the only
 * durable trace of it — status goes back to 'done' after the re-removal, and `prev` is cleared
 * by undo. So the regenerated flag on the source IS the definition of "AI-generated" here.
 */
export function isAiGenerated(item: BgItem): boolean {
  return item.source.kind === 'file' && item.source.regenerated === true;
}

/**
 * Archived-source policy — the one place two "flagged" numbers are allowed to disagree.
 *
 * page.tsx's flaggedItems (what the "AI-fix flagged (n)" button runs on) additionally filters by
 * canRetry(): an archived item restored from a saved project has no original bytes, so there is
 * nothing to send through Azure and nothing to re-remove. That list is a WORKLIST and must hold
 * only items the button can actually act on.
 *
 * This predicate is a VIEW, so it keeps archived items. Hiding an archived flagged tile behind
 * the flagged chip would drop precisely the cutouts that need a human — nothing automated can
 * repair them — and it would do so while the amber badge on the tile is still visible in the
 * unfiltered grid, which reads as a bug.
 *
 * The consequence is deliberate: with archived items queued, a chip reading "Flagged 12" beside
 * a button reading "AI-fix flagged (9)" is correct. Wire the chip counts from
 * countQueueFilters() and the button from the canRetry-filtered list, and never derive one from
 * the other — making them agree would mean either hiding tiles or offering a fix that no-ops.
 */
export function matchesQueueFilter(
  item: BgItem,
  filter: QueueFilter,
  verdict: QualityAssessment,
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'flagged':
      return verdict.level !== 'ok';
    case 'flagged-severe':
      return verdict.level === 'bad';
    case 'ai':
      return isAiGenerated(item);
    case 'errored':
      return item.status === 'error';
  }
}

/**
 * 'all' returns the SAME array, not a copy — the results grid keys its windowing memos off the
 * items reference, so cloning on the default filter would invalidate them on every render.
 */
export function filterQueue<T extends BgItem>(
  items: T[],
  filter: QueueFilter,
  verdictOf: VerdictLookup,
): T[] {
  if (filter === 'all') return items;
  return items.filter((item) => matchesQueueFilter(item, filter, verdictOf(item)));
}

/**
 * Every chip's count in one pass. Counts are measured against the WHOLE queue, so a chip always
 * answers "how many would I show if you pressed me" regardless of what is selected now — a chip
 * whose count moved because of the active filter could never be trusted as a way out of it.
 */
export function countQueueFilters(
  items: readonly BgItem[],
  verdictOf: VerdictLookup,
): QueueFilterCounts {
  const counts: QueueFilterCounts = {
    'all': items.length,
    'flagged': 0,
    'flagged-severe': 0,
    'ai': 0,
    'errored': 0,
  };
  for (const item of items) {
    const verdict = verdictOf(item);
    if (verdict.level !== 'ok') {
      counts.flagged++;
      if (verdict.level === 'bad') counts['flagged-severe']++;
    }
    if (isAiGenerated(item)) counts.ai++;
    if (item.status === 'error') counts.errored++;
  }
  return counts;
}

/** sortByQuality against a prebuilt verdict table — see VerdictLookup for why that matters. */
export function sortByQualityWith<T extends BgItem>(items: T[], verdictOf: VerdictLookup): T[] {
  return [...items].sort((a, b) => qualityRank(verdictOf(a).level) - qualityRank(verdictOf(b).level));
}
