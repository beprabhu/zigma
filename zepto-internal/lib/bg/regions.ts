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
  /**
   * The classifier condemned this region as artwork and the protected-companion guard spared
   * it anyway (non-edge and at least a quarter of the anchor). Distinct from `flagged`: that
   * one means "the filter was off and would have dropped this", while this means "the filter
   * was ON and deliberately did not". Both need a human, for opposite reasons — this one is
   * how a kept marketing banner announces itself.
   */
  guarded?: boolean;
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
/** A non-edge region at or above this share of the anchor is protected from the product-only
 *  drop whatever its palette says — see the guard in keepProductRegions. */
const PROTECTED_COMPANION_FRACTION = 0.25;

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

/**
 * Bridged-fragment rescue. A weak matte (RMBG-1.4 on a pale corner against a pale background)
 * can dip below alphaThreshold along a hairline, splitting a small piece of the product into
 * its own region. That fragment then reads as a speck and the filter deletes it, after which
 * floodSubThresholdBand eats the soft corner around it too. The tell that separates it from a
 * real composited badge: a badge is isolated by confidently-cut alpha-0 background, while a
 * broken-off fragment stays tethered to the product through semi-transparent pixels. So a
 * SPECK-dropped region that reaches an originally-kept region within BRIDGE_RADIUS steps of
 * alpha >= BRIDGE_ALPHA is reattached instead of deleted.
 *
 * Speck drops ONLY — never palette/geometry/cluster verdicts. A composited badge overlapping
 * the product's soft halo is tethered exactly like a broken fragment (the halos meet — the
 * band flood's own comments call this configuration out as routine), so connectivity cannot
 * overrule measured artwork evidence; it may only save what was condemned for being small.
 */
const BRIDGE_RADIUS = 4;
/** Band alpha at/above which a pixel can carry a bridge — confident background (0) cannot. */
const BRIDGE_ALPHA = 40;
/** Rescue floor. Matte noise along a soft outline is 2-25px dots that sit inside the product's
 *  halo, so without a floor the bridge rescues every one of them (seen on a white pouch against
 *  white: seven sub-25px specks all came back "kept"). A real broken-off fragment measured
 *  ~400px; anything below this floor stays speck-cleanup's to delete. */
