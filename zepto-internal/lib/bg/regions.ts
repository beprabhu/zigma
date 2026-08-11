// "Product only" post-processing: drops flat graphic panels the matte kept as foreground.
//
// The models are trained to keep *salient objects*, and a colour strip or badge composited into
// a catalogue image is genuinely salient — large, high-contrast, sharply bounded. The model is
// not wrong; our definition of "subject" (the physical product) is just narrower. So rather than
// fight the matte, this classifies the connected regions it produced and removes the ones that
// look like vector artwork instead of photography.
//
// Signals, measured on real catalogue JPEGs (see COLOR_SHIFT for the full sweep):
//
//                     product   strip
//   local gradient      5.9      4.1     <- USELESS on its own: white text on a panel makes it
//   top-4 coverage     0.41     0.83        look as "detailed" as a photograph, sometimes more.
//   distinct colours    437      133     <- decisive, together with coverage.
//
//   palette    a vector panel is a handful of exact colours (fill + text), so a few quantised
//              bins cover almost all of it. A photograph spreads across hundreds of bins because
//              of grain and lighting falloff. Colour-independent, so strips of any colour work.
//   flatness   still carried, but as an ALTERNATIVE, not a gate: it is what catches a smooth
//              gradient-filled panel, which has a rich palette but near-zero local variation.
//              Between them the two cover both panel styles; a photograph trips neither.
//   fill ratio only corroborates. It cannot discriminate on its own: a boxed product is itself
//              a rectangle (a real tea carton measured 0.99, same as the strip beside it).
//   ink        freestanding marketing text defeats all of the above per region — a glyph is
//              mostly anti-aliased edge, so it measures like a small photographic fragment.
//              Its tell is repetition: many small blobs sharing one dominant colour (see the
//              text-cluster pass and CLUSTER_* constants).
//
// Deliberately NOT "keep the biggest blob": a combo shot has two disconnected products and that
// rule would eat one. Every decision here is evidence-based per region.
//
// A drop is NOT limited to the pixels that carry the region's label. Components are built only
// from pixels above alphaThreshold, so the 1..alphaThreshold band is invisible to the classifier
// and no drop decision can reach it. Measured on four catalogue images, 13-72% of the pixels that
// survived a drop sat in that band: on a pale strip against white the model is unconfident across
// most of the panel, so the filter deleted the confident core and left a full-shaped ghost. After
// the removal, the drop therefore floods outward through that band (see floodSubThresholdBand),
// stopping at any band pixel adjacent to a KEPT region so the product keeps its own soft outline.

import type { SubjectBounds } from './safe-area';

export interface ProductFilterOptions {
  /** Alpha above which a pixel counts as foreground. Matches subjectBounds(). */
  alphaThreshold?: number;
  /** Mean local gradient (0-255) below which a region reads as smooth/gradient artwork. */
  flatness?: number;
  /** Top-N quantised colours covering at least this share means a flat vector palette. */
  paletteCoverage?: number;
  /** Above this many distinct quantised colours a region is photographic regardless. */
  maxPaletteColors?: number;
  /** Bounding-box fill ratio above which a region reads as a rectangle. */
  rectangularity?: number;
  /** Regions smaller than this fraction of the largest are treated as noise. */
  minAreaFraction?: number;
}

export interface RegionReport {
  bounds: SubjectBounds;
  area: number;
  /** 0-255; low means smooth/vector, high means detailed. */
  flatness: number;
  /** Share of the region covered by its few most common colours; high means vector artwork. */
  paletteCoverage: number;
  distinctColors: number;
  fillRatio: number;
  touchesEdge: boolean;
  /** Most common quantised colour (COLOR_SHIFT-packed rgb; -1 when unmeasured) — the text
   *  cluster rule's grouping key, surfaced so a cluster drop stays auditable. */
  dominantBin: number;
  removed: boolean;
  /** Analysis-only runs (Product only OFF): the classifier would drop this region, but nothing
   *  was deleted. Quality triage flags these; the dialog table shows "kept · graphic?". */
  flagged?: boolean;
}

export interface ProductFilterResult {
  /** How many regions were zeroed out — surfaced in the UI so a heuristic stays auditable. */
  removed: number;
  kept: number;
  removedPixels: number;
  regions: RegionReport[];
}

