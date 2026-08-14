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

import { BG_MODELS, type BgModelId } from './engine';
import type { BgItem } from './batch';
import type { OriginalComponentReport, RegionReport } from './regions';

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
/**
 * …but only if the matte also KEPT that much. A full-bleed pack shot legitimately fills the
 * bbox while the matte still cuts its margins away; a matte that genuinely removed nothing
 * leaves the canvas essentially opaque. Measured: a tightly-cropped CRAX packet kept ~91% of
 * the canvas (and was flagged), while an unremoved background keeps ~100%.
 */
const HUGE_SUBJECT_KEPT_FRACTION = 0.95;
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
/**
 * A companion at or above this share of the anchor reads as a composed shot — a second view,
 * the box beside the product — rather than something the matte failed to drop. Set from the
 * measured healthy pairs (front/back ~1.0, racquet+box 0.63, bottle+carton 0.84, tube+applicator
 * 0.45) against the true-prop examples, which all sat well under a quarter of the anchor.
 */
const COMPOSED_MIN_ANCHOR_FRACTION = 0.25;
/** This many canvas-substantial pieces cannot be a composed pair any more — the matte shattered.
 *  The measured failures held 3-10 pieces; the deliberate compositions never exceeded two. */
const FRAGMENTED_MIN_PIECES = 3;
/**
 * Mirrors the filter's own protection bar: a non-edge removal at or above this share of the
 * anchor should be impossible once the guard is live, so seeing one means pre-guard data or a
 * regression — either way, look. The extreme bar catches a removal well over half the product
 * even when it touches an edge, where the guard deliberately still allows the drop.
 */
const REMOVED_PROTECTED_FRACTION = 0.25;
const REMOVED_EXTREME_FRACTION = 0.6;
/**
 * Coverage collapse: the cutout's subject bbox under this fraction of the original's ink bbox
 * reads as vanished content. The glasses failure measured ~0.3 against an original at ~0.8;
 * ordinary white-field shots land near 1.0 because the subject IS the ink. Below the original
 * floor the original was mostly empty and the ratio means nothing.
 */
const COLLAPSE_MAX_RATIO = 0.35;
const COLLAPSE_MIN_ORIGINAL_BBOX = 0.2;
/** Above this ink share the original is a full-bleed scene, not a figure on white, and its
 *  footprint no longer says where the product was. */
const COLLAPSE_MAX_ORIGINAL_INK = 0.85;
/** Faint out-of-bbox coverage (measureFaintResidue) above this share of the canvas reads as
 *  ghosted overlay graphics or a stray soft shadow. Kept high on purpose: matte edges always
 *  bleed a little, and a flag that fires on every soft-edged cutout teaches people to ignore it. */
const RESIDUE_MIN_FRACTION = 0.01;

// ---- Original-component survival (the Ezee incident class) -----------------
//
// The coverage-collapse check above compares whole-canvas bounding boxes, so an element the
// model erased INSIDE the matte — a navy "9 MTR" badge, a banner, one glass of six — moves it
// not at all when the product still spans the frame. Per-component survival is the same
// original-side witness at element granularity: measured against the PRE-filter matte (so the
// product-only filter's deliberate panel drops never read as losses), persisted, and judged
// here as pure arithmetic.

/** At or below this survival an original element is gone, not eroded. */
const VANISHED_MAX_SURVIVAL = 0.1;
/** A vanished element only flags when it spans at most this many frame edges: full-bleed
 *  backgrounds (which SHOULD vanish) span 2-4 edges, while a composited banner reaches 1. */
const VANISHED_MAX_EDGES = 1;
/** Elements above this share of the canvas are backdrops, not badges — measured badges and
 *  banners sit small-to-mid, colored backdrop cards run 40-90% of the frame. */
const VANISHED_MAX_AREA_FRACTION = 0.4;
/**
 * Detached-shadow suppression: a floating-product hero shot ships with a soft elliptical
 * shadow under it, a separate non-edge component the model CORRECTLY deletes — without this
 * gate the vanished flag fires on one of the catalogue's most common conventions. The tell is
 * the ORIGINAL's pixels: a shadow is neutral (chroma ~0) AND smooth; artwork is saturated or
 * textured. Both bars are deliberately permissive first guesses (suppress only the obvious)
 * and UNMEASURED against a golden set yet — the per-component evidence persists either way,
 * so they are retunable offline against saved projects without re-running a matte.
 */
const SHADOW_MAX_CHROMA = 18;
const SHADOW_MAX_FLATNESS = 4;

/**
 * Whether a component's ORIGINAL pixels look like a shadow the model was right to delete.
 * Requires the smoothness to have actually been MEASURED: a component thinner than the
 * texture stride collects no interior samples and reports flatness 0, which is the maximally
 * shadow-like value — so treating unmeasured as smooth suppresses exactly the thin neutral
 * things this check exists to catch (a hairline rule, the outline of a clear glass — the
 * "one glass of six" incident is neutral and thin, and would have been silently swallowed).
 * Unmeasured texture means ineligible for suppression, not eligible for it.
 */
