'use client';

// Compress's queue row, and the two pure functions that read it.
//
// Lifted out of app/png-compressor/page.tsx when the file store landed: the codec in
// lib/files/codecs/png.ts has to build and rebuild these, and a type living inside a page
// component cannot be imported without dragging the page in with it.

export type PngStatus = 'queued' | 'working' | 'done' | 'error';

export interface PngItem {
  id: string;
  /** The source file's name — what the row shows and what names the download. */
  name: string;
  /** The source's byte count, kept separately because the source itself may be gone. */
  inputSize: number;
  /**
   * The dropped file, or null for a row restored from disk.
   *
   * Null is the honest answer rather than an inconvenience. Inputs are deliberately NOT persisted:
   * they are sitting on the user's disk, re-dropping them costs a drag, and writing every original
   * would double what this tool occupies in a store now shared by four products (the rule
   * lib/bg/autosave.ts:9-10 set, applied here). What IS worth keeping is the compressed output —
   * that took a pngquant + oxipng round trip to produce.
   *
   * Everything that needs the bytes therefore has to check: a restored row can be downloaded,
   * exported and measured, but not re-compressed at different settings until it is re-dropped.
   */
  file: File | null;
  /** Object URL for the thumbnail. Minted by whoever creates the row; revoked on unmount. */
  previewUrl: string;
  status: PngStatus;
  output?: Blob;
  outputUrl?: string;
  error?: string;
}

/** `photo.png` -> `photo-tiny.png`. The name the compressed copy downloads under. */
export function tinyName(name: string): string {
  return name.replace(/\.png$/i, '') + '-tiny.png';
}

export function savingsPct(input: number, output: number): number {
  return input ? Math.round((100 * (input - output)) / input) : 0;
}

/** Hands back both object URLs a row may hold. Safe to call on a row that has neither. */
export function releasePngItem(item: PngItem): void {
  if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  if (item.outputUrl) URL.revokeObjectURL(item.outputUrl);
}

/**
 * Where a row that was mid-run has to come back.
 *
 * Compress does not use restingStatus (lib/session-store.ts): that helper rests at 'ready', a word
 * this product's status union does not contain, and its resting state is anyway fully determined —
 * an output means done, and no output means queued, whatever the row claimed when the tab closed.
 * Leaving a row at 'working' would revive it as a spinner that can never finish.
 */
export function restingPngStatus(item: PngItem): PngStatus {
  if (item.status === 'error') return 'error';
  return item.output ? 'done' : 'queued';
}

/**
 * Re-mints the object URLs a snapshot could not carry, IN PLACE.
 *
 * In place, and therefore idempotent, on purpose: this runs from a useState initializer, which
 * React StrictMode double-invokes in development. A version that returned fresh rows would mint a
 * second set of urls on the second pass and leak the first, since only one of the two results is
 * ever kept. Mutating the snapshot's own rows means the second pass finds the work already done.
 *
 * A row with no source falls back to its output, which is a perfectly good PNG to preview — for a
 * restored row it is the only image there is.
 */
export function revivePngUrls(items: PngItem[]): PngItem[] {
  for (const item of items) {
    if (!item.previewUrl) {
      const source = item.file ?? item.output ?? null;
      if (source) item.previewUrl = URL.createObjectURL(source);
    }
    if (item.output && !item.outputUrl) item.outputUrl = URL.createObjectURL(item.output);
  }
  return items;
}
