// Subject metrics read off the alpha channel of a cut-out RGBA image: bounding
// box, mask area, density, alpha-weighted centre of mass, bottom-most point and
// the largest empty background rectangle available for a logo.
// Ported from the bg-remover prototype's inline <script> (static/index.html);
// thresholds and the histogram sweep are kept verbatim.
// Self-contained on purpose — nothing here imports from the rest of lib/bg.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface SubjectMetrics {
  // tight bounding box of the subject (alpha > 128)
  bbox: Rect;
  // number of subject pixels
  maskArea: number;
  // maskArea / bbox area (how much of the box is filled), rounded to 4 decimals
  density: number;
  // alpha-weighted centroid of the subject
  centerOfMass: Point;
  // lowest subject pixel (x = midpoint of that row's run)
  bottomMostPoint: Point;
  // largest empty rectangle in the background — the biggest clear area where a
  // logo can be composited; null when none exists.
  logoBox: Rect | null;
}

// Returns null for a fully-empty matte (no pixel above the threshold), which is
// also what keeps centerOfMass out of 0/0 and the bbox out of negative sizes.
export function computeMetrics(pixels: ImageData, w: number, h: number): SubjectMetrics | null {
  const d = pixels.data;
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  let area = 0, sumX = 0, sumY = 0, sumA = 0;
  let bottomY = -1, bottomXmin = 0, bottomXmax = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = d[4 * (y * w + x) + 3];
      if (a > 128) {
        area++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (y > bottomY) { bottomY = y; bottomXmin = x; bottomXmax = x; }
        else if (y === bottomY) { bottomXmax = x; }
      }
      if (a > 0) {
        sumX += x * a; sumY += y * a; sumA += a;
      }
    }
  }
  if (x1 < 0) return null; // empty matte
  // Reaching here means at least one pixel had a > 128, so sumA > 0.
  const bbox: Rect = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  return {
    bbox,
    maskArea: area,
    density: +(area / (bbox.w * bbox.h)).toFixed(4),
    centerOfMass: { x: Math.round(sumX / sumA), y: Math.round(sumY / sumA) },
    bottomMostPoint: { x: Math.round((bottomXmin + bottomXmax) / 2), y: bottomY },
    logoBox: computeLogoBox(pixels, w, h),
  };
}

// Largest axis-aligned rectangle containing only background pixels
// (alpha <= 128). Computed on a downscaled grid via the classic
// "largest rectangle in histogram" sweep, then mapped back.
export function computeLogoBox(pixels: ImageData, w: number, h: number): Rect | null {
  const d = pixels.data;
  const S = Math.max(1, Math.ceil(Math.max(w, h) / 256));
  const gw = Math.floor(w / S), gh = Math.floor(h / S);
  if (gw < 2 || gh < 2) return null;
  // grid cell is "free" only if every underlying pixel is background
  const free = new Uint8Array(gw * gh);
  free.fill(1);
  for (let y = 0; y < gh * S; y++) {
    const gy = Math.floor(y / S);
    for (let x = 0; x < gw * S; x++) {
      if (d[4 * (y * w + x) + 3] > 128) free[gy * gw + Math.floor(x / S)] = 0;
    }
  }
  const heights = new Int32Array(gw);
  let best = { area: 0, x: 0, y: 0, w: 0, h: 0 };
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      heights[gx] = free[gy * gw + gx] ? heights[gx] + 1 : 0;
    }
    // largest rectangle in histogram (stack-based)
    const stack: number[] = [];
    for (let gx = 0; gx <= gw; gx++) {
      const cur = gx < gw ? heights[gx] : 0;
      while (stack.length && heights[stack[stack.length - 1]] >= cur) {
        const th = heights[stack.pop()!];
        const left = stack.length ? stack[stack.length - 1] + 1 : 0;
        const rw = gx - left;
        if (th * rw > best.area) {
          best = { area: th * rw, x: left, y: gy - th + 1, w: rw, h: th };
        }
      }
      stack.push(gx);
    }
  }
  if (best.area === 0) return null;
  return { x: best.x * S, y: best.y * S, w: best.w * S, h: best.h * S };
}
