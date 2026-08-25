// Edge refinement for a background-removal alpha matte: adaptive guided-filter
// matting for hair/fur, curvature smoothing for clean edges, colour-line halo
// correction, shadow flood-cut and colour decontamination.
// Ported from the bg-remover prototype's inline <script> (static/index.html) —
// constants, thresholds, loop bounds and rounding are kept verbatim because the
// numbers are tuned; changing them is a visual regression.

export type RefineMode = 'auto' | 'hair' | 'clean';

export interface RefineOptions {
  // Model that produced the matte. Only RMBG-1.4 ('rmbg') and RMBG-2.0 ('rmbg2')
  // adapt to the subject; every other id keeps the guided-filter + matting path.
  modelId?: string;
  // Overrides hair/fur detection. 'auto' (default) reproduces the prototype.
  mode?: RefineMode;
}

export interface HairFurMetrics {
  fringeRatio: number;
  strandScore: number;
}

export interface RefineResult {
  hairy: boolean;
  // null when detection never ran (non-adaptive model, or an explicit mode).
  hairMetrics: HairFurMetrics | null;
}

// Snaps the model's soft alpha matte to the real image edges. Classic He et al.
// guided filter using the grayscale image as guide, O(n) via box filters
// implemented with summed-area tables.
export function boxFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const out = new Float32Array(src.length);
  // integral image with 1-pixel padding
  const iw = w + 1;
  const sat = new Float64Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += src[y * w + x];
      sat[(y + 1) * iw + (x + 1)] = sat[y * iw + (x + 1)] + rowSum;
    }
  }
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      const area = (y1 - y0 + 1) * (x1 - x0 + 1);
      const sum = sat[(y1 + 1) * iw + (x1 + 1)] - sat[y0 * iw + (x1 + 1)]
                - sat[(y1 + 1) * iw + x0] + sat[y0 * iw + x0];
      out[y * w + x] = sum / area;
    }
  }
  return out;
}

export function guidedFilter(
  guide: Float32Array, alpha: Float32Array, w: number, h: number, r: number, eps: number,
): Float32Array {
  const n = w * h;
  const gg = new Float32Array(n);
  const ga = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    gg[i] = guide[i] * guide[i];
    ga[i] = guide[i] * alpha[i];
  }
  const meanG = boxFilter(guide, w, h, r);
  const meanA = boxFilter(alpha, w, h, r);
  const meanGG = boxFilter(gg, w, h, r);
  const meanGA = boxFilter(ga, w, h, r);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const varG = meanGG[i] - meanG[i] * meanG[i];
    const covGA = meanGA[i] - meanG[i] * meanA[i];
    a[i] = covGA / (varG + eps);
    b[i] = meanA[i] - a[i] * meanG[i];
  }
  const meanAcoef = boxFilter(a, w, h, r);
  const meanBcoef = boxFilter(b, w, h, r);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = meanAcoef[i] * guide[i] + meanBcoef[i];
  }
  return out;
}

// Heuristic hair/fur detector on the raw matte. Hair produces a wide soft
// fringe (many partial-alpha pixels per unit of boundary) and thin strands
// (frequent opaque/transparent alternations along scanlines). Solid-edged
// subjects score low on both.
export function measureHairFur(alpha: Float32Array, w: number, h: number): HairFurMetrics {
  let perimeter = 0, partial = 0, transitions = 0, subjectRows = 0;
  for (let y = 1; y < h - 1; y++) {
    let rowTrans = 0, hasSubject = false, prev = false;
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = alpha[i];
      if (a > 0.1 && a < 0.9) partial++;
      const on = a > 0.5;
      if (on) {
        hasSubject = true;
        if (alpha[i - 1] <= 0.5) perimeter++;
        if (alpha[i + 1] <= 0.5) perimeter++;
        if (alpha[i - w] <= 0.5) perimeter++;
        if (alpha[i + w] <= 0.5) perimeter++;
      }
      if (on !== prev) { rowTrans++; prev = on; }
    }
    if (hasSubject) { subjectRows++; transitions += rowTrans; }
  }
  // Math.max(1, ...) keeps an empty matte at 0 instead of NaN.
  return {
    fringeRatio: partial / Math.max(1, perimeter),
    strandScore: transitions / Math.max(1, subjectRows),
  };
}

