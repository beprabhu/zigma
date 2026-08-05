// Palette (PNG-8) encoder — the only way to hit a file-size budget while staying a .png.
//
// canvas.toBlob('image/png') always emits 32-bit truecolor and exposes no knobs, so reducing a
// PNG below what the browser gives us means encoding it ourselves. Measured on a detailed
// 512x512 cutout: 332 KB from the browser, 57 KB at 256 colours here — and PNG has no lossy
// mode, so shrinking the palette is the only lever short of shrinking the image.
//
// Everything here is pure (no DOM beyond ImageData) so it runs in a worker.

import { crc32 } from '../zip';

export interface Png8Options {
  /** Palette entries, 2..256. Fewer colours means a smaller file and more banding. */
  colors: number;
  /** Floyd-Steinberg error diffusion. Hides banding on gradients; costs time and some size. */
  dither?: boolean;
}

// Histogram precision: 5 bits per channel. Collapses 262k pixels into at most a few thousand
// live buckets, which is what makes median cut fast enough to run several times per image.
const BITS = 3; // shift, i.e. 8 - 5
const AXES = 4;

interface Bucket {
  key: number;
  count: number;
  // Channel sums, for the weighted average that becomes the palette entry.
  sum: [number, number, number, number];
}

interface Box {
  buckets: Bucket[];
  count: number;
  ranges: [number, number, number, number];
}

function buildHistogram(data: Uint8ClampedArray): Bucket[] {
  const map = new Map<number, Bucket>();
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    // Fully transparent pixels carry no colour information — collapsing them into one bucket
    // stops a cutout's large empty margin from eating palette entries. Typically 40-70% of a
    // tile, so this is the single biggest win in the histogram pass.
    const key =
      a === 0
        ? -1
        : ((data[i] >> BITS) << 15) | ((data[i + 1] >> BITS) << 10) | ((data[i + 2] >> BITS) << 5) | (a >> BITS);
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { key, count: 0, sum: [0, 0, 0, 0] };
      map.set(key, bucket);
    }
    bucket.count++;
    if (key !== -1) {
      bucket.sum[0] += data[i];
      bucket.sum[1] += data[i + 1];
      bucket.sum[2] += data[i + 2];
      bucket.sum[3] += a;
    }
  }
  return [...map.values()];
}

function channelOf(bucket: Bucket, axis: number): number {
  return bucket.count ? bucket.sum[axis] / bucket.count : 0;
}

function measure(buckets: Bucket[]): Box {
  const lo = [255, 255, 255, 255];
  const hi = [0, 0, 0, 0];
  let count = 0;
  for (const bucket of buckets) {
    count += bucket.count;
    for (let axis = 0; axis < AXES; axis++) {
      const v = channelOf(bucket, axis);
      if (v < lo[axis]) lo[axis] = v;
      if (v > hi[axis]) hi[axis] = v;
    }
  }
  // Alpha is weighted up: a wrong edge opacity reads as a halo, which is far more visible than
  // a slightly wrong hue.
  const ranges: [number, number, number, number] = [
    hi[0] - lo[0],
    hi[1] - lo[1],
    hi[2] - lo[2],
    (hi[3] - lo[3]) * 1.5,
  ];
  return { buckets, count, ranges };
}

/** Median cut over histogram buckets (not raw pixels) — the reason this is fast. */
function medianCut(buckets: Bucket[], colors: number): Box[] {
  const transparent = buckets.filter((b) => b.key === -1);
  const opaque = buckets.filter((b) => b.key !== -1);
  if (!opaque.length) return transparent.length ? [measure(transparent)] : [];

  // The transparent bucket is reserved as its own palette entry, never merged with a colour.
  const budget = Math.max(1, colors - (transparent.length ? 1 : 0));
  const boxes: Box[] = [measure(opaque)];

  while (boxes.length < budget) {
    let target = -1;
    let widest = 0;
    let axis = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].buckets.length < 2) continue;
      for (let a = 0; a < AXES; a++) {
        // Weight by population so a large flat region gets resolution before a stray highlight.
        const score = boxes[i].ranges[a] * Math.log2(boxes[i].count + 1);
        if (score > widest) {
          widest = score;
          target = i;
          axis = a;
        }
      }
    }
    if (target < 0) break;

    const box = boxes[target];
    const sorted = box.buckets.slice().sort((p, q) => channelOf(p, axis) - channelOf(q, axis));
    // Split at the median by PIXEL count, not bucket count, so both halves carry similar weight.
    const half = box.count / 2;
    let running = 0;
    let split = 0;
    while (split < sorted.length - 1 && running + sorted[split].count <= half) {
      running += sorted[split].count;
      split++;
    }
    if (split === 0) split = 1;
    boxes.splice(target, 1, measure(sorted.slice(0, split)), measure(sorted.slice(split)));
  }

  return transparent.length ? [measure(transparent), ...boxes] : boxes;
}

interface Palette {
  /** RGBA quadruples. */
  entries: [number, number, number, number][];
  /** Histogram key -> palette index, so pixel mapping is a hash lookup rather than a search. */
  lookup: Map<number, number>;
}