// Tuned against catalogue images with composited colour strips. A solid or gradient panel sits
// near 0-1; product photography is comfortably above 4 even on smooth packaging.
const DEFAULTS = {
  alphaThreshold: 128,
  flatness: 3,
  // Sits in the gap between the measured extremes above (products <=0.67, panels >=0.83).
  paletteCoverage: 0.75,
  // Products measured 437-610 distinct bins, panels 77-133.
  maxPaletteColors: 250,
  rectangularity: 0.9,
  minAreaFraction: 0.001,
} as const;

/**
 * Right-shift per channel, leaving 4 bits (16 levels). 5 bits was too fine: JPEG ringing around
 * text moves a flat fill's pixels across bin boundaries, which fragmented real strips into
 * 300+ "colours" and hid them. Measured on two real catalogue JPEGs, 4 bits separates cleanly:
 *
 *                       product        strip
 *   Everest    top-4     0.41 / 437     0.83 / 133   (coverage / distinct colours)
 *   Cadbury    top-4     0.67 / 610     0.96 /  77
 */
const COLOR_SHIFT = 4;
/**
 * Coverage at which the palette leads and geometry only has to be consistent with artwork
 * (relaxed fill OR frame contact) rather than prove a rectangle. This bar was originally
 * allowed to stand alone, but the anchor guard protects a single region: in a combo shot the
 * SECOND product has no protection, and flat-lit packaging creeps toward this bar from below
 * (a matte brow pencil measured 0.74; a flat white face goes higher), so palette alone must not
 * delete here. The corroboration has a known cost: several graphics merged into one region
 * leave their shared bounding box mostly empty (a real merged strip+badge measured 0.95
 * coverage / 84 colours at fill 0.70), and such a region now survives unless it touches the
 * frame — a leftover panel, accepted so the filter cannot delete a second product.
 */
const OVERWHELMING_COVERAGE = 0.92;
/**
 * Coverage at which the palette really does stand alone — geometry gets no veto because no
 * measured photograph comes near it. Composited vector fills are exact colours: a round shade
 * badge measured 0.9988 coverage / 5 colours (at fill 0.45 with NO edge contact — geometry
 * would have hidden it), an inset chip 1.0 / 3. Photographs never finish the last percent:
 * grain and lighting falloff leak samples out of the top-4 bins, and the flattest product
 * measured across the verification set stopped at 0.74.
 */
const EXACT_COVERAGE = 0.99;
/** Coverage at which the palette is decisive and geometry only weakly corroborates. */
const STRONG_COVERAGE = 0.88;
/** Fill accepted alongside a decisive palette — matte erosion rounds real corners to ~0.85. */
const RELAXED_RECTANGULARITY = 0.8;
/** The smooth branch's colour ceiling — a gradient panel spreads bins along one axis only,
 *  while smooth photographed packaging measured 437-610 even at 4-bit quantisation. */
const SMOOTH_MAX_COLORS = 250;
/** Past this many distinct colours a region is definitively photographic — stop growing the map. */
const PALETTE_CAP = 1024;
/** How many of the most common colours count towards "a flat palette". */
const TOP_COLORS = 4;

/**
 * Text-cluster gates, tuned on a 48-image sample (3 known text failures + 37 random text-flagged
 * catalogue images + the 8-image tuning set). Candidate = a small kept region whose palette is
 * flat-ish and whose footprint is solid; enough candidates sharing one ink = a headline.
 *
 *   min count 4     the only measured same-ink group of photographic keeps was 3 hollow circle
 *                   outlines (keyasalt); real headlines measured 4-44 glyph blobs per ink.
 *   min fill 0.19   those circle outlines measured fill 0.145-0.153; solid glyphs 0.19-0.8.
 *   coverage>=0.5   anti-aliased letters measured down to 0.51; small photographic fragments
 *                   in the same shots sat lower or keyed to different inks.
 *   colours<=64     letter blobs measured 1-48 bins; photographic fragments 72-354.
 *   area<=6%        the largest measured text piece was 3.8% of the largest region; product
 *                   parts (a second product, a big logo block) sit far above.
 */