function isHairy(m: HairFurMetrics): boolean {
  return m.fringeRatio > 3 || m.strandScore > 6;
}

export function detectHairFur(alpha: Float32Array, w: number, h: number): boolean {
  return isHairy(measureHairFur(alpha, w, h));
}

// Refine mask alpha (RGBA ImageData) in place. For RMBG-1.4 / RMBG-2.0 it adapts
// to the subject:
//  - hair/fur detected: guided filter snaps the matte to real strands and
//    color-line alpha matting removes background spill in the soft fringe.
//  - clean-edged subject: no guided filter (it latches onto texture like
//    fabric weave); instead the outline is curvature-smoothed into a clean
//    anti-aliased contour, ignoring pixel-level imperfections.
// Other models keep the original guided-filter + matting behavior.
export function refineAlpha(
  pixels: ImageData, w: number, h: number, options: RefineOptions = {},
): RefineResult {
  const { modelId, mode = 'auto' } = options;
  const n = w * h;
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) alpha[i] = pixels.data[4 * i + 3] / 255;

  const adaptive = modelId === 'rmbg' || modelId === 'rmbg2';
  let hairMetrics: HairFurMetrics | null = null;
  let hairy: boolean;
  if (mode === 'hair') {
    hairy = true;
  } else if (mode === 'clean') {
    hairy = false;
  } else if (adaptive) {
    hairMetrics = measureHairFur(alpha, w, h);
    hairy = isHairy(hairMetrics);
  } else {
    hairy = true;
  }

  if (hairy) {
    const guide = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = 4 * i;
      guide[i] = (0.299 * pixels.data[p] + 0.587 * pixels.data[p + 1] + 0.114 * pixels.data[p + 2]) / 255;
    }
    // radius scales with image size; eps controls edge sensitivity
    const r = Math.max(2, Math.round(Math.min(w, h) / 256));
    const refined = guidedFilter(guide, alpha, w, h, r, 1e-4);
    // Gentle S-curve around the midpoint: keeps soft strand transitions
    // but removes the guided filter's low-level haze near 0 and 1.
    for (let i = 0; i < n; i++) {
      let t = (refined[i] - 0.15) / 0.7;
      t = Math.max(0, Math.min(1, t));
      refined[i] = t * t * (3 - 2 * t);
    }
    // Alpha matting: re-estimate fringe alpha on the local foreground->
    // background color line. Only ever reduces alpha, and skips pixels
    // where F and B are too similar to tell apart.
    haloCorrect(pixels, refined, w, h);
    for (let i = 0; i < n; i++) {
      pixels.data[4 * i + 3] = Math.round(refined[i] * 255);
    }
  } else {
    // Curvature smoothing: blur + re-sharpen rounds off single-pixel bumps
    // and model jitter along the boundary, producing a smooth contour with
    // a consistent ~2px anti-aliased ramp.
    const sr = Math.max(1, Math.round(Math.min(w, h) / 1024));
    let matte: Float32Array = alpha;
    for (let it = 0; it < 2; it++) {
      matte = boxFilter(matte, w, h, sr);
      for (let i = 0; i < n; i++) {
        let t = (matte[i] - 0.25) / 0.5;
        t = Math.max(0, Math.min(1, t));
        matte[i] = t * t * (3 - 2 * t);
      }
    }
    for (let i = 0; i < n; i++) {
      pixels.data[4 * i + 3] = Math.round(matte[i] * 255);
    }
  }
  decontaminate(pixels, w, h);
  return { hairy, hairMetrics };
}

