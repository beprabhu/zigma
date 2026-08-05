// Edge-panel detection: finds the flat colour strip a catalogue image carries along one edge.
//
// Why this exists alongside the region classifier in regions.ts. That one labels the MATTE's
// connected regions and judges each. It cannot help when the strip touches the product, because
// they then form one component and you cannot drop half a region — measured on a real coriander
// pouch: a single 1130x1200 region at 437 colours, strip fused to product, correctly kept and
// therefore strip included. It also cannot help when the strip's text survives as its own
// regions after the panel goes (letters are flat but not rectangular, so they read as product).
//
// This works on the SOURCE COLOURS instead.
//
// It does NOT scan for "uniform columns", which was the first thing tried and is wrong: measured
// per-column top-4 coverage walking in from the edge, a Keya salt pack (white packaging on white)
// scores 0.95-0.99 across the PRODUCT, while a Santoor strip dips to 0.70 where its large white
// text crosses. The two classes overlap, so no column threshold separates them.
//
// What actually characterises these panels is geometry: each is a large, near-solid RECTANGLE of
// one colour, flush against an image edge, with the product elsewhere. So a colour that paints a
// well-filled rectangle at an edge — and does not reach into the middle of the frame, where the
// product lives — is a panel. Text and badges inside come out with it because the whole bounding
// box is masked, not just the matching pixels.

export interface BandOptions {
  /** A panel may not exceed this share of the frame's width (or height). */
  maxFraction?: number;
  /** Share of its own bounding box a colour must paint to count as a rectangle. */
  minFill?: number;
  /** A vertical panel must span at least this share of the height (horizontal: the width). */
  minSpan?: number;
  /** Ignore colours painting less than this share of the image. */
  minArea?: number;
  /** Alpha above which a pixel counts as kept content. Matches the rest of the pipeline. */
  alphaThreshold?: number;
}

const DEFAULTS: Required<BandOptions> = {
  maxFraction: 0.35,
  // Text inside a panel is a hole in its colour, so the fill of the panel colour alone sits well
  // below 1. Measured on real strips it stays above ~0.6 even with large lettering.
  minFill: 0.55,
  // Full-bleed is the giveaway: these panels run the whole edge. A product's flat-coloured face
  // rarely spans 70% of the frame AND stays out of the middle.
  minSpan: 0.7,
  minArea: 0.004,
  alphaThreshold: 128,
};

// A colour this close to the frame's background IS the background. JPEG noise splits a white
// backdrop across several adjacent bins and only the modal one is excluded by name, so a faint
// #eeffff haze was qualifying as a panel. The margin has to stay tight: a real Brow Perfect strip
// measured #ddeeff, a distance of just 38 from white, so 36 is the widest safe cut.
const BG_MARGIN = 36;

// Colours absorbed into an existing panel still have to paint something. Measured: the dithered
// lower half of a Rice Bran strip fills 0.24 of its box, background haze 0.01.
const ABSORB_FILL = 0.2;

// Stacked blocks may merge only when they tile the edge with at most this gap between them
// (share of the edge length). Without it, two unrelated flush blocks at opposite corners union
// into a fabricated full-span "panel" whose mask deletes the product between them. Measured on
// the coriander strip: 28px of rounded corner between the black panel and the red badge, 2.3%
// of the edge — 3% covers it with room.
const CHAIN_GAP = 0.03;

// The merged box's own painted density. Real strips measure 0.68-0.92 (text holes included);
// a box fabricated from sparse blocks measures ~0.12. This is the post-merge counterpart of
// minFill, which only ever saw one colour at a time.
const MERGED_FILL = 0.45;

// Masked boxes grow by this many pixels on their non-flush sides, to take the anti-aliased
// blend fringe between panel and backdrop with them — those pixels sit between the panel's
// bins and the background bin, so neither test claims them, and they survive as a 1-2px ghost
// outline of the strip.
const EDGE_PAD = 3;