function looksLikeShadow(c: OriginalComponentReport): boolean {
  return c.chroma <= SHADOW_MAX_CHROMA && c.gradSamples > 0 && c.flatness <= SHADOW_MAX_FLATNESS;
}

/**
 * Whether what a component LOST looks like a shadow or reflection rather than product. Reads
 * the lost pixels' own colour and where they sat: a grounded product's fused cast shadow and a
 * mirror reflection are neutral AND sit below the ink that survived. This is the difference
 * between "the matte correctly dropped the shadow this bottle stands in" and "the matte ate a
 * strip of the label", which the survival number alone cannot express.
 */
function lostLooksLikeShadow(c: OriginalComponentReport): boolean {
  return c.lostChroma <= SHADOW_MAX_CHROMA && c.lostBelow > 0;
}

/**
 * Survival above which a neutral loss BELOW the surviving ink is treated as an ordinary
 * grounded-product shadow and not worth a second model's time. The catalogue's default hero
 * framing — a pouch or bottle standing on white with a fused contact shadow — sits at 0.8-0.95
 * here, and routing every one of those would put thousands of BiRefNet inferences on a 14k
 * batch while the verify band is supposed to be the small uncertain few. Below this bar the
 * loss is too large to wave through as a shadow (the Mamaearth shot measured 0.65) and still
 * routes.
 */
const SHADOW_LOSS_MIN_SURVIVAL = 0.7;
/**
 * Partial-erosure band, conservative by design. A cast shadow or mirror reflection is fused
 * into the product's own component and legitimately removed, pulling a PERFECT cutout's
 * survival to 0.6-0.9 — so a bar high enough to catch a subtle nibble would flag half the
 * catalogue (the flush-edge lesson). Below the band's floor sits the other false fire: a
 * non-edge colored backdrop correctly removed leaves survival ≈ product/component, well under
 * a third. What remains between floor and ceiling is gross erosion: a substantial element
 * that lost roughly half its ink. Subtler cases are the verify sweep's job, not a flag's.
 */
const ERODED_MIN_SURVIVAL = 0.33;
const ERODED_MAX_SURVIVAL = 0.55;
const ERODED_MIN_AREA_FRACTION = 0.05;

/**
 * Suspected leftover panel, judged on PALETTE ALONE — no geometry vote. The filter needs a
 * rectangle before it will delete on a flat palette, and it is right to: a plain white carton
 * beside its bottle measures like a panel, so shape is what keeps the filter from eating a
 * second product. But a FLAG deletes nothing, so it can act on the palette evidence by itself.
 * Measured on a nose-strip banner the filter kept: 84% top-4 coverage across 30 distinct
 * colours, yet fill 0.71 (rounded strip ends) put it out of reach of every drop rule. The
 * module's own sweep puts photographed products at 437-610 distinct bins and composited panels
 * at 77-133, so a large region under the photographic floor is artwork whatever its outline.
 *
 * The anchor is exempt — the product itself is allowed to be flat.
 */
const PANEL_MIN_PALETTE_COVERAGE = 0.75;
const PANEL_MAX_COLORS = 250;
const PANEL_MIN_AREA_FRACTION = 0.01;

/**
 * Full-bleed background: an ink component of the ORIGINAL that runs to all four frame edges
 * and covers most of the canvas. In this catalogue a white field is the norm, so a wall-to-wall
 * background is both unusual and the single hardest case for the matte — every incident of
 * kept residue (a toy box on a pink room, a rajma pack on a dark wooden floor, a masala carton
 * on a printed yellow field) has this exact shape. Deliberately NOT gated on busyOriginal:
 * that gate exists because a busy original stops describing where the product is, but this
 * check is not asking where the product is — it is asking whether the background came along.
 *
 * Survival is what answers that. The component fuses product and background, so a clean cutout
 * leaves only the product's share (a lifestyle product is typically a fifth to a third of the
 * frame), while a cutout that dragged the background in stays high — the rajma pack measured
 * 0.62. First guess at the bar, and it is the one number here most worth a golden-set sweep.
 */
const FULL_BLEED_MIN_AREA_FRACTION = 0.5;
const FULL_BLEED_MAX_CLEAN_SURVIVAL = 0.5;

/**
 * …and only when that background is actually a SCENE. Edge-to-edge ink is not the same thing
 * as a styled background: a studio seamless a shade off pure white spans the frame too, and
 * every product shot on one was being flagged (gym gloves on grey measured chroma 1, 97% of
 * canvas, four edges — a flawless cutout wearing a leftover-background warning). What makes
 * the residue cases hard is that the background has CONTENT — a pink room, a wooden floor, a
 * printed yellow field, a tiled cloth — and content shows up as colour or as texture in the
 * pixels the matte removed.
 *
 * Either signal qualifies, because they fail independently: a rajma pack's dark floor is
 * nearly neutral (lost chroma 4) but heavily textured, while a purple cloth is smooth-ish and
 * saturated (lost chroma 102). A studio backdrop is neither. Texture must have been MEASURED
 * to count, same rule as everywhere else — unsampled is not smooth.
 *
 * Both bars are first guesses from the handful of measured images and want a golden-set sweep;
 * the chroma one sits above studio-neutral (1-4) and below any real colour, the texture one
 * above the region pass's own "smooth/vector" band (3) and above ordinary JPEG noise.
 */