// Color-line alpha re-estimation for the semi-transparent fringe.
// F = solid-subject color bled outward, B = background color bled inward
// (the RGB of alpha=0 pixels is still the original image). For a fringe
// pixel with color C, its true coverage is the projection of C onto the
// F->B line: t = (C-B)·(F-B)/|F-B|².  alpha = min(alpha, t).
export function haloCorrect(pixels: ImageData, alpha: Float32Array, w: number, h: number): void {
  const d = pixels.data;
  const n = w * h;
  const F = new Float32Array(n * 3), fKnown = new Uint8Array(n);
  const B = new Float32Array(n * 3), bKnown = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = 4 * i;
    if (alpha[i] >= 0.95) {
      fKnown[i] = 1; F[3 * i] = d[p]; F[3 * i + 1] = d[p + 1]; F[3 * i + 2] = d[p + 2];
    } else if (alpha[i] <= 0.02) {
      bKnown[i] = 1; B[3 * i] = d[p]; B[3 * i + 1] = d[p + 1]; B[3 * i + 2] = d[p + 2];
    }
  }
  const bleed = (C: Float32Array, known: Uint8Array, passes: number) => {
    for (let pass = 0; pass < passes; pass++) {
      // `known` is only advanced between passes, so a pixel filled earlier in
      // this pass cannot feed the next one — the bleed stays isotropic.
      const next = known.slice();
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (known[i]) continue;
          let sr = 0, sg = 0, sb = 0, c = 0;
          if (x > 0 && known[i - 1]) { sr += C[3 * (i - 1)]; sg += C[3 * (i - 1) + 1]; sb += C[3 * (i - 1) + 2]; c++; }
          if (x < w - 1 && known[i + 1]) { sr += C[3 * (i + 1)]; sg += C[3 * (i + 1) + 1]; sb += C[3 * (i + 1) + 2]; c++; }
          if (y > 0 && known[i - w]) { sr += C[3 * (i - w)]; sg += C[3 * (i - w) + 1]; sb += C[3 * (i - w) + 2]; c++; }
          if (y < h - 1 && known[i + w]) { sr += C[3 * (i + w)]; sg += C[3 * (i + w) + 1]; sb += C[3 * (i + w) + 2]; c++; }
          if (!c) continue;
          C[3 * i] = sr / c; C[3 * i + 1] = sg / c; C[3 * i + 2] = sb / c;
          next[i] = 1;
        }
      }
      known.set(next);
    }
  };
  bleed(F, fKnown, 8);
  bleed(B, bKnown, 8);
  for (let i = 0; i < n; i++) {
    if (alpha[i] <= 0.02 || alpha[i] >= 0.95) continue;
    if (!fKnown[i] || !bKnown[i]) continue;
    const fr = F[3 * i] - B[3 * i], fg = F[3 * i + 1] - B[3 * i + 1], fb = F[3 * i + 2] - B[3 * i + 2];
    const den = fr * fr + fg * fg + fb * fb;
    if (den < 900) continue; // F ≈ B: ambiguous, trust the model
    const p = 4 * i;
    const cr = d[p] - B[3 * i], cg = d[p + 1] - B[3 * i + 1], cb = d[p + 2] - B[3 * i + 2];
    let t = (cr * fr + cg * fg + cb * fb) / den;
    t = Math.max(0, Math.min(1, t));
    if (t < alpha[i]) alpha[i] = t;
  }
}

// Edge pixels are a physical mix of subject and background color, so even
// with a correct alpha they keep a light rim. Bleed the color of solid
// subject pixels outward into the semi-transparent fringe to remove it.
export function decontaminate(pixels: ImageData, w: number, h: number): void {
  const d = pixels.data;
  const n = w * h;
  const solid = new Uint8Array(n);
  for (let i = 0; i < n; i++) solid[i] = d[4 * i + 3] >= 242 ? 1 : 0;
  const PASSES = 3;
  for (let pass = 0; pass < PASSES; pass++) {
    const nextSolid = solid.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (solid[i] || d[4 * i + 3] === 0) continue;
        // average color of solid 4-neighbours
        let sr = 0, sg = 0, sb = 0, cnt = 0;
        if (x > 0 && solid[i - 1]) { const p = 4 * (i - 1); sr += d[p]; sg += d[p + 1]; sb += d[p + 2]; cnt++; }
        if (x < w - 1 && solid[i + 1]) { const p = 4 * (i + 1); sr += d[p]; sg += d[p + 1]; sb += d[p + 2]; cnt++; }
        if (y > 0 && solid[i - w]) { const p = 4 * (i - w); sr += d[p]; sg += d[p + 1]; sb += d[p + 2]; cnt++; }
        if (y < h - 1 && solid[i + w]) { const p = 4 * (i + w); sr += d[p]; sg += d[p + 1]; sb += d[p + 2]; cnt++; }
        if (cnt === 0) continue;
        const p = 4 * i;
        // Uint8ClampedArray rounds on store — do not pre-round, it shifts the ramp.
        d[p] = sr / cnt;
        d[p + 1] = sg / cnt;
        d[p + 2] = sb / cnt;
        nextSolid[i] = 1;
      }
    }
    solid.set(nextSolid);
  }
}