const CLUSTER_MIN_COUNT = 4;
const CLUSTER_MIN_FILL = 0.19;
const CLUSTER_COVERAGE = 0.5;
const CLUSTER_MAX_COLORS = 64;
const CLUSTER_MAX_AREA_FRACTION = 0.06;

/** Sample every Nth pixel for the texture measure — full density buys nothing here. */
const TEXTURE_STRIDE = 4;

class UnionFind {
  private parent: Int32Array;
  private size = 1;

  constructor(capacity: number) {
    this.parent = new Int32Array(Math.max(2, capacity));
  }

  make(): number {
    if (this.size >= this.parent.length) {
      const grown = new Int32Array(this.parent.length * 2);
      grown.set(this.parent);
      this.parent = grown;
    }
    const id = this.size++;
    this.parent[id] = id;
    return id;
  }

  find(a: number): number {
    let root = a;
    while (this.parent[root] !== root) root = this.parent[root];
    // Path compression, iterative — regions can be long and thin.
    while (this.parent[a] !== root) {
      const next = this.parent[a];
      this.parent[a] = root;
      a = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

/** Flood states. CLOSED doubles as "already queued", so a pixel can enter the queue only once. */
const BAND_CLOSED = 0;
const BAND_OPEN = 1;
const BAND_SEED = 2;

/**
 * Grows a drop decision through the semi-transparent band the labelling never saw.
 *
 * Runs after the removal pass and reads `labels`, which must still be populated: once the removal
 * has zeroed the dropped pixels, alpha alone can no longer tell a dropped pixel from background.
 *
 * Floods outward from band pixels touching a dropped region and zeroes what it reaches. It never
 * enters a band pixel adjacent to a KEPT region — that ring is the kept product's own anti-aliased
 * outline, and eating it wherever the two halos meet leaves the cutout looking scissor-cut. The
 * barrier is a static property of a pixel, so it is evaluated once, before the flood starts.
 *
 * Returns the number of pixels it zeroed.
 */
function floodSubThresholdBand(
  data: Uint8ClampedArray,
  labels: Int32Array,
  drop: Uint8Array,
  w: number,
  h: number,
  alphaThreshold: number,
): number {
  const n = w * h;
  // A byte per pixel rather than a visited set: the band can be most of the image, and the flood
  // must never re-test a pixel it has already resolved or the walk stops being linear.
  const band = new Uint8Array(n);
  let eligible = 0;
  let seeds = 0;

  // ---- Classify the band and apply the barrier: one 8-neighbour scan per band pixel. ----
  for (let y = 0; y < h; y++) {
    const yTop = y > 0 ? y - 1 : 0;
    const yBottom = y < h - 1 ? y + 1 : h - 1;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (labels[i]) continue;
      const alpha = data[i * 4 + 3];
      if (alpha === 0 || alpha > alphaThreshold) continue;

      const xLeft = x > 0 ? x - 1 : 0;
      const xRight = x < w - 1 ? x + 1 : w - 1;
      let nearKept = false;
      let nearDropped = false;
      for (let ny = yTop; ny <= yBottom && !nearKept; ny++) {
        const nRow = ny * w;
        for (let nx = xLeft; nx <= xRight; nx++) {
          const id = labels[nRow + nx];
          if (!id) continue;
          if (!drop[id]) {
            nearKept = true;
            break;
          }
          nearDropped = true;
        }
      }
      if (nearKept) continue;

      band[i] = nearDropped ? BAND_SEED : BAND_OPEN;
      eligible++;
      if (nearDropped) seeds++;
    }
  }
  if (!seeds) return 0;

  // Explicit index queue, never recursion: these are megapixel images and a recursive flood
  // through a long band would overflow the stack. Each eligible pixel closes as it is queued, so
  // `eligible` is an exact bound on how many indices the queue can ever hold.
  const queue = new Int32Array(eligible);
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (band[i] === BAND_SEED) {
      band[i] = BAND_CLOSED;
      queue[tail++] = i;
    }
  }

  let cleared = 0;
  for (let head = 0; head < tail; head++) {
    const i = queue[head];
    data[i * 4 + 3] = 0;
    cleared++;

    const y = (i / w) | 0;
    const x = i - y * w;
    const yTop = y > 0 ? y - 1 : 0;
    const yBottom = y < h - 1 ? y + 1 : h - 1;
    const xLeft = x > 0 ? x - 1 : 0;
    const xRight = x < w - 1 ? x + 1 : w - 1;
    for (let ny = yTop; ny <= yBottom; ny++) {
      const nRow = ny * w;
      for (let nx = xLeft; nx <= xRight; nx++) {
        const j = nRow + nx;
        // Everything still open is an unblocked band pixel — barred, unlabelled-opaque and
        // already-queued pixels all closed before the walk reached here.
        if (band[j] === BAND_CLOSED) continue;
        band[j] = BAND_CLOSED;
        queue[tail++] = j;
      }
    }
  }
  return cleared;
}

/**
 * Zeroes the alpha of regions that look like graphic artwork rather than product photography.
 * Mutates pixels.data in place, like refineAlpha, and returns what it did.
 *
 * Only separates regions the matte left DISCONNECTED. A strip physically touching the product
 * merges into one region and cannot be split this way — that case needs the model retrained, or
 * pixel-level rectangle detection.
 */
export function keepProductRegions(
  pixels: ImageData,
  options: ProductFilterOptions = {},
): ProductFilterResult {
  const { alphaThreshold, flatness, paletteCoverage, maxPaletteColors, rectangularity, minAreaFraction } =
    { ...DEFAULTS, ...options };
  const w = pixels.width;
  const h = pixels.height;
  const n = w * h;
  const data = pixels.data;
  if (n === 0) return { removed: 0, kept: 0, removedPixels: 0, regions: [] };

  // ---- Pass 1: provisional labels, 8-connected, union-find over the two rows in play. ----
  const labels = new Int32Array(n);
  const uf = new UnionFind(1024);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (data[i * 4 + 3] <= alphaThreshold) continue;

      // Already-scanned 8-neighbours: W, NW, N, NE. Read into locals rather than an array —
      // this runs once per foreground pixel, so a per-pixel allocation would dominate.
      const nW = x > 0 ? labels[i - 1] : 0;
      const nNW = y > 0 && x > 0 ? labels[i - w - 1] : 0;
      const nN = y > 0 ? labels[i - w] : 0;
      const nNE = y > 0 && x < w - 1 ? labels[i - w + 1] : 0;

      let min = 0;
      if (nW && (min === 0 || nW < min)) min = nW;
      if (nNW && (min === 0 || nNW < min)) min = nNW;
      if (nN && (min === 0 || nN < min)) min = nN;
      if (nNE && (min === 0 || nNE < min)) min = nNE;

      if (min === 0) {
        labels[i] = uf.make();
      } else {
        labels[i] = min;
        // Every labelled neighbour joins this pixel's class, which is what merges the
        // provisional labels a U-shaped region picks up on its two arms.
        if (nW) uf.union(min, nW);
        if (nNW) uf.union(min, nNW);
        if (nN) uf.union(min, nN);
        if (nNE) uf.union(min, nNE);
      }
    }
  }

  // ---- Pass 2: resolve to dense ids and accumulate per-region statistics. ----
  interface Acc {
    id: number;
    area: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    gradSum: number;
    gradCount: number;
    edge: boolean;
    /** Quantised colour histogram, capped — presence of the cap alone proves "photographic". */
    palette: Map<number, number>;
    paletteSamples: number;
    paletteSaturated: boolean;
  }
  const dense = new Map<number, Acc>();
  const accs: Acc[] = [];

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const raw = labels[i];
      if (!raw) continue;
      const root = uf.find(raw);
      let acc = dense.get(root);
      if (!acc) {
        acc = {
          id: accs.length + 1, area: 0, x0: x, y0: y, x1: x, y1: y,
          gradSum: 0, gradCount: 0, edge: false,
          palette: new Map(), paletteSamples: 0, paletteSaturated: false,
        };
        dense.set(root, acc);
        accs.push(acc);
      }
      labels[i] = acc.id;

      acc.area++;
      if (x < acc.x0) acc.x0 = x;
      if (x > acc.x1) acc.x1 = x;
      if (y < acc.y0) acc.y0 = y;
      if (y > acc.y1) acc.y1 = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) acc.edge = true;

      // Texture: mean absolute luma difference to the right/below neighbour, sampled sparsely.
      // Only between two foreground pixels — measuring against transparent background would read
      // the cutout's own outline as "detail" and make every region look photographic.
      if ((x & (TEXTURE_STRIDE - 1)) === 0 && (y & (TEXTURE_STRIDE - 1)) === 0) {
        const p = i * 4;
        acc.paletteSamples++;
        if (!acc.paletteSaturated) {
          // 4 bits per channel packed into 12 — must match COLOR_SHIFT or bins would collide.
          const key =
            ((data[p] >> COLOR_SHIFT) << 8) |
            ((data[p + 1] >> COLOR_SHIFT) << 4) |
            (data[p + 2] >> COLOR_SHIFT);
          const seen = acc.palette.get(key);
          if (seen !== undefined) acc.palette.set(key, seen + 1);
          else if (acc.palette.size < PALETTE_CAP) acc.palette.set(key, 1);
          else acc.paletteSaturated = true;
        }
        const luma = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
        if (x + 1 < w && data[p + 7] > alphaThreshold) {
          const q = p + 4;
          acc.gradSum += Math.abs(luma - (0.299 * data[q] + 0.587 * data[q + 1] + 0.114 * data[q + 2]));
          acc.gradCount++;
        }
        if (y + 1 < h && data[(i + w) * 4 + 3] > alphaThreshold) {
          const q = (i + w) * 4;
          acc.gradSum += Math.abs(luma - (0.299 * data[q] + 0.587 * data[q + 1] + 0.114 * data[q + 2]));
          acc.gradCount++;
        }
      }
    }
  }

  if (!accs.length) return { removed: 0, kept: 0, removedPixels: 0, regions: [] };

  // ---- Classify. ----
  const largest = accs.reduce((m, a) => (a.area > m.area ? a : m), accs[0]);
  const measure = accs.map((a) => {
    const bw = a.x1 - a.x0 + 1;
    const bh = a.y1 - a.y0 + 1;
    // Saturating the cap is itself proof of a photographic palette, so score it as fully rich.
    let coverage = 0;
    let dominantBin = -1;
    if (!a.paletteSaturated && a.paletteSamples > 0) {
      const counts = [...a.palette.values()].sort((p, q) => q - p);
      let top = 0;
      for (let k = 0; k < Math.min(TOP_COLORS, counts.length); k++) top += counts[k];
      coverage = top / a.paletteSamples;
      let bestN = 0;
      for (const [key, n] of a.palette) {
        if (n > bestN) {
          bestN = n;
          dominantBin = key;
        }
      }
    }
    return {
      acc: a,
      fillRatio: bw > 0 && bh > 0 ? a.area / (bw * bh) : 0,
      grad: a.gradCount ? a.gradSum / a.gradCount : 0,
      coverage,
      colors: a.paletteSaturated ? PALETTE_CAP : a.palette.size,
      dominantBin,
    };
  });

  // The most product-like region is never dropped, so the filter can never return an empty
  // cutout — a wrong guess costs a leftover panel, never the product itself.
  // Score by area weighted by how photographic the region looks. Colour richness, not local
  // gradient: text on a flat panel inflates the gradient above a real photograph's.
  const richness = (m: (typeof measure)[number]) => Math.max(1 - m.coverage, 0.05);
  let anchor = measure[0];
  for (const m of measure) {
    if (m.acc.area * richness(m) > anchor.acc.area * richness(anchor)) anchor = m;
  }

  const dropFlags = new Array<boolean>(measure.length).fill(false);
  for (let i = 0; i < measure.length; i++) {
    const m = measure[i];
    const { acc, fillRatio, grad, coverage, colors } = m;
    // TEXTURE_STRIDE means a region can carry very few samples, or none at all, and both
    // statistics go degenerate there instead of going missing: coverage is the top-TOP_COLORS
    // share, so at most TOP_COLORS samples make it exactly 1.0 whatever the pixels hold, and a
    // region no sample landed on reports grad 0. A drop must rest on a measurement that was
    // actually taken, so the branches reading those numbers stay off until enough samples exist.
    const measuredPalette = acc.paletteSamples > TOP_COLORS;
    const measuredGrad = acc.gradCount > 0;
    // Palette leads; geometry corroborates. Measured on a real matte, a badge came out at
    // coverage 0.94 but fill 0.86 with NO edge contact — the model erodes rounded corners, so
    // real graphic regions land at 0.8-0.9 fill and often sit inside a layout margin. A hard
    // fill>0.9-or-edge gate kept exactly the elements users saw survive.
    const flatPalette = measuredPalette && coverage >= paletteCoverage && colors <= maxPaletteColors;
    const decisivePalette = measuredPalette && coverage >= STRONG_COVERAGE && colors <= maxPaletteColors;
    const overwhelmingPalette =
      measuredPalette && coverage >= OVERWHELMING_COVERAGE && colors <= maxPaletteColors;
    // A gradient-filled panel has a wider palette but almost no local variation. The colour cap
    // is what keeps smooth PHOTOGRAPHED packaging safe on its own evidence rather than by anchor
    // privilege: a real pouch measured grad 1.5 (smoother than the threshold!) but 1122 colours.
    const smooth = measuredGrad && grad < flatness && colors <= SMOOTH_MAX_COLORS;
    const isAnchor = m === anchor;
    const speck = acc.area < largest.area * minAreaFraction;
    // The anchor rule protects one region only, so the second product in a combo shot must
    // survive on evidence. Below EXACT_COVERAGE an overwhelming palette is still within reach
    // of flat-lit packaging, so geometry has to corroborate — the region must at least be
    // shaped like composited artwork (rectangle-ish footprint, or flush against the frame the
    // way a strip is) before palette evidence may delete it.
    const graphic =
      (overwhelmingPalette &&
        (coverage >= EXACT_COVERAGE || fillRatio > RELAXED_RECTANGULARITY || acc.edge)) ||
      (decisivePalette && fillRatio > RELAXED_RECTANGULARITY) ||
      (flatPalette && fillRatio > rectangularity) ||
      (smooth && fillRatio > rectangularity);
    dropFlags[i] = !isAnchor && (graphic || speck);
  }

  // ---- Text clusters. ----
  // A headline the matte kept is many separate glyph blobs, and each one alone defeats the
  // region tests above: a letter is mostly anti-aliased edge, so its top-4 coverage measures
  // 0.51-0.83 (below every panel bar) and its bounding-box fill 0.2-0.8 (below every rectangle
  // bar) — statistically the same as a small photographic fragment, which is why no per-region
  // threshold can take it. What a photograph cannot fake is REPETITION: every glyph of one
  // headline carries the same solid ink, so its dominant quantised colour repeats across blobs,
  // while measured photographic fragments in the same shot (chip crumbs, garnish) each keyed to
  // a different bin. JPEG shifts a glyph's ink by one level at 4-bit quantisation (909 vs 910
  // was measured within one headline), so bins one step apart per channel count as one ink.
  const clusterCandidates: number[] = [];
  for (let i = 0; i < measure.length; i++) {
    const m = measure[i];
    if (dropFlags[i] || m === anchor) continue;
    if (m.acc.paletteSamples <= TOP_COLORS || m.dominantBin < 0) continue;
    if (m.acc.area > largest.area * CLUSTER_MAX_AREA_FRACTION) continue;
    if (m.coverage < CLUSTER_COVERAGE || m.colors > CLUSTER_MAX_COLORS) continue;
    if (m.fillRatio < CLUSTER_MIN_FILL) continue;
    clusterCandidates.push(i);
  }
  if (clusterCandidates.length >= CLUSTER_MIN_COUNT) {
    const bins = [...new Set(clusterCandidates.map((i) => measure[i].dominantBin))];
    const parent = new Map<number, number>(bins.map((b) => [b, b]));
    const find = (b: number): number => {
      let root = b;
      while (parent.get(root)! !== root) root = parent.get(root)!;
      return root;
    };
    const oneInk = (a: number, b: number) =>
      Math.abs((a >> 8) - (b >> 8)) <= 1 &&
      Math.abs(((a >> 4) & 15) - ((b >> 4) & 15)) <= 1 &&
      Math.abs((a & 15) - (b & 15)) <= 1;
    for (let i = 0; i < bins.length; i++) {
      for (let j = i + 1; j < bins.length; j++) {
        if (oneInk(bins[i], bins[j])) parent.set(find(bins[j]), find(bins[i]));
      }
    }
    const inkCounts = new Map<number, number>();
    for (const i of clusterCandidates) {
      const ink = find(measure[i].dominantBin);
      inkCounts.set(ink, (inkCounts.get(ink) ?? 0) + 1);
    }
    for (const i of clusterCandidates) {
      if (inkCounts.get(find(measure[i].dominantBin))! >= CLUSTER_MIN_COUNT) dropFlags[i] = true;
    }
  }

  const drop = new Uint8Array(accs.length + 1);
  let removed = 0;
  let removedPixels = 0;
  const regions: RegionReport[] = [];
  for (let i = 0; i < measure.length; i++) {
    const { acc, fillRatio, grad, coverage, colors, dominantBin } = measure[i];
    if (dropFlags[i]) {
      drop[acc.id] = 1;
      removed++;
      removedPixels += acc.area;
    }
    regions.push({
      bounds: { x: acc.x0, y: acc.y0, w: acc.x1 - acc.x0 + 1, h: acc.y1 - acc.y0 + 1 },
      area: acc.area,
      flatness: grad,
      paletteCoverage: coverage,
      distinctColors: colors,
      fillRatio,
      touchesEdge: acc.edge,
      dominantBin,
      removed: dropFlags[i],
    });
  }

  // ---- Apply. ----
  if (removed) {
    for (let i = 0; i < n; i++) {
      const id = labels[i];
      if (id && drop[id]) data[i * 4 + 3] = 0;
    }
    // The flood needs a kept region to stop against; with nothing kept it would have no barrier
    // anywhere. The anchor rule makes that unreachable, so this only keeps the walk bounded by
    // construction rather than by an invariant proved elsewhere.
    if (removed < accs.length) {
      removedPixels += floodSubThresholdBand(data, labels, drop, w, h, alphaThreshold);
    }
  }

  return { removed, kept: accs.length - removed, removedPixels, regions };
}

