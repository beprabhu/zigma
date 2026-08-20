// Client half of the semantic pass. Renders a finished cutout the way the sidecar's model was
// measured on, asks /api/semantic, and returns a verdict or null.
//
// Everything here is about ONE thing: handing the model the image the 93%-recall evaluation
// handed it. Two documented harness failures came from getting this wrong — feeding the
// side-by-side judging sheet scored 20% (the model named the transparency checkerboard as the
// extra object), and folding a second question into the prompt collapsed it to 12%. So the
// render below is deliberately boring and must stay byte-comparable to that eval: the cutout
// ALONE, alpha composited onto opaque white, longest edge 768, JPEG quality 0.88.

import type { BgCutout, BgSemantic } from './batch';

/** Longest edge handed to the model. Qwen tiles at 28px, so more pixels buy nothing. */
const MAX_EDGE = 768;
/** JPEG quality of the flattened render. Matches the measured eval. */
const QUALITY = 0.88;

/** Whether the optional Qwen sidecar is reachable AND has the vision model pulled. */
export async function probeSemanticSidecar(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch('/api/semantic', { method: 'GET', signal });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Cutout -> the exact image the model was measured on. Transparent pixels become WHITE, not
 * checkerboard and not black: a catalogue reviewer looks at a white page, and the model has no
 * convention that says a checkerboard means "nothing is there".
 */
export async function renderForSemantic(cutout: BgCutout): Promise<Blob> {
  const bitmap = await createImageBitmap(cutout.blob);
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    // Fill first, then composite: drawing the cutout onto a fresh (transparent) canvas and
    // encoding to JPEG would let the encoder pick its own matte colour, which is how a cutout
    // can arrive at the model on a black field.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', QUALITY),
    );
    if (!blob) throw new Error('Could not encode the cutout for the semantic pass');
    return blob;
  } finally {
    bitmap.close();
  }
}

/**
 * Ask the sidecar about one cutout.
 *
 * Returns null for every outcome that is NOT a clean answer — sidecar down, HTTP error, or a
 * response the route could not strictly parse. Null means "no verdict", and callers must leave
 * the item's existing verdict alone rather than recording a clean one: a malformed reply
 * silently becoming "no extras found" is the single failure this pass cannot have.
 */
export async function askSemantic(
  cutout: BgCutout,
  signal?: AbortSignal,
): Promise<BgSemantic | null> {
  const jpeg = await renderForSemantic(cutout);
  const res = await fetch('/api/semantic', {
    method: 'POST',
    body: jpeg,
    headers: { 'Content-Type': 'application/octet-stream' },
    signal,
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    parsed?: boolean;
    extra?: boolean;
    what?: string;
    model?: string;
  };
  if (!body.parsed || typeof body.extra !== 'boolean') return null;
  return {
    model: body.model ?? 'unknown',
    extra: body.extra,
    what: typeof body.what === 'string' ? body.what : '',
  };
}
