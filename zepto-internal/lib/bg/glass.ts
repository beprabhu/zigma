// Transparency recovery for see-through products (clear cases, glass bottles, blister
// packs, acrylic, PET).
//
// Salient-object models — RMBG-1.4 included — are trained to emit a BINARY object mask.
// They have no output that means "40% covered", so a clear panel resolves one of two ways:
// it reads as background and becomes a hole in the middle of the product, or it reads as
// object and ships with the studio white baked into its RGB, which turns into a white
// smear the moment the cutout lands on a coloured tile. Neither is fixable by threshold
// tuning; the information the matte would need was never in the model's output.
//
// It IS still in the ORIGINAL pixels. A studio shot composites the product over a known,
// near-uniform background:
//
//     C = a*F + (1 - a)*B
//
// with C observed and B measurable from the pixels the matte already cut. For each channel
// the smallest alpha that can explain C with F inside [0, 255] is
//
//     a_c = (B_c - C_c) / B_c            when the pixel is darker than the background
//     a_c = (C_c - B_c) / (255 - B_c)    when it is brighter (speculars, rim highlights)
//
// and a = max over the three channels — the least coverage consistent with every channel.
// Clear plastic barely darkens white, so this lands in the 0.03-0.25 range: exactly the
// soft matte the model cannot produce. The colour is then un-premultiplied, F = (C -
// (1-a)B) / a, which is what stops the recovered glass carrying a white cast onto a dark
// background.
//
// Scope is deliberately narrow, because the same arithmetic applied everywhere would eat
// light-coloured opaque products: only pixels the matte cut AND that are fully enclosed by
// the subject are considered. A genuine gap — a mug handle, the space between a cable and
// its plug — sits at exactly B, scores a ≈ 0, and stays a hole. The method self-selects.

/** Minimum ImageData shape this module needs — keeps it callable off the main thread. */
export interface AlphaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface GlassOptions {
  /**
   * Multiplier on the unmixed alpha. 1 is the physically minimal matte, which reads as
   * almost nothing on a light tile; the default lifts clear plastic to where a human
   * would say "yes, there is a panel there".
   */
  gain?: number;
  /** Alpha below this is sensor noise or JPEG ringing on an empty gap, not glass. */
  floor?: number;
  /** Alpha at or below this counts as "the matte cut this pixel". */
  cutThreshold?: number;
  /**
   * Enclosed area, as a fraction of the frame, below which recovery is skipped. Guards
   * against spending the pass on a few hundred stray interior pixels.
   */
  minAreaFraction?: number;
  /**
   * Largest per-channel spread the sampled background may show and still count as a
   * studio backdrop. A busy or gradient background makes B meaningless and every term
   * above with it.
   */
  maxBackgroundSpread?: number;
}

export interface GlassReport {
  /** Whether the pass ran at all — false when the guards below rejected the image. */
  applied: boolean;
  /** Why it did not run; null when it did. */
  skipped: 'no-background' | 'busy-background' | 'no-enclosed-area' | null;
  /** Estimated background colour, or null when it could not be sampled. */
  background: [number, number, number] | null;
  /** Pixels the matte cut that turned out to be enclosed by the subject. */
  enclosedPixels: number;
  /** Of those, how many came back with a non-zero alpha. */
  recoveredPixels: number;
  /** Mean recovered alpha, 0..1 — a rough "how transparent was it". */
  meanAlpha: number;
}

const DEFAULTS: Required<GlassOptions> = {
  gain: 1.6,
  floor: 0.06,
  cutThreshold: 8,
  minAreaFraction: 0.004,
  maxBackgroundSpread: 26,
};

const EMPTY: GlassReport = {
  applied: false,
  skipped: 'no-background',
  background: null,
  enclosedPixels: 0,
  recoveredPixels: 0,
  meanAlpha: 0,
};

/**
 * Median per channel of the pixels the matte cut. Median rather than mean: a shot with a
 * prop or a reflection still cut by the model would drag a mean off the true backdrop.
 * Returns null when the matte cut too little to sample from.
 */