const BRIDGE_MIN_AREA = 64;

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
  /** Band pixels a bridge rescue traversed — barred like a kept region's outline. */
  barred?: Uint8Array | null,
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
      if (barred?.[i]) continue;
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
  // Which drops were size-only verdicts — the only ones the bridge rescue may reconsider.
  const speckFlags = new Array<boolean>(measure.length).fill(false);
  // Which regions measured as artwork but were spared by the protected-companion guard.
  const guardedFlags = new Array<boolean>(measure.length).fill(false);
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
    // Size and placement outrank the graphic evidence for anything big and central. A plain
    // white carton photographed beside its bottle measures EXACTLY like a panel (palette 81%,
    // fill 0.98) and, being flat, loses the richness-weighted anchor race to the smaller but
    // busier product — so the guard above structurally cannot protect it, and the filter was
    // deleting regions LARGER than the one it kept. Genuine overlay panels in this catalogue
    // either hug a frame edge (banners, strips) or stay badge-sized; a region a quarter of the
    // anchor's area floating inside the composition is part of the shot. Measured on a golden
    // run: ten such regions were being deleted (a nose strip, a serum's carton) while all six
    // edge-hugging banners keep qualifying for the drop.
    const protectedCompanion =
      !isAnchor && !acc.edge && acc.area >= anchor.acc.area * PROTECTED_COMPANION_FRACTION;
    dropFlags[i] = !isAnchor && !protectedCompanion && (graphic || speck);
    // The veto is right and the silence was wrong. When the guard saves a region the palette
    // evidence had condemned, that disagreement is the most informative thing the pass knows
    // about the image — and it was being discarded, so a kept marketing banner (measured 99%
    // palette / 12 colours / fill 1.00, a third of the anchor, floating clear of the frame)
    // came out of the filter indistinguishable from product. Recorded here so triage can say
    // "this looks like artwork and was deliberately spared"; nothing about the drop changes.
    guardedFlags[i] = !isAnchor && protectedCompanion && graphic;
    // A speck that ALSO measured graphic is still rescue-eligible: at speck size the palette
    // statistics rest on a handful of stride samples, too little to condemn on.
    speckFlags[i] = !isAnchor && speck;
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

  // ---- Rescue bridged specks (see BRIDGE_* constants). ----
  // Tethers are tested against a SNAPSHOT of the verdicts: a fragment must bridge to a region
  // the classifier itself kept, never to another rescued fragment — chaining would make the
  // outcome depend on region enumeration (raster) order.
  const preRescueDrop = dropFlags.slice();
  // Band pixels a successful bridge traversed. floodSubThresholdBand treats them as barred, or
  // the flood from some other dropped region's halo could sever the very tether that justified
  // the rescue, leaving the fragment a floating island.
  let bridgeBar: Uint8Array | null = null;
  for (let i = 0; i < measure.length; i++) {
    if (!dropFlags[i] || !speckFlags[i]) continue;
    const acc = measure[i].acc;
    if (acc.area < BRIDGE_MIN_AREA) continue;

    // Local BFS in the fragment's padded bounding box: out from the fragment's own pixels,
    // through semi-transparent unlabelled pixels, at most BRIDGE_RADIUS steps.
    const wx0 = Math.max(0, acc.x0 - BRIDGE_RADIUS);
    const wy0 = Math.max(0, acc.y0 - BRIDGE_RADIUS);
    const wx1 = Math.min(w - 1, acc.x1 + BRIDGE_RADIUS);
    const wy1 = Math.min(h - 1, acc.y1 + BRIDGE_RADIUS);
    const ww = wx1 - wx0 + 1;
    const wh = wy1 - wy0 + 1;
    const depth = new Uint8Array(ww * wh).fill(255);
    const queue = new Int32Array(ww * wh);
    let tail = 0;
    for (let y = wy0; y <= wy1; y++) {
      for (let x = wx0; x <= wx1; x++) {
        if (labels[y * w + x] === acc.id) {
          const wi = (y - wy0) * ww + (x - wx0);
          depth[wi] = 0;
          queue[tail++] = wi;
        }
      }
    }
    let bridged = false;
    for (let head = 0; head < tail && !bridged; head++) {
      const wi = queue[head];
      const d = depth[wi];
      if (d >= BRIDGE_RADIUS) continue;
      const wy = (wi / ww) | 0;
      const wx = wi - wy * ww;
      for (let ny = Math.max(0, wy - 1); ny <= Math.min(wh - 1, wy + 1) && !bridged; ny++) {
        for (let nx = Math.max(0, wx - 1); nx <= Math.min(ww - 1, wx + 1); nx++) {
          const wj = ny * ww + nx;
          if (depth[wj] !== 255) continue;
          const j = (wy0 + ny) * w + (wx0 + nx);
          const id = labels[j];
          if (id && id !== acc.id) {
            // Another region: a tether only if the classifier kept it (snapshot, not the
            // live flags — a rescued neighbour must not transitively rescue this one).
            if (!preRescueDrop[id - 1]) {
              bridged = true;
              break;
            }
            depth[wj] = 254; // closed, not passable
            continue;
          }
          if (!id && data[j * 4 + 3] >= BRIDGE_ALPHA) {
            depth[wj] = d + 1;
            queue[tail++] = wj;
          } else {
            depth[wj] = 254;
          }
        }
      }
    }
    if (bridged) {
      dropFlags[i] = false;
      // Everything the BFS stepped through is (a superset of) the tether — bar it all; the
      // window is tiny and over-barring only preserves halo that hugs a kept fragment.
      bridgeBar ??= new Uint8Array(n);
      for (let head = 0; head < tail; head++) {
        const wi = queue[head];
        if (depth[wi] === 0 || depth[wi] === 254) continue;
        const wy = (wi / ww) | 0;
        bridgeBar[(wy0 + wy) * w + (wx0 + (wi - wy * ww))] = 1;
      }
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
      ...(guardedFlags[i] ? { guarded: true as const } : null),
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
      removedPixels += floodSubThresholdBand(data, labels, drop, w, h, alphaThreshold, bridgeBar);
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
/** The original's content footprint, measured before the matte touches anything. */
export interface InkFootprint {
  /** Bounding box of non-background pixels, as a fraction of the canvas. */
  bbox: number;
  /** Non-background pixel count, as a fraction of the canvas. */
  ink: number;
}

/**
 * Measures what the ORIGINAL covers, so quality triage can ask the one question no cutout-side
 * check can answer: is most of the picture simply gone? A set of six transparent glasses came
 * back as one glass — the other five left no regions, no residue, nothing to inspect, because
 * absent objects leave no evidence. The only side that still remembers them is the original.
 *
 * Background is near-white or transparent. Catalogue shots are white-field as a rule, and the
 * check that consumes this is thresholded so a genuinely full-bleed original (ink ~1.0) cannot
 * fire it against a legitimately small product.
 */
export function measureInkFootprint(pixels: ImageData): InkFootprint {
  const { width: w, height: h, data } = pixels;
  const n = w * h;
  if (!n) return { bbox: 0, ink: 0 };
  let minX = w, minY = h, maxX = -1, maxY = -1, ink = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = (row + x) * 4;
      if (data[i + 3] < 32) continue; // transparent = background
      if (data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240) continue; // near-white
      ink++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { bbox: 0, ink: 0 };
  return { bbox: ((maxX - minX + 1) * (maxY - minY + 1)) / n, ink: ink / n };
}

/** One connected piece of the ORIGINAL's ink, with how much of it survived the matte. */
export interface OriginalComponentReport {
  /** Bounding box in the measured coordinate space (the original's, possibly downscaled). */
  bounds: SubjectBounds;
  /** The component's ink pixels as a share of the whole canvas (not of its bbox). */
  areaFraction: number;
  /** Share of this component's ink the PRE-filter matte kept (alpha > threshold). */
  survival: number;
  /**
   * How many distinct frame edges (0-4) the component touches. A COUNT, not a boolean, because
   * the two things that touch edges are opposites: a full-bleed background spans the frame
   * (2-4 edges) while a composited banner merely reaches one — and a vanished banner is
   * exactly what this measurement exists to catch. The distinction stays a quality.ts knob.
   */
  edgeContact: number;
  /** Mean chroma (max−min channel, 0-255) over the component's ORIGINAL pixels. A detached
   *  drop shadow is neutral (~0); a navy badge is saturated. */
  chroma: number;
  /** Mean local luma gradient (0-255, strided sample) over the ORIGINAL pixels. A shadow is
   *  smooth; printed artwork and photography are not. Same measure as RegionReport.flatness. */
  flatness: number;
  /**
   * How many interior texture samples `flatness` rests on. 0 means UNMEASURED, not smooth —
   * a component thinner than the sample stride collects none. Without this the two are
   * indistinguishable and every thin neutral element (a hairline rule, a clear glass's
   * outline — the "one glass of six" case this whole measurement exists for) reads as a
   * perfectly smooth shadow and gets suppressed. The region classifier already refuses to
   * act on unmeasured texture for the same reason; this is that guard's data.
   */
  gradSamples: number;
  /**
   * Mean chroma of the pixels this component LOST — the ones the matte dropped. The scalar
   * survival says how much went; this says what kind of thing went. A grounded product's
   * fused cast shadow and a mirror reflection are neutral (~0-15); an eaten strip of printed
   * packaging is not. 0 when the component lost nothing.
   */
  lostChroma: number;
  /**
   * Where the lost ink sat relative to the kept ink, as a fraction of canvas height:
   * (lost centroid y − kept centroid y) / height. Positive means the loss was BELOW what
   * survived, which is where shadows and reflections live. 0 when nothing was lost or
   * nothing survived.
   */
  lostBelow: number;
  /**
   * Mean local luma gradient over the pixels this component LOST — how textured the removed
   * material was. The whole-component `flatness` cannot answer this: it averages the product's
   * own surface in with the background. A studio backdrop is smooth whatever its tint (a pair
   * of gym gloves on grey seamless measured chroma 1 and a near-flat field), while a wooden
   * floor, a tiled cloth or a printed pattern carries real texture. 0 when nothing was lost.
   */
  lostFlatness: number;
  /** How many interior samples `lostFlatness` rests on. 0 means UNMEASURED, not smooth. */
  lostGradSamples: number;
}

/** Labelled ink components of one original — built once, measured against every attempt. */
export interface InkComponentMap {
  width: number;
  height: number;
  /** Per-pixel component id; 0 = background/no ink. Ids are 1-based indices into components+1. */
  labels: Int32Array;
  /**
   * Per-pixel chroma of the ORIGINAL, kept for ink pixels only. Held here rather than read
   * back off the matte because on the server path the matte's RGB is dead under alpha 0 —
   * the browser's premultiplied canvas zeroes it — and the lost pixels are exactly the ones
   * at alpha 0. The original is the only side that still remembers their colour.
   */
  chroma: Uint8Array;
  /** Per-pixel luma of the ORIGINAL, ink pixels only — same reason as `chroma`: the matte's
   *  RGB is dead under alpha 0 on the server path, which is exactly where lost pixels are. */
  luma: Uint8Array;
  /** Indexed by (label - 1). edges is a bitmask: 1 left, 2 top, 4 right, 8 bottom. */
  components: {
    x0: number; y0: number; x1: number; y1: number;
    area: number; edges: number; chromaSum: number; gradSum: number; gradSamples: number;
  }[];
}

/**
 * Connected-components the ORIGINAL's ink (same definition as measureInkFootprint: visible and
 * not near-white), so survival can be asked per OBJECT instead of per canvas. The coverage-
 * collapse check compares bounding boxes and therefore only notices when most of the picture is
 * gone; the Ezee incident — a navy badge and banner erased inside the matte while the product
 * kept the frame's full extent — moved the bbox ratio not at all. Each composited element is its
 * own ink island on a catalogue field, and an island's survival is measurable exactly.
 *
 * Built from the original alone, ONCE per image, then measured against each matte attempt —
 * the labelling is the expensive half and it never changes between attempts.
 */
export function labelInkComponents(pixels: ImageData): InkComponentMap {
  const { width: w, height: h, data } = pixels;
  const n = w * h;
  const labels = new Int32Array(n);
  const chroma = new Uint8Array(n);
  const luma = new Uint8Array(n);
  const components: InkComponentMap['components'] = [];
  if (!n) return { width: w, height: h, labels, chroma, luma, components };

  // Ink mask first: the flood below then never re-tests colour, only this byte.
  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    if (data[p + 3] < 32) continue; // transparent = background
    if (data[p] > 240 && data[p + 1] > 240 && data[p + 2] > 240) continue; // near-white
    ink[i] = 1;
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const hi = r > g ? (r > b ? r : b) : g > b ? g : b;
    const lo = r < g ? (r < b ? r : b) : g < b ? g : b;
    chroma[i] = hi - lo;
    luma[i] = (r * 0.299 + g * 0.587 + b * 0.114) | 0;
  }

  const stack = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (!ink[start] || labels[start]) continue;
    const id = components.length + 1;
    let top = 0;
    stack[top++] = start;
    labels[start] = id;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0, edges = 0, chromaSum = 0;
    while (top > 0) {
      const i = stack[--top];
      const x = i % w;
      const y = (i / w) | 0;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x === 0) edges |= 1;
      if (y === 0) edges |= 2;
      if (x === w - 1) edges |= 4;
      if (y === h - 1) edges |= 8;
      chromaSum += chroma[i];
      // 4-connectivity, matching the region pass — a diagonal-only "bridge" between two
      // composited elements is JPEG ringing, not a join.
      if (x > 0 && ink[i - 1] && !labels[i - 1]) { labels[i - 1] = id; stack[top++] = i - 1; }
      if (x < w - 1 && ink[i + 1] && !labels[i + 1]) { labels[i + 1] = id; stack[top++] = i + 1; }
      if (y > 0 && ink[i - w] && !labels[i - w]) { labels[i - w] = id; stack[top++] = i - w; }
      if (y < h - 1 && ink[i + w] && !labels[i + w]) { labels[i + w] = id; stack[top++] = i + w; }
    }
    components.push({ x0, y0, x1, y1, area, edges, chromaSum, gradSum: 0, gradSamples: 0 });
  }

  // Texture pass, strided like the region classifier's: a detached drop shadow that the model
  // correctly deletes must be tellable apart from a deleted badge, and the tell is the original
  // pixels — a shadow is neutral AND smooth, artwork is saturated or textured. Chroma came free
  // in the flood above; the gradient needs neighbours, so it samples here.
  //
  // INTERIOR samples only — all three points must carry the same label. A sample straddling
  // the component's boundary measures the jump into the background, and for a small component
  // the perimeter dominates the mean: a perfectly smooth shadow measured ~19 with boundary
  // samples counted (fixture-verified) and 0 without, so the boundary would have defeated the
  // suppression gate for exactly the components it exists to suppress.
  for (let y = 0; y < h - TEXTURE_STRIDE; y += TEXTURE_STRIDE) {
    for (let x = 0; x < w - TEXTURE_STRIDE; x += TEXTURE_STRIDE) {
      const i = y * w + x;
      const id = labels[i];
      if (!id || labels[i + TEXTURE_STRIDE] !== id || labels[i + w * TEXTURE_STRIDE] !== id) {
        continue;
      }
      const p = i * 4;
      const lum = data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;
      const pr = (i + TEXTURE_STRIDE) * 4;
      const pd = (i + w * TEXTURE_STRIDE) * 4;
      const lumR = data[pr] * 0.299 + data[pr + 1] * 0.587 + data[pr + 2] * 0.114;
      const lumD = data[pd] * 0.299 + data[pd + 1] * 0.587 + data[pd + 2] * 0.114;
      const c = components[id - 1];
      c.gradSum += Math.abs(lum - lumR) + Math.abs(lum - lumD);
      c.gradSamples++;
    }
  }
  return { width: w, height: h, labels, chroma, luma, components };
}