export interface DetectedBand {
  /** Bounding box of the panel, in image pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Share of the box the panel colour paints. */
  fill: number;
  /** Kept pixels the box covered. */
  covered: number;
}

// 4 bits per channel — the same quantisation regions.ts uses. Finer bins let JPEG ringing
// scatter one flat fill across several colours and hide the panel.
const SHIFT = 4;
const BINS = 1 << 12;

function binOf(data: Uint8ClampedArray, p: number): number {
  return ((data[p] >> SHIFT) << 8) | ((data[p + 1] >> SHIFT) << 4) | (data[p + 2] >> SHIFT);
}

/**
 * The frame's background colour, taken as the most common bin around the border. Panels are
 * judged against it: the white margin a product floats on must never read as a panel.
 */
function backgroundBin(data: Uint8ClampedArray, w: number, h: number): number {
  const counts = new Map<number, number>();
  const bump = (i: number) => {
    const b = binOf(data, i * 4);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  };
  for (let x = 0; x < w; x++) {
    bump(x);
    bump((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    bump(y * w);
    bump(y * w + w - 1);
  }
  let best = -1;
  let bestCount = 0;
  for (const [bin, n] of counts) {
    if (n > bestCount) {
      bestCount = n;
      best = bin;
    }
  }
  return best;
}

/**
 * Finds flat-colour panels flush against an edge.
 *
 * Per edge: collect the colours that paint a well-filled, narrow block touching that edge, union
 * them, then judge the union. Order matters — see the note on merging below.
 */
export function detectBands(pixels: ImageData, options: BandOptions = {}): DetectedBand[] {
  const opts = { ...DEFAULTS, ...options };
  const { width: w, height: h, data } = pixels;
  if (w < 8 || h < 8) return [];

  const background = backgroundBin(data, w, h);
  const bgR = ((background >> 8) & 15) * 17;
  const bgG = ((background >> 4) & 15) * 17;
  const bgB = (background & 15) * 17;
  const nearBackground = (bin: number) => {
    const dr = ((bin >> 8) & 15) * 17 - bgR;
    const dg = ((bin >> 4) & 15) * 17 - bgG;
    const db = (bin & 15) * 17 - bgB;
    return dr * dr + dg * dg + db * db < BG_MARGIN * BG_MARGIN;
  };

  const count = new Int32Array(BINS);
  const rim = new Int32Array(BINS);
  const x0 = new Int32Array(BINS);
  const y0 = new Int32Array(BINS);
  const x1 = new Int32Array(BINS);
  const y1 = new Int32Array(BINS);
  const seen: number[] = [];

  const bands: DetectedBand[] = [];

  const scanEdge = (edge: 'left' | 'right' | 'top' | 'bottom') => {
    const vertical = edge === 'left' || edge === 'right';
    const across = vertical ? w : h;
    const along = vertical ? h : w;
    const slab = Math.floor(across * opts.maxFraction);
    if (slab < 4) return;

    const xa = edge === 'right' ? w - slab : 0;
    const xb = edge === 'left' ? slab : w;
    const ya = edge === 'bottom' ? h - slab : 0;
    const yb = edge === 'top' ? slab : h;

    for (const bin of seen) {
      count[bin] = 0;
      rim[bin] = 0;
    }
    seen.length = 0;

    // The innermost row/column of the slab. A colour with substantial contact here likely
    // continues past the slab — the scan clipped it, so its measured width is a truncation of
    // the real one and the narrowness limit below would never see the excess. Substantial is
    // the test, not any: one stray JPEG-noise pixel of the strip's colour on the rim must not
    // void the strip, while a genuinely wider field touches the rim along most of its span.
    const innerRim = vertical ? (edge === 'right' ? xa : xb - 1) : (edge === 'bottom' ? ya : yb - 1);

    for (let y = ya; y < yb; y++) {
      const row = y * w;
      for (let x = xa; x < xb; x++) {
        const bin = binOf(data, (row + x) * 4);
        if (count[bin] === 0) {
          seen.push(bin);
          x0[bin] = x; x1[bin] = x; y0[bin] = y; y1[bin] = y;
        } else {
          if (x < x0[bin]) x0[bin] = x;
          if (x > x1[bin]) x1[bin] = x;
          if (y < y0[bin]) y0[bin] = y;
          if (y > y1[bin]) y1[bin] = y;
        }
        count[bin]++;
        if ((vertical ? x : y) === innerRim) rim[bin]++;
      }
    }

    // A strip need not reach the last column: measured on a Santoor bottle the panel stops 2px
    // short of the frame, and an exact test rejected the whole panel over those 2px.
    const tol = Math.max(2, Math.round(across * 0.01));
    const minAreaPx = opts.minArea * (vertical ? slab * h : slab * w);
    const gapTol = Math.max(2, Math.round(along * CHAIN_GAP));
    const rimLimit = Math.max(4, Math.round(along * 0.05));

    interface Cand { bin: number; x0: number; y0: number; x1: number; y1: number; fill: number }
    const solid: Cand[] = [];
    const loose: Cand[] = [];

    for (const bin of seen) {
      if (count[bin] < minAreaPx || nearBackground(bin)) continue;
      const flush = vertical
        ? edge === 'right' ? x1[bin] >= w - 1 - tol : x0[bin] <= tol
        : edge === 'bottom' ? y1[bin] >= h - 1 - tol : y0[bin] <= tol;
      if (!flush) continue;
      if (rim[bin] > rimLimit) continue;
      const bw = x1[bin] - x0[bin] + 1;
      const bh = y1[bin] - y0[bin] + 1;
      const cand: Cand = { bin, x0: x0[bin], y0: y0[bin], x1: x1[bin], y1: y1[bin], fill: count[bin] / (bw * bh) };
      if (cand.fill >= opts.minFill) solid.push(cand);
      else if (cand.fill >= ABSORB_FILL) loose.push(cand);
    }
    if (!solid.length) return;

    // Merge BEFORE testing span — a panel is often two stacked blocks (the coriander pouch has a
    // black title panel over a red weight badge, 0.68 and 0.29 of the height, so neither clears
    // minSpan alone while together they tile the edge). But only blocks that actually TILE the
    // edge may merge: a bare union over all solids let two unrelated flush badges at opposite
    // corners fabricate a full-span "panel" whose mask deletes the product between them. So the
    // solids are chained along the edge with at most gapTol between neighbours, and the longest
    // chain is the panel hypothesis.
    const start = (c: Cand) => (vertical ? c.y0 : c.x0);
    const end = (c: Cand) => (vertical ? c.y1 : c.x1);
    solid.sort((a, b) => start(a) - start(b));
    let chain: Cand[] = [];
    let best: Cand[] = [];
    let chainEnd = -Infinity;
    const extent = (list: Cand[]) =>
      list.length ? Math.max(...list.map(end)) - Math.min(...list.map(start)) : -1;
    for (const c of solid) {
      if (start(c) > chainEnd + gapTol) {
        if (extent(chain) > extent(best)) best = chain;
        chain = [];
        chainEnd = -Infinity;
      }
      chain.push(c);
      chainEnd = Math.max(chainEnd, end(c));
    }
    if (extent(chain) > extent(best)) best = chain;

    const box = {
      x0: Math.min(...best.map((c) => c.x0)),
      y0: Math.min(...best.map((c) => c.y0)),
      x1: Math.max(...best.map((c) => c.x1)),
      y1: Math.max(...best.map((c) => c.y1)),
    };
    const bins = new Set(best.map((c) => c.bin));

    // Then grow ALONG the edge only, with weaker colours near the box's width — the red lower
    // half of a Rice Bran strip is dithered enough to miss minFill on its own. Containment gets
    // tol of slack per side (a loose block one pixel nearer the frame than the solid one is
    // still the same panel), and abutment counts as adjacency: a composited panel has a hard
    // colour boundary, so the blocks share no row at all. Growing never widens the box across
    // the edge, which is what keeps this safe: on the Keya pack a near-white shade of the
    // product itself is flush and narrow enough to qualify, and absorbing its width would have
    // masked the pack.
    for (let grew = true; grew; ) {
      grew = false;
      for (const c of loose) {
        if (bins.has(c.bin)) continue;
        if (vertical) {
          if (c.x0 < box.x0 - tol || c.x1 > box.x1 + tol) continue;
          if (c.y1 < box.y0 - gapTol || c.y0 > box.y1 + gapTol) continue;
          box.y0 = Math.min(box.y0, c.y0);
          box.y1 = Math.max(box.y1, c.y1);
        } else {
          if (c.y0 < box.y0 - tol || c.y1 > box.y1 + tol) continue;
          if (c.x1 < box.x0 - gapTol || c.x0 > box.x1 + gapTol) continue;
          box.x0 = Math.min(box.x0, c.x0);
          box.x1 = Math.max(box.x1, c.x1);
        }
        bins.add(c.bin);
        grew = true;
      }
    }

    // Take the box out to the frame edge, so the sliver the tolerance allowed goes with it, and
    // pad the other sides so the anti-aliased fringe between panel and backdrop goes too.
    if (edge === 'right') box.x1 = w - 1;
    else if (edge === 'left') box.x0 = 0;
    else if (edge === 'bottom') box.y1 = h - 1;
    else box.y0 = 0;
    if (edge !== 'left') box.x0 = Math.max(0, box.x0 - EDGE_PAD);
    if (edge !== 'right') box.x1 = Math.min(w - 1, box.x1 + EDGE_PAD);
    if (edge !== 'top') box.y0 = Math.max(0, box.y0 - EDGE_PAD);
    if (edge !== 'bottom') box.y1 = Math.min(h - 1, box.y1 + EDGE_PAD);

    const bw = box.x1 - box.x0 + 1;
    const bh = box.y1 - box.y0 + 1;
    if ((vertical ? bh : bw) < along * opts.minSpan) return;
    if ((vertical ? bw : bh) > across * opts.maxFraction) return;

    let painted = 0;
    let covered = 0;
    for (let y = box.y0; y <= box.y1; y++) {
      const row = y * w;
      for (let x = box.x0; x <= box.x1; x++) {
        const p = (row + x) * 4;
        if (bins.has(binOf(data, p))) painted++;
        if (data[p + 3] > opts.alphaThreshold) covered++;
      }
    }
    // The merged box must be dense in its own colours — minFill only ever judged one colour at
    // a time, so this is the test that a chain of blocks really is one panel and not scattered
    // paint. And a panel covering nothing the matte kept changes no pixel.
    if (painted < MERGED_FILL * bw * bh) return;
    if (covered === 0) return;
    bands.push({ x: box.x0, y: box.y0, width: bw, height: bh, fill: painted / (bw * bh), covered });
  };

  for (const edge of ['right', 'left', 'top', 'bottom'] as const) scanEdge(edge);
  return bands;
}

/** Zeroes the alpha inside each panel's box. Returns how many kept pixels were cleared. */
export function maskBands(pixels: ImageData, bands: DetectedBand[], alphaThreshold = 128): number {
  if (!bands.length) return 0;
  const { width: w, height: h, data } = pixels;
  let cleared = 0;

  for (const band of bands) {
    const xEnd = Math.min(w, band.x + band.width);
    const yEnd = Math.min(h, band.y + band.height);
    for (let y = Math.max(0, band.y); y < yEnd; y++) {
      const row = y * w;
      for (let x = Math.max(0, band.x); x < xEnd; x++) {
        const p = (row + x) * 4;
        if (data[p + 3] > alphaThreshold) cleared++;
        data[p + 3] = 0;
      }
    }
  }
  return cleared;
}
