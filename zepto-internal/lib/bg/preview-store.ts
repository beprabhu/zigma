'use client';

// Bounded, lazy preview cache for finished cutouts.
//
// A cutout keeps a compressed WebP master (BgCutout.blob); the pixels the UI draws are decoded
// from it here. Holding one decoded ImageBitmap per item is what exhausted memory on a 3,389
// image batch: a <=512px preview is ~1 MB, it lives outside the JS heap, and GC will not reclaim
// it promptly even once nothing references it. Previews are therefore decoded on demand for
// whatever is on screen and closed on an LRU basis, so resident preview memory is a function of
// the viewport rather than of the queue length.

import * as React from 'react';

export interface PreviewRequest {
  /** Stable identity — the BgItem id. */
  key: number;
  /** The compressed master to decode from. */
  blob: Blob;
  /** Longest edge to decode to, in px. Different edges for the same key coexist. */
  edge: number;
}

interface CacheEntry {
  bitmap: ImageBitmap;
  /** w * h * 4. The real allocation is GPU-side and unmeasurable; this tracks it well enough. */
  bytes: number;
}

/** In-flight decode. `cancelled` is set by dropPreview/clearPreviews so a late result is closed. */
interface DecodeTask {
  cancelled: boolean;
  /** Set once the task is past the concurrency gate; until then it can be dropped for free. */
  started: boolean;
}

/**
 * Cache bounds. The result grids and the queue list show on the order of 30-60 cells at once, so
 * both caps sit a few viewports above that: scrolling back a screen or two stays instant, while
 * the ceiling is fixed no matter how long the queue is. A 512px preview is at most
 * 512 * 512 * 4 = 1 MB, so the byte cap is what binds for result cells (~128 of them) and the
 * entry cap is what binds for the 96px queue thumbnails, which cost ~36 KB each.
 */
const MAX_ENTRIES = 192;
const MAX_BYTES = 128 * 1024 * 1024;

/**
 * A master has to be probed at full resolution (16 MB of RGBA at 2048²) before it can be resized,
 * so decodes are gated: a fling-scroll queues far more requests than it leaves on screen, and
 * without this the transient probes would spike well past the steady-state cache they feed.
 */
const MAX_CONCURRENT_DECODES = 4;

/** A blob that failed to decode will keep failing; retrying it every render would spin the CPU. */
const FAILURE_TTL_MS = 30_000;

// Map insertion order IS the LRU order: a read re-inserts, eviction takes from the front.
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, DecodeTask>();
const failures = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();
let cachedBytes = 0;

// The BLOB is part of the cache identity, not just the item id. An item's cutout can be
// REPLACED under the same id (redo, AI edit, project restore) — and with an id-only key, a
// stale decode of the old blob could be re-created during the replacement window and then
// served for the new cutout indefinitely: wrong pixels AND a wrong previewScale, which is what
// drew "zoomed crop" tiles after an AI-fix pass. Tokens are handed out per Blob instance via a
// WeakMap, so a new blob can never collide with the old one's entries.
const blobTokens = new WeakMap<Blob, number>();
let nextBlobToken = 1;

function tokenOf(blob: Blob): number {
  let token = blobTokens.get(blob);
  if (token === undefined) {
    token = nextBlobToken++;
    blobTokens.set(blob, token);
  }
  return token;
}

function entryKey(key: number, blob: Blob, edge: number): string {
  return `${key}@${tokenOf(blob)}@${edge}`;
}

function belongsTo(cacheKey: string, key: number): boolean {
  return cacheKey.startsWith(`${key}@`);
}

function notify(cacheKey: string): void {
  const set = listeners.get(cacheKey);
  if (!set) return;
  // Copied: a listener may unsubscribe as a direct result of being told.
  for (const listener of [...set]) listener();
}

function forget(cacheKey: string): void {
  const entry = cache.get(cacheKey);
  if (!entry) return;
  cache.delete(cacheKey);
  cachedBytes -= entry.bytes;
  entry.bitmap.close();
}