const BG_VARIATION_MIN_CHROMA = 12;
const BG_VARIATION_MIN_FLATNESS = 6;

/** Whether a full-frame background carries content, rather than being a plain studio field. */
function backgroundHasVariation(c: OriginalComponentReport): boolean {
  return (
    c.lostChroma >= BG_VARIATION_MIN_CHROMA ||
    (c.lostGradSamples > 0 && c.lostFlatness >= BG_VARIATION_MIN_FLATNESS)
  );
}

/**
 * An original element the matte TORE APART. One connected thing in the original that comes back
 * as two or more separate pieces has been punched through, and no cutout-side check can see it:
 * a blister pack of batteries with a hole blown through its card measured two kept regions of
 * comparable size, which the fragmentation rule reads as "not enough pieces" (it wants three)
 * and the companion rule reads as a deliberately composed pair (the second piece is a third of
 * the anchor, above the composition bar). Both readings are right about the shapes and wrong
 * about the image — what settles it is that the ORIGINAL had one element there, not two.
 *
 * Backgrounds are exempt: on a full-bleed scene every object is trivially connected through the
 * backdrop, so "one element became several" is just what cutting out a scene looks like. And
 * the element must have largely survived — a torn product is a different failure from an eaten
 * one, which the vanished and eroded checks already own.
 */
const SPLIT_MIN_SURVIVAL = 0.5;

/**
 * A scene prop that survived. On a full-bleed scene the catalogue's deliberate compositions do
 * not apply — product-beside-its-box is shot on white, so a second substantial object cut out
 * of a styled scene is a prop: the oil bottle and its coaster standing next to a bhujia pouch
 * on a purple cloth. Independent of the survival bar above, which that image slipped under at
 * 44% while still keeping two separate things.
 */
const SCENE_PROP_MIN_KEPT_REGIONS = 2;

/**
 * A heavily composited source. One or two badges on a pack shot is this catalogue's normal
 * furniture and the filter handles it cleanly — flagging those is the documented mistake that
 * taught people to ignore the warning (a deodorant wore one for two perfect panel removals).
 * But a shot the filter has to strip five or more separate graphic elements out of is a
 * different kind of image: a marketing collage, where the odds that a fragment survived or a
 * piece of product went with a badge are far higher than on a plain pack shot. Measured on a
 * baby-wash tile that came back with seven badges stripped and two badge remnants still
 * floating beside the bottle.
 *
 * Counted with a size floor, because "how many elements" must not be answered by dust: those
 * badges ran 2-4k px with 8-13 colours each, while the five "removals" on a rajma pack were
 * 50-800px artefacts. The floor is a tenth of the substantial bar — small enough for a real
 * badge, far above matte noise.
 */
const COLLAGE_MIN_REMOVED = 5;
const COLLAGE_MIN_ELEMENT_FRACTION = 0.001;

// ---- Verify routing (the second-model cross-check band) --------------------

/** Survival between the erosion ceiling and this is AMBIGUOUS: legit shadow removal and the
 *  Ezee foil's eaten underside both live here, and no scalar separates them — only a second
 *  model's opinion does. */
const VERIFY_MAX_SURVIVAL = 0.9;
/** An ambiguous element must be at least this share of the canvas to be worth an inference. */
const VERIFY_MIN_AREA_FRACTION = 0.01;
/**
 * Edge gate for ROUTING, looser than the flag's: a bottle whose cast shadow runs off the
 * frame spans 2 edges (measured live on a Mamaearth catalogue shot — survival 0.65, exactly
 * the band the sweep exists for, and the ≤1 gate silently dropped it). Only 3-4 edges reads
 * as a full-bleed background. The FLAG gates stay at ≤1 — a flag must be conservative, a
 * routing decision only costs one local inference.
 */
const VERIFY_MAX_EDGES = 2;
/**
 * Residue signature (the Barbie incident): a colored original — ink above this — whose cutout
 * kept one fused region covering most-but-not-all of the frame with nothing filtered. On a
 * white-field original the same geometry is just a big product, which is the whole point of
 * the gate — and at 0.5 it did not hold: a detergent carton filling 70% of a white frame
 * measures 0.6-0.75 ink and sailed through every clause. Set at the busy-original bar, where
 * ink stops describing a product and starts describing a background: the Barbie original
 * measured ~0.92, so the motivating incident still routes.
 */
const VERIFY_RESIDUE_MIN_INK = COLLAPSE_MAX_ORIGINAL_INK;
const VERIFY_RESIDUE_MIN_BBOX = 0.5;
/**
 * …and the ink has to extend BEYOND what the cutout kept. Ink share alone cannot tell a
 * wall-to-wall background from a product that simply fills its frame: a snack packet cropped
 * to its own margins measures ink 0.89 and trips every other clause (reproduced live — it was
 * routed, and the checker's differing matte then flagged a clean cutout). The residue case is
 * different in a way this measures: the Barbie original's ink ran to all four edges while its
 * cutout bbox stopped at 0.77, so ink outside the kept bbox is the actual signal. A full-bleed
 * product has none — its ink bbox and its cutout bbox are the same rectangle.
 */
