'use client';

// Card thumbnails for the file grid.
//
// Deliberately NOT built on lib/bg/preview-store.ts. That module is a bounded LRU with a concurrency
// gate, keyed by numeric item id, and it exists because decoding full-resolution masters unbounded
// exhausted memory on a real batch. Reaching into it for homepage decoration would mean widening its
// key type and exporting its decode gate — a change to load-bearing code, for a picture.
//
// This does one thing instead: encode ONE blob, at most one at a time, and only from the header
// writer — never at render time. A thumbnail is written to disk once per file and read back as a
// Blob, so the grid never decodes anything at all.

/** Longest edge of the stored thumbnail. Two-up on a retina card with room to spare. */
export const THUMB_EDGE = 320;

/**
 * WebP, matching lib/bg/constants.ts's STORE_TYPE: it keeps the alpha a cutout depends on (a
 * thumbnail flattened onto white would show a white product on white) and is a fraction of PNG at
 * this size.
 */
const THUMB_TYPE = 'image/webp';
const THUMB_QUALITY = 0.8;

/**
 * Serializes every encode in the tab.
 *
 * Thumbnails are never urgent — nothing is waiting on one — and a decode holds a full-resolution
 * bitmap for as long as it runs. Letting four files encode at once during a homepage sweep would
 * spike memory for no gain, so each waits for the last. Failures are swallowed into the chain so one
 * bad blob cannot wedge every later encode.
 */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

/**
 * A small WebP of `source`, or null if it cannot be decoded.
 *
 * Downscales during decode rather than after: createImageBitmap's resize options let the decoder
 * emit the small bitmap directly, so a 3000px master never becomes a 36 MB RGBA surface on the way
 * to a 320px thumbnail. Never upscales — a source smaller than the target is used at its own size.
 */
export function makeThumb(source: Blob, edge: number = THUMB_EDGE): Promise<Blob | null> {
  return enqueue(async () => {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
      return null;
    }
    let bitmap: ImageBitmap | null = null;
    try {
      // Probe first for the true dimensions, then re-decode at the target — the same shape
      // lib/bg/preview-store.ts uses, and for the same reason: the resize options need a ratio, and
      // guessing one wrong either upscales or crops.
      const probe = await createImageBitmap(source);
      const longest = Math.max(probe.width, probe.height);
      const scale = longest > edge ? edge / longest : 1;
      const width = Math.max(1, Math.round(probe.width * scale));
      const height = Math.max(1, Math.round(probe.height * scale));
      probe.close();

      bitmap = await createImageBitmap(source, {
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: 'high',
      });

      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0);
      // The same convertToBlob path lib/bg/bg.worker.ts already relies on.
      return await canvas.convertToBlob({ type: THUMB_TYPE, quality: THUMB_QUALITY });
    } catch {
      // A thumbnail is decoration. A source that will not decode costs the card its picture and
      // nothing else — never the file, and never the write that was carrying it.
      return null;
    } finally {
      bitmap?.close();
    }
  });
}
