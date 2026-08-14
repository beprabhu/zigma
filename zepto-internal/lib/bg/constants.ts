// Constants shared by the worker and its main-thread client. They live in their own module so
// pool.ts can read them without a value-import of bg.worker.ts, which would bundle the worker's
// top-level message listener into the main thread.

/**
 * Longest edge the pipeline works at. The matte is inferred at 1024x1024 and upscaled, so a
 * 4000px source buys sharper RGB but not one pixel of extra mask precision — while costing 4x
 * the memory in every buffer downstream. Tiles export at 600-1024px, where this is invisible.
 */
export const MAX_EDGE = 2048;

/**
 * Tight-crop rescue. A product running edge to edge leaves the model almost no background to
 * reference, and it inverts: the big flat area reads as background and only the high-contrast
 * scraps survive (a red snack packet came back as its logo and a zigzag). Padding the input
 * with a synthetic white margin hands the context back — measured on twenty real shredded
 * mattes, a fifth of margin fully recovered seven and made none worse. Applied only when the
 * original's ink nearly fills the frame; padding an already-loose crop just wastes resolution.
 */
export const PAD_TRIGGER_BBOX = 0.88;
export const PAD_FRACTION = 0.2;

/**
 * On-screen size for thumbnails, result cells and tile previews. Nothing displays a cutout at
 * full resolution, so keeping full-size pixels per queued image is pure waste.
 */
export const PREVIEW_EDGE = 512;

/**
 * Storage codec for finished cutouts. Lossless WebP is ~9x smaller than the raw RGBA canvas and
 * 3x faster to encode than PNG (1.8 MB / 318 ms vs 2.6 MB / 1055 ms on a 2048² cutout). Lossless
 * matters: this is the master the export re-encodes from.
 */
export const STORE_TYPE = 'image/webp';