/**
 * The classifier as a pure REPORTER: identical verdicts to keepProductRegions, zero deletions.
 * Runs on a throwaway copy of the pixels so the cutout is untouched; would-drop regions come
 * back as kept-but-flagged. This is what keeps quality triage awake when the Product-only
 * filter is off — before this, regionReport simply didn't exist and every multi-object check
 * in lib/bg/quality.ts silently passed (which is how badge collages sailed through unflagged).
 */
export function analyzeRegions(
  pixels: ImageData,
  options: ProductFilterOptions = {},
): RegionReport[] {
  const probe = new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
  const result = keepProductRegions(probe, options);
  return result.regions.map((r) => (r.removed ? { ...r, removed: false, flagged: true } : r));
}

/**
 * Share of the canvas covered by FAINT pixels (alpha in (low, high)) outside the padded subject
 * bbox — the signature of ghosted overlay graphics the matte half-erased (semi-transparent
 * icons, watermarks) or a stray soft shadow. Pixels in this band are invisible to both the
 * bbox scan and the region classifier (both gate on alpha > high), so nothing else can see them.
 */
export function measureFaintResidue(
  pixels: ImageData,
  bounds: SubjectBounds | null,
  opts: { low?: number; high?: number; pad?: number } = {},
): number {
  const { low = 16, high = 128, pad = 4 } = opts;
  const { width: w, height: h, data } = pixels;
  const n = w * h;
  if (!n) return 0;
  const bx0 = bounds ? Math.max(0, bounds.x - pad) : 0;
  const by0 = bounds ? Math.max(0, bounds.y - pad) : 0;
  const bx1 = bounds ? Math.min(w, bounds.x + bounds.w + pad) : 0;
  const by1 = bounds ? Math.min(h, bounds.y + bounds.h + pad) : 0;
  let count = 0;
  for (let y = 0; y < h; y++) {
    const insideY = bounds !== null && y >= by0 && y < by1;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (insideY && x >= bx0 && x < bx1) continue;
      const a = data[(row + x) * 4 + 3];
      if (a > low && a < high) count++;
    }
  }
  return count / n;
}