function buildPalette(boxes: Box[]): Palette {
  const entries: [number, number, number, number][] = [];
  const lookup = new Map<number, number>();
  boxes.forEach((box, index) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    let n = 0;
    for (const bucket of box.buckets) {
      r += bucket.sum[0];
      g += bucket.sum[1];
      b += bucket.sum[2];
      a += bucket.sum[3];
      n += bucket.count;
      lookup.set(bucket.key, index);
    }
    entries.push(
      n === 0
        ? [0, 0, 0, 0]
        : [Math.round(r / n), Math.round(g / n), Math.round(b / n), Math.round(a / n)],
    );
  });
  // The reserved transparent box has zero colour sums; force it fully clear.
  if (boxes.length && boxes[0].buckets.some((x) => x.key === -1)) entries[0] = [0, 0, 0, 0];
  return { entries, lookup };
}

function nearest(entries: [number, number, number, number][], r: number, g: number, b: number, a: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const da = (e[3] - a) * 1.5;
    // Colour error is invisible where the pixel is transparent, so scale it by opacity.
    const w = a / 255;
    const dr = (e[0] - r) * w;
    const dg = (e[1] - g) * w;
    const db = (e[2] - b) * w;
    const dist = dr * dr + dg * dg + db * db + da * da;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function indexPixels(data: Uint8ClampedArray, palette: Palette, width: number, height: number, dither: boolean): Uint8Array {
  const indices = new Uint8Array(width * height);
  if (!dither) {
    // No search needed: median cut already assigned every histogram bucket to exactly one box.
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const a = data[i + 3];
      const key =
        a === 0
          ? -1
          : ((data[i] >> BITS) << 15) | ((data[i + 1] >> BITS) << 10) | ((data[i + 2] >> BITS) << 5) | (a >> BITS);
      const hit = palette.lookup.get(key);
      indices[p] = hit ?? nearest(palette.entries, data[i], data[i + 1], data[i + 2], a);
    }
    return indices;
  }

  // Floyd-Steinberg: errors are diffused in float space so they do not clip prematurely.
  const work = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) work[i] = data[i];
  const push = (i: number, er: number, eg: number, eb: number, ea: number, f: number) => {
    work[i] += er * f;
    work[i + 1] += eg * f;
    work[i + 2] += eb * f;
    work[i + 3] += ea * f;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = work[i];
      const g = work[i + 1];
      const b = work[i + 2];
      const a = work[i + 3];
      const index = nearest(palette.entries, r, g, b, a);
      indices[y * width + x] = index;
      const e = palette.entries[index];
      const er = r - e[0];
      const eg = g - e[1];
      const eb = b - e[2];
      const ea = a - e[3];
      if (x + 1 < width) push(i + 4, er, eg, eb, ea, 7 / 16);
      if (y + 1 < height) {
        if (x > 0) push(i + (width - 1) * 4, er, eg, eb, ea, 3 / 16);
        push(i + width * 4, er, eg, eb, ea, 5 / 16);
        if (x + 1 < width) push(i + (width + 1) * 4, er, eg, eb, ea, 1 / 16);
      }
    }
  }
  return indices;
}

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  // The CRC covers the type and the data, not the length.
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  // CompressionStream('deflate') emits a zlib stream (RFC 1950), which is exactly what an IDAT
  // holds — 'deflate-raw' would produce an unreadable PNG.
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  // The cast is the SharedArrayBuffer-vs-ArrayBuffer split in lib.dom: this app is cross-origin
  // isolated, so Uint8Array is typed over ArrayBufferLike, but these buffers are always plain.
  void writer.write(bytes as unknown as BufferSource);
  void writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

/**
 * Encodes ImageData as a palette PNG with per-entry transparency.
 * Throws if the runtime lacks CompressionStream — callers fall back to the browser encoder.
 */
export async function encodePng8(pixels: ImageData, opts: Png8Options): Promise<Uint8Array> {
  const { width, height, data } = pixels;
  const colors = Math.max(2, Math.min(256, Math.round(opts.colors)));

  const histogram = buildHistogram(data);
  const boxes = medianCut(histogram, colors);
  if (!boxes.length) throw new Error('Cannot build a palette for an empty image');
  const palette = buildPalette(boxes);
  const indices = indexPixels(data, palette, width, height, opts.dither === true);

  // Ordering the palette by ascending alpha lets tRNS stop at the last non-opaque entry, which
  // usually means a handful of bytes instead of one per colour.
  const order = palette.entries.map((_, i) => i).sort((a, b) => palette.entries[a][3] - palette.entries[b][3]);
  const remap = new Uint8Array(palette.entries.length);
  order.forEach((from, to) => (remap[from] = to));
  const sorted = order.map((i) => palette.entries[i]);
  for (let i = 0; i < indices.length; i++) indices[i] = remap[indices[i]];

  let alphaCount = sorted.length;
  while (alphaCount > 0 && sorted[alphaCount - 1][3] === 255) alphaCount--;

  // Scanlines are prefixed with a filter byte. Filter 0 (None) is standard for palette images:
  // filtering palette *indices* correlates nothing and usually makes the file larger.
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    raw.set(indices.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // colour type: palette
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  const plte = new Uint8Array(sorted.length * 3);
  sorted.forEach((e, i) => {
    plte[i * 3] = e[0];
    plte[i * 3 + 1] = e[1];
    plte[i * 3 + 2] = e[2];
  });

  const parts: Uint8Array[] = [SIGNATURE, chunk('IHDR', ihdr), chunk('PLTE', plte)];
  if (alphaCount > 0) {
    parts.push(chunk('tRNS', new Uint8Array(sorted.slice(0, alphaCount).map((e) => e[3]))));
  }
  parts.push(chunk('IDAT', await deflate(raw)), chunk('IEND', new Uint8Array(0)));

  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

export function isPng8Supported(): boolean {
  return typeof CompressionStream !== 'undefined';
}