/**
 * Frees down to the caps, oldest first, skipping anything a mounted consumer is subscribed to.
 * When everything cached is on screen it gives up and stays over budget: evicting a displayed
 * entry would blank it and immediately trigger a re-decode, and that loop is worse than the
 * overshoot. The caps are set well above one viewport so this is the pathological case only.
 */
function evict(): void {
  while (cache.size > MAX_ENTRIES || cachedBytes > MAX_BYTES) {
    let victim: string | null = null;
    for (const cacheKey of cache.keys()) {
      if (!listeners.has(cacheKey)) {
        victim = cacheKey;
        break;
      }
    }
    if (victim === null) return;
    forget(victim);
  }
}

// ---- Decode scheduling ----------------------------------------------------

let activeDecodes = 0;
const waiting: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeDecodes < MAX_CONCURRENT_DECODES) {
    activeDecodes += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waiting.push(resolve);
  });
}

function releaseSlot(): void {
  // LIFO: the newest waiter is the one most likely to still be on screen, so it goes first. The
  // slot is handed straight over rather than released, so activeDecodes is unchanged.
  const next = waiting.pop();
  if (next) next();
  else activeDecodes -= 1;
}

/**
 * Decodes `blob` with its longest edge at `edge`, never upscaling. createImageBitmap cannot
 * report the source size without decoding, so a probe runs first; it is closed before the resized
 * decode starts so peak memory is one full-resolution bitmap rather than two. A source already
 * within `edge` keeps the probe — that is the correctly sized result.
 */
async function decodeToEdge(
  blob: Blob,
  edge: number,
  task: DecodeTask,
): Promise<ImageBitmap | null> {
  await acquireSlot();
  try {
    // Cancelled while queued behind the gate, so skip the decode entirely. A fling over a long
    // grid, or leaving the product, strands thousands of tasks here; decoding every one of them
    // at full resolution only to close the result would keep four decodes busy for a minute.
    if (task.cancelled) return null;
    task.started = true;
    const probe = await createImageBitmap(blob);
    const longest = Math.max(probe.width, probe.height);
    const scale = longest > 0 ? Math.min(1, edge / longest) : 1;
    if (scale === 1) return probe;
    const resizeWidth = Math.max(1, Math.round(probe.width * scale));
    const resizeHeight = Math.max(1, Math.round(probe.height * scale));
    probe.close();
    return await createImageBitmap(blob, { resizeWidth, resizeHeight, resizeQuality: 'high' });
  } finally {
    releaseSlot();
  }
}

function recentlyFailed(cacheKey: string): boolean {
  const at = failures.get(cacheKey);
  if (at === undefined) return false;
  if (Date.now() - at < FAILURE_TTL_MS) return true;
  failures.delete(cacheKey);
  return false;
}

/**
 * Starts a decode unless the entry is cached, already decoding or freshly failed. The in-flight
 * task is registered synchronously, so N consumers of the same cell in one commit share ONE
 * decode instead of racing N of them.
 */
function requestDecode(key: number, blob: Blob, edge: number): void {
  const cacheKey = entryKey(key, blob, edge);
  if (cache.has(cacheKey) || inFlight.has(cacheKey) || recentlyFailed(cacheKey)) return;

  const task: DecodeTask = { cancelled: false, started: false };
  inFlight.set(cacheKey, task);

  decodeToEdge(blob, edge, task).then(
    (bitmap) => {
      if (inFlight.get(cacheKey) === task) inFlight.delete(cacheKey);
      // Abandoned before it ever ran, so there is nothing to cache and nothing to close.
      if (bitmap === null) return;
      // The item was dropped, or the whole store cleared, while this was decoding.
      if (task.cancelled) {
        bitmap.close();
        return;
      }
      forget(cacheKey);
      const bytes = bitmap.width * bitmap.height * 4;
      cache.set(cacheKey, { bitmap, bytes });
      cachedBytes += bytes;
      evict();
      notify(cacheKey);
    },
    () => {
      if (inFlight.get(cacheKey) === task) inFlight.delete(cacheKey);
      if (task.cancelled) return;
      failures.set(cacheKey, Date.now());
      notify(cacheKey);
    },
  );
}