const VERIFY_RESIDUE_MAX_COVERAGE = 0.9;
/** Coverage ratios just ABOVE the collapse bar: not flagged, but suspicious enough to check. */
const VERIFY_NEAR_COLLAPSE_RATIO = 0.6;

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
  // Two edges or more: a subject flush against a SINGLE edge is ordinary framing in this
  // catalogue (a pouch matted to the top of its frame, a bottle grounded on the bottom) and
  // fired on 44% of a golden-set run — while a subject pinned against two or more edges really
  // is overflowing its frame. Measured: half the flush flags were single-edge, and every one
  // inspected was benign.
  if (flushEdges >= 2 && bboxFraction >= TINY_SUBJECT_FRACTION) {
    reasons.push('Subject is flush with the frame edges — likely cropped mid-product');
  }

  // The one question no cutout-side check can answer: is most of the picture simply gone?
  // Absent objects leave no regions and no residue — five of six transparent glasses vanished
  // with nothing left to inspect. The original's footprint, measured before the matte, is the
  // only witness. Gated on the original actually having content (a mostly-empty original makes
  // the ratio meaningless) and thresholded so a full-bleed lifestyle shot with a legitimately
  // small product does not fire it.
  if (item.originalInk && item.originalInk.bbox >= COLLAPSE_MIN_ORIGINAL_BBOX) {
    // Two gates, both learned from real false fires. A busy-background original (a lifestyle
    // shot on a marble counter) has ink everywhere, so its footprint stops approximating
    // "where the product was" — two perfect pourers measured 0.32 against it. And panels the
    // product-only filter removed were part of the original's ink, so without subtracting them
    // every big-badge shot reads as collapsed — the large-removed check already speaks for
    // those pixels, and one deliberate flag beats two accidental ones.
    const removedShare =
      (item.regionReport ?? []).reduce((sum, r) => (r.removed ? sum + r.area : sum), 0) /
      (item.cutout.width * item.cutout.height);
    const expected = item.originalInk.bbox - removedShare;
    const busyBackground = item.originalInk.ink > COLLAPSE_MAX_ORIGINAL_INK;
    if (!busyBackground && expected >= COLLAPSE_MIN_ORIGINAL_BBOX) {
      const ratio = bboxFraction / expected;
      if (ratio < COLLAPSE_MAX_RATIO) {
        reasons.push(
          'Cutout covers a fraction of what the original did — parts of the product may have vanished',
        );
      }
    }
  }

  // Per-element survival. Gated like coverage-collapse on a busy original — when the
  // background itself is ink, components stop meaning "composited elements" — and skipping
  // shadow-shaped and backdrop-shaped losses (see the constants above for both incidents).
  const components = item.originalComponents ?? [];
  const busyOriginal = (item.originalInk?.ink ?? 0) > COLLAPSE_MAX_ORIGINAL_INK;

  // The original's background ran edge to edge. Ungated on purpose (see FULL_BLEED_* above):
  // this is the one check that WANTS the busy originals, because on a white-field catalogue a
  // wall-to-wall background is both the exception and the case the matte most often fails on.
  // What it means for the cutout is judged further down, where the kept regions are known.
  const fullBleed = components.find(
    (c) =>
      c.edgeContact === 4 &&
      c.areaFraction >= FULL_BLEED_MIN_AREA_FRACTION &&
      backgroundHasVariation(c),
  );
  if (fullBleed && fullBleed.survival > FULL_BLEED_MAX_CLEAN_SURVIVAL) {
    reasons.push(
      `The original's background covers the whole frame and ${Math.round(fullBleed.survival * 100)}% of it survived the matte — check for leftover background`,
    );
  }

  if (components.length && !busyOriginal) {
    const vanished = components.filter(
      (c) =>
        c.survival <= VANISHED_MAX_SURVIVAL &&
        c.edgeContact <= VANISHED_MAX_EDGES &&
        c.areaFraction <= VANISHED_MAX_AREA_FRACTION &&
        !looksLikeShadow(c),
    );
    if (vanished.length > 0) {
      reasons.push(
        `${vanished.length} element${vanished.length === 1 ? '' : 's'} of the original vanished from the matte — a badge, banner or secondary item may have been erased`,
      );
    }
    const eroded = components.filter(
      (c) =>
        c.areaFraction >= ERODED_MIN_AREA_FRACTION &&
        c.edgeContact <= VANISHED_MAX_EDGES &&
        c.survival >= ERODED_MIN_SURVIVAL &&
        c.survival < ERODED_MAX_SURVIVAL &&
        // A jar on glossy acrylic loses a full-height mirror reflection, and a low-angle
        // cast shadow can be half a component's ink — both land in this band with a
        // perfect cutout. Neutral ink lost from BELOW what survived is that, not erosion;
        // it stays evidence and the verify door can still pick it up.
        !lostLooksLikeShadow(c),
    );
    if (eroded.length > 0) {
      reasons.push(
        'A substantial element of the original lost about half its pixels — part of the product may have been eaten',
      );
    }
  }

  // The verify sweep's verdict, when one ran: two architectures rarely hallucinate the same
  // mistake, so a low mask-IoU between them is evidence regardless of which one is right.
  if (item.verify && !item.verify.agree) {
    // The record stores the raw model id for auditability; the tooltip is read by people, and
    // every other surface in the product speaks in BG_MODELS labels.
    const label = BG_MODELS[item.verify.model as BgModelId]?.label ?? item.verify.model;
    reasons.push(
      `Second model (${label}) drew a different cutout — the two disagree on what the product is`,
    );
  }

  const regions = item.regionReport ?? [];
  const kept = regions.filter((r) => !r.removed);
  const removedCount = item.removedRegions ?? 0;

  // "Background may not have been removed" is a claim about PIXELS, and the bounding box is
  // the wrong witness for it: a snack packet cropped tight to its own margins fills 98% of the
  // frame by bbox while the matte cut a real 9% of the canvas away (measured on a CRAX packet
  // that wore this flag with a flawless cutout). A matte that truly kept everything leaves
  // essentially the whole canvas opaque, so ask the kept AREA. Reports predating the region
  // analysis carry no areas to sum — those keep the old bbox-only reading rather than being
  // silently cleared.
  const keptArea = kept.reduce((sum, r) => sum + r.area, 0);
  const keptFraction = regions.length ? keptArea / canvasArea : 1;
  if (
    bboxFraction > HUGE_SUBJECT_FRACTION &&
    keptFraction > HUGE_SUBJECT_KEPT_FRACTION &&
    removedCount === 0 &&
    regions.length <= 1
  ) {
    reasons.push('Subject fills the whole frame and nothing was filtered — background may not have been removed');
  }

  const smallFragments = kept.filter((r) => r.area / canvasArea < FRAGMENT_MAX_AREA_FRACTION);
  if (kept.length > MANY_FRAGMENTS && smallFragments.length >= kept.length - 1) {
    reasons.push(`${kept.length} disconnected regions kept — likely leftover background speckle`);
  }

  // The multi-object check is about FRAGMENTATION, not the count of things in frame. Measured
  // on a real 1,000-row batch, region count alone flagged 286 images and the bulk of them were
  // this catalogue's ordinary conventions photographed on purpose: product beside its box, a
  // front-and-back pair, a tube with its applicator. What separates those from a genuinely
  // shredded matte (a packet reduced to its logo and a zigzag) is the SHAPE of the pieces:
  // deliberate compositions are one or two large coherent regions of comparable size, while a
  // failure is either many substantial pieces or one anchor trailed by mid-sized scraps.
  //
  // So a companion only counts against the image inside the scrap band — big enough to be a
  // detached piece or a surviving prop (the coconut chunk, the bean bowl), too small to be a
  // deliberately composed second object. Above the band it reads as composition and passes;
  // below it, the region pass's own speck bar already ate it.
  const substantial = kept.filter((r) => r.area / canvasArea >= SUBSTANTIAL_REGION_FRACTION);
  const anchor = kept.reduce<RegionReport | null>((max, r) => (!max || r.area > max.area ? r : max), null);
  const scraps = anchor
    ? kept.filter(
        (r) =>
          r !== anchor &&
          r.area >= anchor.area * COMPANION_MIN_ANCHOR_FRACTION &&
          r.area < anchor.area * COMPOSED_MIN_ANCHOR_FRACTION,
      )
    : [];
  if (substantial.length >= FRAGMENTED_MIN_PIECES) {
    reasons.push(`${substantial.length} separate pieces kept — the matte may have shattered the product`);
  } else if (scraps.length > 0) {
    reasons.push(
      `${scraps.length + 1} separate objects kept — a scene prop or detached piece may have survived the cutout`,
    );
  }

  // What the ORIGINAL says about those kept pieces. Both rules below answer questions the
  // cutout alone cannot: the region pass sees shapes and has no idea how many things were
  // there to begin with.
  if (substantial.length >= 2) {
    // One element in, several pieces out: the matte punched through a single object. Measured
    // on a battery blister pack — one connected card at 97% survival came back as two regions
    // of comparable size, which every cutout-side rule reads as a composed pair.
    const torn = components.filter((c) => {
      const isBackground =
        c.edgeContact === 4 && c.areaFraction >= FULL_BLEED_MIN_AREA_FRACTION;
      if (isBackground || c.survival < SPLIT_MIN_SURVIVAL) return false;
      // Two objects standing on the same surface are ONE ink component in the original,
      // joined through the shadow they share — a grooming kit's box and trimmer measured
      // exactly that and were read as a torn product. What the component lost says which it
      // was: a neutral loss from underneath is the shadow between them being removed, while
      // a hole punched through a card takes coloured pixels out of the middle (the battery
      // pack lost chroma 15 from ABOVE its surviving centre, the grooming kit chroma 1 from
      // below). Costs the rule any tear whose hole happens to sit low and colourless —
      // accepted, because the alternative false-flags every product photographed beside its
      // box on a shadowed surface.
      if (lostLooksLikeShadow(c)) return false;
      const inside = substantial.filter((r) => {
        const cx = r.bounds.x + r.bounds.w / 2;
        const cy = r.bounds.y + r.bounds.h / 2;
        return (
          cx >= c.bounds.x &&
          cx <= c.bounds.x + c.bounds.w &&
          cy >= c.bounds.y &&
          cy <= c.bounds.y + c.bounds.h
        );
      });
      return inside.length >= 2;
    });
    if (torn.length > 0) {
      reasons.push(
        'One element of the original came back as several separate pieces — the matte may have punched through the product',
      );
    }
    // A second object cut out of a styled scene is a prop, not a composition: this catalogue
    // shoots its deliberate pairs on white, where the original would hold two elements rather
    // than one backdrop. Independent of the survival bar above, which a bhujia pouch beside an
    // oil bottle slipped under at 44% while still keeping both objects.
    if (fullBleed && substantial.length >= SCENE_PROP_MIN_KEPT_REGIONS) {
      reasons.push(
        `${substantial.length} separate objects kept from a full-frame scene — a prop may have survived alongside the product`,
      );
    }
  }

  // Analysis-only runs (Product only OFF) mark would-drop regions instead of deleting them.
  // This is the badge-collage catcher: green marketing circles, floating text columns.
  const flaggedGraphics = kept.filter((r) => r.flagged);
  if (flaggedGraphics.length > 0) {
    reasons.push(
      `${flaggedGraphics.length} region${flaggedGraphics.length === 1 ? '' : 's'} look like graphic overlays (badges/text) — the Product-only filter would drop them`,
    );
  }

  // The filter ran, condemned a region as artwork, and its own guard spared it for being big
  // and central. That guard exists because the same measurements describe a plain white carton
  // beside its bottle, so it must not be relaxed — but a full-height marketing banner passes it
  // too, and until now that came out of the pass looking exactly like product. The one thing
  // that is certain is that the evidence is contested, which is what a flag is for.
  const guarded = kept.filter((r) => r.guarded);
  if (guarded.length > 0) {
    reasons.push(
      `${guarded.length} large region${guarded.length === 1 ? '' : 's'} measure as graphic panels but were kept as possible products — check for a leftover banner`,
    );
  }

  // Palette alone, no geometry vote — the rounded-strip banner the drop rules cannot reach.
  // Only non-anchor regions: the product is entitled to be flat, a second flat thing is not.
  // Skips anything already spoken for above so one banner cannot collect two reasons.
  const suspectedPanels = kept.filter(
    (r) =>
      r !== anchor &&
      !r.guarded &&
      !r.flagged &&
      r.area / canvasArea >= PANEL_MIN_AREA_FRACTION &&
      r.paletteCoverage >= PANEL_MIN_PALETTE_COVERAGE &&
      r.distinctColors > 0 &&
      r.distinctColors <= PANEL_MAX_COLORS,
  );
  if (suspectedPanels.length > 0) {
    reasons.push(
      `${suspectedPanels.length} kept region${suspectedPanels.length === 1 ? '' : 's'} have a flat few-colour palette — likely a marketing panel or banner, not product`,
    );
  }

  // How composited the SOURCE was. See COLLAGE_* above for why the count is size-floored and
  // why the bar sits well clear of the one-or-two-badges pack shot.
  const strippedElements = regions.filter(
    (r) => r.removed && r.area / canvasArea >= COLLAGE_MIN_ELEMENT_FRACTION,
  );
  if (strippedElements.length >= COLLAGE_MIN_REMOVED) {
    reasons.push(
      `${strippedElements.length} separate graphic elements stripped from this shot — a heavily composited source, check for fragments the filter left behind`,
    );
  }

  // Ghosted overlays live below the alpha threshold, invisible to every check above.
  if ((item.cutout.residueFraction ?? 0) >= RESIDUE_MIN_FRACTION) {
    reasons.push('Faint semi-transparent residue outside the subject — ghosted graphics or a leftover shadow');
  }

  // With the filter's protected-companion guard in place (lib/bg/regions.ts), a big CENTRAL
  // region can no longer be dropped — so a removal that still looks like one is evidence of a
  // guard violation: a record from before the guard existed, or a bug. Those must flag. What
  // remains legitimately droppable is edge-hugging panels and badge-sized floaters, and those
  // are the filter's bread and butter — flagging every banner it correctly removed taught
  // people to ignore the flag (a deodorant with two clean panel removals wore a warning while
  // its cutout was perfect). Only a removal bigger than well over half the product still earns
  // a look regardless of where it sat.
  const anchorArea = anchor?.area ?? 0;
  const bigRemoved = regions.filter(
    (r) =>
      r.removed &&
      anchorArea > 0 &&
      r.area / canvasArea >= SUBSTANTIAL_REGION_FRACTION &&
      ((!r.touchesEdge && r.area >= anchorArea * REMOVED_PROTECTED_FRACTION) ||
        r.area >= anchorArea * REMOVED_EXTREME_FRACTION),
  );
  if (bigRemoved.length > 0) {
    reasons.push(
      `${bigRemoved.length} large region${bigRemoved.length === 1 ? '' : 's'} filtered out — check it wasn't part of the product`,
    );
  }

  // Weighted by pixels when the report allows it: counting REGIONS reads seven dust specks
  // exactly like seven product parts, and a clean cutout that shed its specks was arriving
  // flagged for aggressive trimming. Reports old enough to lack removed entries (the count was
  // once all that survived a save) keep the count-based reading rather than silently passing.
  const removedEntries = regions.filter((r) => r.removed);
  if (removedEntries.length > 0) {
    const totalArea = regions.reduce((sum, r) => sum + r.area, 0);
    const removedArea = removedEntries.reduce((sum, r) => sum + r.area, 0);
    if (totalArea > 0 && removedArea / totalArea > HEAVY_REMOVAL_FRACTION) {
      reasons.push(
        `${Math.round((removedArea / totalArea) * 100)}% of detected pixels removed — check the kept product wasn't over-trimmed`,
      );
    }
  } else if (regions.length > 1 && removedCount / regions.length > HEAVY_REMOVAL_FRACTION) {
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

/**
 * Whether this item's evidence is AMBIGUOUS — not bad enough to flag, not clean enough to
 * trust — so the verify sweep should spend a second-model inference on it. Three doors in:
 *
 *  (a) an element's survival sits between the erosion ceiling and the safe zone, where legit
 *      shadow removal and the Ezee foil's eaten underside are numerically indistinguishable;
 *  (b) the residue signature — a colored original whose cutout kept one fused region covering
 *      most-but-not-all of the frame with nothing filtered (the Barbie shape: the region pass
 *      structurally cannot see inside one connected region, but BiRefNet draws its own matte);
 *  (c) coverage sits just above the collapse bar — suspicious, not damning.
 *
 * Pure and cheap like assessQuality (arithmetic over stored fields), so the page can test the
 * whole queue per render. An existing verdict — agree or not — closes the door: the sweep paid
 * for that answer once, and a fresh cutout clears it (see cutOut's patch).
 *
 * This is an AMBIGUITY test only — it does not consult the flag verdict. The sweep composes
 * it with two exclusions of its own: already-flagged items (they route to AI-fix regardless,
 * so a second opinion buys no routing change) and archived items (canRetry — nothing can
 * re-run without original bytes). Shadow-suppressed vanished elements deliberately do NOT
 * route here either: floating-shadow shots are routine, and sending each to BiRefNet would
 * verify half the catalogue.
 */
export function needsVerify(item: BgItem): boolean {
  if (item.status !== 'done' || !item.cutout || !item.cutout.bounds) return false;
  if (item.verify || item.qualityUnknown) return false;
  const ink = item.originalInk;
  if (!ink) return false;
  const { bounds, width, height } = item.cutout;
  const canvasArea = width * height;
  if (canvasArea <= 0) return false;
  const bboxFraction = (bounds.w * bounds.h) / canvasArea;
  const busyOriginal = ink.ink > COLLAPSE_MAX_ORIGINAL_INK;

  // (a) ambiguous erosion on a substantial, mostly-kept, non-frame-spanning element.
  if (!busyOriginal) {
    const components = item.originalComponents ?? [];
    const ambiguous = components.some(
      (c) =>
        c.edgeContact <= VERIFY_MAX_EDGES &&
        c.areaFraction >= VERIFY_MIN_AREA_FRACTION &&
        c.survival >= ERODED_MAX_SURVIVAL &&
        c.survival < VERIFY_MAX_SURVIVAL &&
        // The catalogue's default framing — product standing on white, fused contact shadow
        // — measures 0.8-0.95 here on a PERFECT cutout, so without this the band is not
        // "the uncertain few" but most of the queue, and a 14k run would buy thousands of
        // BiRefNet inferences to confirm shadows. A neutral loss from below is that shadow;
        // waved through only while the loss stays modest.
        !(c.survival >= SHADOW_LOSS_MIN_SURVIVAL && lostLooksLikeShadow(c)),
    );
    if (ambiguous) return true;
  }

  // (b) residue signature. NOT gated on busyOriginal — a wall-to-wall colored background is
  // exactly what produces it (the Barbie original measured busy), and ink is the signal here,
  // not a confounder.
  // "Nothing was filtered" and "one fused region" are claims about REAL regions, and counting
  // raw entries let dust answer them: a rajma pack on a dark floor came back as one fused
  // 2M-pixel region — the residue shape exactly — and was refused a cross-check because five
  // specks of under 0.5k px had been removed and two more kept. Both clauses now count only
  // regions big enough to be something.
  const allRegions = item.regionReport ?? [];
  const kept = allRegions.filter((r) => !r.removed);
  const substantial = (r: RegionReport) => r.area / canvasArea >= SUBSTANTIAL_REGION_FRACTION;
  // A record with a removal count but no report cannot be measured this way; those keep the
  // strict reading rather than being waved through on missing evidence.
  const filteredSomething = allRegions.length
    ? allRegions.some((r) => r.removed && substantial(r))
    : (item.removedRegions ?? 0) > 0;
  if (
    ink.ink > VERIFY_RESIDUE_MIN_INK &&
    bboxFraction >= VERIFY_RESIDUE_MIN_BBOX &&
    bboxFraction <= HUGE_SUBJECT_FRACTION &&
    ink.bbox > 0 &&
    bboxFraction <= VERIFY_RESIDUE_MAX_COVERAGE * ink.bbox &&
    !filteredSomething &&
    kept.filter(substantial).length <= 1
  ) {
    return true;
  }

  // (c) near-collapse: same arithmetic as the collapse check, one band higher — but measured
  // against a footprint the shadows are discounted from. A chocolate bar with a long soft
  // cast shadow running off to one side has an ink bbox stretched well past the product, so
  // an ordinary shot lands in the band and buys an inference for nothing. Where per-component
  // evidence exists, the expected footprint is the union of the components that do NOT read
  // as shadows; a detached shadow ellipse drops out of it by construction.
  if (!busyOriginal && ink.bbox >= COLLAPSE_MIN_ORIGINAL_BBOX) {
    const removedShare =
      (item.regionReport ?? []).reduce((sum, r) => (r.removed ? sum + r.area : sum), 0) /
      canvasArea;
    const expected = (nonShadowFootprint(item) ?? ink.bbox) - removedShare;
    if (expected >= COLLAPSE_MIN_ORIGINAL_BBOX) {
      const ratio = bboxFraction / expected;
      if (ratio >= COLLAPSE_MAX_RATIO && ratio < VERIFY_NEAR_COLLAPSE_RATIO) return true;
    }
  }
  return false;
}

/**
 * The original's footprint with shadow-shaped components left out, as a canvas fraction —
 * the union of the bounds of every component that does not read as a shadow. Null when no
 * component evidence was stored (callers fall back to the raw ink bbox) or when every
 * component reads as a shadow, which says nothing useful.
 */
function nonShadowFootprint(item: BgItem): number | null {
  const components = item.originalComponents ?? [];
  if (!components.length || !item.cutout) return null;
  const solid = components.filter((c) => !looksLikeShadow(c));
  if (!solid.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of solid) {
    if (c.bounds.x < x0) x0 = c.bounds.x;
    if (c.bounds.y < y0) y0 = c.bounds.y;
    if (c.bounds.x + c.bounds.w > x1) x1 = c.bounds.x + c.bounds.w;
    if (c.bounds.y + c.bounds.h > y1) y1 = c.bounds.y + c.bounds.h;
  }
  const canvasArea = item.cutout.width * item.cutout.height;
  if (canvasArea <= 0) return null;
  return ((x1 - x0) * (y1 - y0)) / canvasArea;
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
 * Which tiles the results grid is showing. Single-select on purpose: these are six views of
 * one queue, not facets to intersect. An intersection like "AI-generated AND severe" has no
 * operator behind it — no button in the product acts on that set — and multi-select would also
 * make the chip counts lie, since each count is measured against the whole queue.
 *
 * 'flagged' is any severity, 'flagged-severe' is the `bad` tier only (today: the empty-matte
 * case). 'errored' is a run STATUS, disjoint from the quality verdict — assessQuality returns
 * OK for anything not `done`, so a failed item is never also flagged.
 *
 * 'clean' is the complement operators actually work in: the finished cutouts nothing is wrong
 * with. It is deliberately NOT `!flagged` — that set also holds everything still queued, mid-run
 * or failed, which is why "the ones that came out fine" was previously unreachable from this
 * menu on a queue of thousands.
 */
export const QUEUE_FILTERS = ['all', 'clean', 'flagged', 'flagged-severe', 'ai', 'errored'] as const;

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
/**
 * Finished, has pixels, judged, and judged OK. Same four conditions cleanUnexported seals a
 * batch on, minus the export bookkeeping — this is a view, so an image that already shipped is
 * still a clean image and stays visible under this filter.
 *
 * `status === 'done'` is not redundant beside the verdict: assessQuality answers OK for anything
 * not done, so a queued or mid-run image would otherwise read as clean. `qualityUnknown` rows —
 * restored from a project that predates saved evidence — are excluded for the same reason the
 * seal excludes them: their OK means "nothing was measured", not "nothing is wrong".
 */
function isClean(item: BgItem, verdict: QualityAssessment): boolean {
  return (
    item.status === 'done' &&
    item.cutout !== null &&
    !item.qualityUnknown &&
    verdict.level === 'ok'
  );
}

export function matchesQueueFilter(
  item: BgItem,
  filter: QueueFilter,
  verdict: QualityAssessment,
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'clean':
      return isClean(item, verdict);
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
    'clean': 0,
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
    } else if (isClean(item, verdict)) {
      counts.clean++;
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
