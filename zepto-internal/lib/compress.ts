// The suite's ONE compression path: pngquant + oxipng running locally via /api/compress-local.
// Every product's export funnels through compressPng — change the logic (or the route) here and
// it changes everywhere at once. This file replaced TinyPNG: same job, no API key, no upload.

export interface CompressOptions {
  /** Palette size for quantization; ignored when lossless. */
  colors?: number;
  /** Skip quantization entirely; oxipng squeeze only. */
  lossless?: boolean;
  signal?: AbortSignal;
}

export const COMPRESS_COLOR_CHOICES = [256, 128, 64, 32, 16] as const;
export const COMPRESS_DEFAULT_COLORS = 256;

/** Compresses one PNG. Throws with the server's message on failure — callers decide whether a
 *  failed compression keeps the original bytes (exports do) or marks the item (the compressor
 *  product does). */
export async function compressPng(
  data: Blob | Uint8Array,
  { colors = COMPRESS_DEFAULT_COLORS, lossless = false, signal }: CompressOptions = {},
): Promise<Uint8Array> {
  const body = data instanceof Blob ? data : new Blob([data as BlobPart], { type: 'image/png' });
  const res = await fetch('/api/compress-local', {
    method: 'POST',
    headers: {
      'Content-Type': 'image/png',
      'x-colors': String(colors),
      ...(lossless ? { 'x-lossless': '1' } : {}),
    },
    body,
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string })?.error || `Compression failed (${res.status})`);
  }
  return new Uint8Array(await res.arrayBuffer());
}