/**
 * Drops a queued decode whose last consumer has gone. Only a task still behind the concurrency
 * gate is dropped; one already decoding is left to finish and cache, so a cell scrolled off and
 * straight back on is not made to pay for the decode twice.
 */
function abandonDecode(cacheKey: string): void {
  const task = inFlight.get(cacheKey);
  if (!task || task.started) return;
  task.cancelled = true;
  inFlight.delete(cacheKey);
}

// ---- Store reads ----------------------------------------------------------

/** Reading is also the LRU touch, so anything rendered this frame moves out of eviction range. */
function read(cacheKey: string): ImageBitmap | null {
  const entry = cache.get(cacheKey);
  if (!entry) return null;
  cache.delete(cacheKey);
  cache.set(cacheKey, entry);
  return entry.bitmap;
}

function subscribeTo(cacheKey: string, onStoreChange: () => void): () => void {
  const set = listeners.get(cacheKey) ?? new Set<() => void>();
  listeners.set(cacheKey, set);
  set.add(onStoreChange);
  return () => {
    set.delete(onStoreChange);
    // The identity check matters, not just the size: an unsubscribe called twice must not delete
    // the set a later subscriber installed, which eviction would then read as unprotected.
    if (set.size > 0 || listeners.get(cacheKey) !== set) return;
    // The map must not keep empty sets: eviction reads it as "someone is displaying this".
    listeners.delete(cacheKey);
    abandonDecode(cacheKey);
    // This is the moment the entry becomes evictable, and the only one: evict() is otherwise
    // reached only from a decode, so a cache left over budget by a screenful of protected
    // entries would stay over budget for the session once those consumers unmounted.
    evict();
  };
}

const NO_SUBSCRIPTION = () => {};
const noPreview = () => null;

/**
 * Returns the decoded preview once available, null while it decodes.
 * Re-renders the calling component when the bitmap arrives.
 */
export function usePreview(request: PreviewRequest | null): ImageBitmap | null {
  const key = request?.key ?? null;
  const blob = request?.blob ?? null;
  const edge = request?.edge ?? 0;
  const cacheKey = key === null || blob === null ? null : entryKey(key, blob, edge);

  const subscribe = React.useCallback(
    (onStoreChange: () => void) =>
      cacheKey === null ? NO_SUBSCRIPTION : subscribeTo(cacheKey, onStoreChange),
    [cacheKey],
  );
  const getSnapshot = React.useCallback(
    () => (cacheKey === null ? null : read(cacheKey)),
    [cacheKey],
  );
  // The server has no ImageBitmap; the client fills it in from the effect below.
  const bitmap = React.useSyncExternalStore(subscribe, getSnapshot, noPreview);

  React.useEffect(() => {
    if (key === null || blob === null || bitmap !== null) return;
    requestDecode(key, blob, edge);
  }, [key, blob, edge, bitmap]);

  return bitmap;
}

// ---- Lifecycle ------------------------------------------------------------

/** Drops any cached previews for this key (all edges). Call when an item leaves the queue. */
export function dropPreview(key: number): void {
  for (const cacheKey of [...cache.keys()]) {
    if (!belongsTo(cacheKey, key)) continue;
    forget(cacheKey);
    notify(cacheKey);
  }
  for (const [cacheKey, task] of inFlight) {
    if (belongsTo(cacheKey, key)) {
      task.cancelled = true;
      inFlight.delete(cacheKey);
    }
  }
  for (const cacheKey of [...failures.keys()]) {
    if (belongsTo(cacheKey, key)) failures.delete(cacheKey);
  }
}

/** Closes and forgets everything. Call on unmount of the product. */
export function clearPreviews(): void {
  const held = [...cache.keys()];
  for (const cacheKey of held) forget(cacheKey);
  for (const task of inFlight.values()) task.cancelled = true;
  inFlight.clear();
  failures.clear();
  for (const cacheKey of held) notify(cacheKey);
}