function sampleBackground(
  img: AlphaImage,
  cutThreshold: number,
): { colour: [number, number, number]; spread: number } | null {
  const { data, width, height } = img;
  const n = width * height;
  // 256-bin histograms per channel — an O(n) median that allocates nothing per pixel.
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let count = 0;
  for (let i = 0; i < n; i++) {
    const p = 4 * i;
    if (data[p + 3] > cutThreshold) continue;
    hist[0][data[p]]++;
    hist[1][data[p + 1]]++;
    hist[2][data[p + 2]]++;
    count++;
  }
  if (count < Math.max(500, n * 0.02)) return null;

  const quantile = (h: Uint32Array, q: number): number => {
    const target = count * q;
    let seen = 0;
    for (let v = 0; v < 256; v++) {
      seen += h[v];
      if (seen >= target) return v;
    }
    return 255;
  };
  const colour: [number, number, number] = [
    quantile(hist[0], 0.5),
    quantile(hist[1], 0.5),
    quantile(hist[2], 0.5),
  ];
  // Interquartile range, not min/max: a handful of outlier pixels (a stray shadow the
  // matte cut, a compression artefact) must not disqualify an otherwise flat backdrop.
  let spread = 0;
  for (let c = 0; c < 3; c++) {
    const iqr = quantile(hist[c], 0.9) - quantile(hist[c], 0.1);
    if (iqr > spread) spread = iqr;
  }
  return { colour, spread };
}

/**
 * Marks every cut pixel reachable from the frame border through other cut pixels. What is
 * left over — cut, but unreachable — is enclosed by the subject, and is the only place
 * this pass is allowed to write.
 *
 * Iterative flood with an explicit stack: a recursive fill overflows on a 4000px frame.
 */
function markOutside(img: AlphaImage, cutThreshold: number): Uint8Array {
  const { data, width: w, height: h } = img;
  const n = w * h;
  const outside = new Uint8Array(n);
  const isCut = (i: number) => data[4 * i + 3] <= cutThreshold;
  const stack: number[] = [];
  const push = (i: number) => {
    if (!outside[i] && isCut(i)) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  return outside;
}

/**
 * Recovers transparent regions in place: pixels the matte cut but that the subject
 * encloses get an unmixed alpha and a background-free colour.
 *
 * MUST run after refineAlpha. refine's decontaminate() treats any partially transparent
 * pixel next to a solid one as a contaminated edge and overwrites its RGB with the solid
 * neighbour's — run in the other order it would paint the recovered glass opaque again.
 * It must also run BEFORE keepProductRegions, so the region analysis sees the glass.
 */
export function recoverTransparency(
  pixels: AlphaImage,
  options: GlassOptions = {},
): GlassReport {
  const { gain, floor, cutThreshold, minAreaFraction, maxBackgroundSpread } = {
    ...DEFAULTS,
    ...options,
  };
  const { data, width: w, height: h } = pixels;
  const n = w * h;
  if (!n) return { ...EMPTY };

  const bg = sampleBackground(pixels, cutThreshold);
  if (!bg) return { ...EMPTY };
  if (bg.spread > maxBackgroundSpread) {
    return { ...EMPTY, skipped: 'busy-background', background: bg.colour };
  }
  const B = bg.colour;

  const outside = markOutside(pixels, cutThreshold);
  let enclosed = 0;
  for (let i = 0; i < n; i++) {
    if (!outside[i] && data[4 * i + 3] <= cutThreshold) enclosed++;
  }
  if (enclosed < Math.max(256, n * minAreaFraction)) {
    return {
      ...EMPTY,
      skipped: 'no-enclosed-area',
      background: B,
      enclosedPixels: enclosed,
    };
  }

  // Precomputed denominators: B_c for the darkening branch, 255 - B_c for the brightening
  // one, floored at 1 so a pure-black or pure-white backdrop cannot divide by zero.
  const darkDen = [Math.max(1, B[0]), Math.max(1, B[1]), Math.max(1, B[2])];
  const liteDen = [Math.max(1, 255 - B[0]), Math.max(1, 255 - B[1]), Math.max(1, 255 - B[2])];

  let recovered = 0;
  let alphaSum = 0;
  for (let i = 0; i < n; i++) {
    if (outside[i]) continue;
    const p = 4 * i;
    if (data[p + 3] > cutThreshold) continue;

    let a = 0;
    for (let c = 0; c < 3; c++) {
      const C = data[p + c];
      const t = C <= B[c] ? (B[c] - C) / darkDen[c] : (C - B[c]) / liteDen[c];
      if (t > a) a = t;
    }
    a = Math.min(1, a * gain);
    if (a < floor) continue; // an actual gap in the product, not glass — leave the hole

    // Un-premultiply: strip the background the camera mixed in, so the recovered panel
    // carries no white onto a dark tile.
    const inv = 1 / a;
    for (let c = 0; c < 3; c++) {
      data[p + c] = (data[p + c] - (1 - a) * B[c]) * inv;
    }
    data[p + 3] = a * 255;
    recovered++;
    alphaSum += a;
  }

  return {
    applied: true,
    skipped: null,
    background: B,
    enclosedPixels: enclosed,
    recoveredPixels: recovered,
    meanAlpha: recovered ? alphaSum / recovered : 0,
  };
}
