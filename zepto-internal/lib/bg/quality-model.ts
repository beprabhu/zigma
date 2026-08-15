// The fitted flag decider. assessQuality's hand-written rules still produce every reason
// string a human reads; this model owns the one bit they were bad at — WHETHER the item is
// worth a human's look. Fitted on 630 hand-audited labels (dataset_v4, 2026-08-15) drawn from
// a real 8,105-item batch; gradient-boosted trees, 5-fold CV held-out: 85% recall / 81%
// precision at the 0.5 threshold vs 80%/84% for the rules alone — the win is that the
// UNFLAGGED pile becomes trustworthy (rules wrongly flagged 36% of genuinely-good cutouts,
// the model 18%).
//
// The model ships as tree JSON + the ~30 lines of arithmetic below. No ONNX, no worker, no
// download: scoring is 100 depth-3 trees over 33 numbers already sitting on the BgItem.
// Training lives outside the repo (~/Documents/sku-compositor/zesku-quality-labels, fitv4.py);
// the feature extraction here MUST stay byte-compatible with feats() there — retrain and
// re-export rather than editing one side.

import type { BgItem } from './batch';
import MODEL from './quality-model-data.json';

/**
 * Flag when the model's bad-probability reaches this. The single tuning knob, chosen off the
 * held-out operating table (fitv4.py): 0.50 → 85% recall / 81% precision; 0.40 → 93%/77%;
 * 0.60 → 79%/84%. Raise it if reviewers report too many clean tiles flagged, lower it if bad
 * cutouts are slipping through unflagged.
 */
export const MODEL_FLAG_THRESHOLD = 0.5;

/** A kept/removed region below 1% of the canvas is a speck for counting purposes — mirrors
 *  SUB in the training pipeline. */
const SUB = 0.01;

/**
 * The 33 features, in the exact order of MODEL.features. Mirrors feats() in fitv4.py: every
 * default (0 for missing regions, survival 1 for missing components) matches what training
 * saw, so an item with sparse evidence scores the same here as its manifest row would there.
 */
function extractFeatures(item: BgItem): number[] | null {
  const cutout = item.cutout;
  if (!cutout || !cutout.bounds) return null;
  const { width, height, bounds } = cutout;
  const canvas = Math.max(1, width * height);

  // The model was fitted exclusively on rows with full quality evidence (qualitySignals
  // batches). A restored project that predates the signals has none of it; scoring those
  // through zero-filled features would be an answer about data the model never saw.
  const regions = item.regionReport;
  const components = item.originalComponents;
  const ink = item.originalInk;
  if (!regions || !components || !ink) return null;

  const bbox = (bounds.w * bounds.h) / canvas;
  const kept = regions.filter((r) => !r.removed);
  const rem = regions.filter((r) => r.removed);
  const keptAreas = kept.map((r) => r.area).sort((a, b) => b - a);
  const anchor = keptAreas.length ? keptAreas[0] / canvas : 0;
  const second = keptAreas.length > 1 ? keptAreas[1] / canvas : 0;
  const anchorRegion = kept.reduce<(typeof kept)[number] | null>(
    (max, r) => (!max || r.area > max.area ? r : max),
    null,
  );
  const comps = [...components].sort((a, b) => b.areaFraction - a.areaFraction);
  const top = comps.length ? comps[0] : null;
  const substantialSurvivals = comps.filter((c) => c.areaFraction >= SUB).map((c) => c.survival);

  const f: Record<string, number> = {
    bbox,
    keptFrac: kept.reduce((sum, r) => sum + r.area, 0) / canvas,
    nKept: kept.length,
    nRem: rem.length,
    nSubKept: kept.filter((r) => r.area / canvas >= SUB).length,
    nSubRem: rem.filter((r) => r.area / canvas >= SUB).length,
    nTinyKept: kept.filter((r) => r.area / canvas < SUB).length,
    anchor,
    second,
    compRatio: anchor ? second / anchor : 0,
    anchorPalette: anchorRegion?.paletteCoverage ?? 0,
    anchorColors: anchorRegion?.distinctColors ?? 0,
    anchorFill: anchorRegion?.fillRatio ?? 0,
    anchorDetail: anchorRegion?.flatness ?? 0,
    maxRemFrac: rem.reduce((max, r) => Math.max(max, r.area / canvas), 0),
    ink: ink.ink,
    inkBbox: ink.bbox,
    coverage: ink.bbox ? bbox / ink.bbox : 0,
    residue: cutout.residueFraction ?? 0,
    nComp: comps.length,
    compMaxArea: top?.areaFraction ?? 0,
    survTop: top?.survival ?? 1,
    survMin: substantialSurvivals.length ? Math.min(...substantialSurvivals) : 1,
    nVanished: comps.filter((c) => c.survival <= 0.1).length,
    edgeTop: top?.edgeContact ?? 0,
    edgeMax: comps.reduce((max, c) => Math.max(max, c.edgeContact), 0),
    chromaTop: top?.chroma ?? 0,
    flatTop: top?.flatness ?? 0,
    gradTop: top?.gradSamples ?? 0,
    lostChroma: top?.lostChroma ?? 0,
    lostBelow: top?.lostBelow ?? 0,
    lostFlat: top?.lostFlatness ?? 0,
    lostGrad: top?.lostGradSamples ?? 0,
  };
  return MODEL.features.map((name) => f[name] ?? 0);
}

/** Walk one CART tree: feature index -2 marks a leaf, `x <= threshold` goes left. */
function treeValue(tree: (typeof MODEL.trees)[number], x: number[]): number {
  let i = 0;
  while (tree.f[i] !== -2) i = x[tree.f[i]] <= tree.t[i] ? tree.l[i] : tree.r[i];
  return tree.v[i];
}

/**
 * Bad-probability in [0,1], or null when the item lacks the stored evidence the model was
 * trained on (no cutout bounds, or a pre-qualitySignals record) — callers fall back to the
 * hand-written rules alone, so old projects keep working unchanged.
 */
export function qualityModelProbability(item: BgItem): number | null {
  const x = extractFeatures(item);
  if (!x) return null;
  let raw = MODEL.init;
  for (const tree of MODEL.trees) raw += MODEL.lr * treeValue(tree, x);
  return 1 / (1 + Math.exp(-raw));
}