/** Number of set bits in the 4-bit edge mask. */
function edgeCount(mask: number): number {
  return (mask & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1) + ((mask >> 3) & 1);
}

/** Floor under which an original component is JPEG noise, not an element worth tracking. */
const COMPONENT_MIN_AREA_FRACTION = 0.002;
/** Report cap: past this many elements the original is a collage and per-element evidence
 *  stops being readable — keep the largest, which are the ones a verdict would ever cite. */
const COMPONENT_MAX_REPORTED = 24;

/**
 * How much of each original component the matte kept. MUST be measured against the PRE-filter
 * matte (the alpha as the model produced it, before detectBands/keepProductRegions delete
 * panels): the product-only filter removes badges DELIBERATELY and evidences them in the region
 * report, so a post-filter measurement would re-report every correct panel drop as a vanished
 * element. Measured pre-filter, a low survival can only mean the MODEL itself erased content —
 * the one event that previously left no evidence on either side.
 */
export function measureComponentSurvival(
  map: InkComponentMap,
  matte: ImageData,
  alphaThreshold = 128,
): OriginalComponentReport[] {
  const { width: w, height: h, labels, chroma, luma, components } = map;
  if (matte.width !== w || matte.height !== h || !components.length) return [];
  const count = components.length;
  const survived = new Int32Array(count);
  // Lost-pixel accumulators. The survival scalar says how MUCH a component lost; these say
  // what KIND of thing it lost, which is the difference between a correctly-dropped cast
  // shadow and a strip of eaten packaging. Neither is inferable from survival alone.
  const lostChromaSum = new Float64Array(count);
  const lostCount = new Int32Array(count);
  const lostYSum = new Float64Array(count);
  const keptYSum = new Float64Array(count);
  const data = matte.data;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const id = labels[i];
    if (!id) continue;
    const k = id - 1;
    const y = (i / w) | 0;
    if (data[i * 4 + 3] > alphaThreshold) {
      survived[k]++;
      keptYSum[k] += y;
    } else {
      lostCount[k]++;
      lostChromaSum[k] += chroma[i];
      lostYSum[k] += y;
    }
  }
  // Texture of what was LOST, strided and interior-only like the whole-component pass: all
  // three sample points must belong to the same component AND all be lost, so the measure
  // never straddles the boundary between kept product and removed background — that jump is
  // the biggest gradient in the image and would make every smooth backdrop look textured.
  const lostGradSum = new Float64Array(count);
  const lostGradSamples = new Int32Array(count);
  const isLost = (i: number) => data[i * 4 + 3] <= alphaThreshold;
  for (let y = 0; y < h - TEXTURE_STRIDE; y += TEXTURE_STRIDE) {
    for (let x = 0; x < w - TEXTURE_STRIDE; x += TEXTURE_STRIDE) {
      const i = y * w + x;
      const id = labels[i];
      if (!id) continue;
      const right = i + TEXTURE_STRIDE;
      const down = i + w * TEXTURE_STRIDE;
      if (labels[right] !== id || labels[down] !== id) continue;
      if (!isLost(i) || !isLost(right) || !isLost(down)) continue;
      const k = id - 1;
      lostGradSum[k] += Math.abs(luma[i] - luma[right]) + Math.abs(luma[i] - luma[down]);
      lostGradSamples[k]++;
    }
  }

  const canvas = n || 1;
  // Rounded HERE, not at save time: every threshold that reads these is a plain <= / <
  // against a value expressible at this precision, so a component measured at 0.5496 live
  // and reloaded as 0.550 would land on the other side of the erosion ceiling — the same
  // image judged differently before and after a save. Quantising at the source makes the
  // live numbers and the persisted ones the same numbers by construction.
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return components
    .map((c, i) => {
      const lost = lostCount[i];
      const kept = survived[i];
      return {
        bounds: { x: c.x0, y: c.y0, w: c.x1 - c.x0 + 1, h: c.y1 - c.y0 + 1 },
        areaFraction: Math.round((c.area / canvas) * 1e4) / 1e4,
        survival: c.area ? r3(kept / c.area) : 0,
        edgeContact: edgeCount(c.edges),
        chroma: c.area ? r1(c.chromaSum / c.area) : 0,
        flatness: c.gradSamples ? r1(c.gradSum / (2 * c.gradSamples)) : 0,
        gradSamples: c.gradSamples,
        lostChroma: lost ? r1(lostChromaSum[i] / lost) : 0,
        lostBelow: lost && kept ? r3((lostYSum[i] / lost - keptYSum[i] / kept) / h) : 0,
        lostFlatness: lostGradSamples[i] ? r1(lostGradSum[i] / (2 * lostGradSamples[i])) : 0,
        lostGradSamples: lostGradSamples[i],
      };
    })
    .filter((c) => c.areaFraction >= COMPONENT_MIN_AREA_FRACTION)
    .sort((a, b) => b.areaFraction - a.areaFraction)
    .slice(0, COMPONENT_MAX_REPORTED);
}

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
