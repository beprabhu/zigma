'use client';

// One live session per product, handed across client-side navigation.
//
// The rail navigates with next/link, so switching products is a route change that unmounts the
// whole product page — and every useState in it goes with it. That is the entire reason a
// half-finished batch used to vanish because someone clicked Compose to check one thing. Module
// scope is the one thing a route change cannot touch: the tab keeps a single instance of this
// module for its lifetime, the same mechanism lib/bg/engine.ts's model cache leans on so that
// coming back to Cleanup does not re-download 450 MB of weights.
//
// Deliberately NOT persistence. Nothing here is serialized, so a snapshot may hold live
// HTMLImageElements, Blobs and File handles exactly as the page held them — that is what makes a
// snapshot cheap enough to take on every unmount, and it is also why the whole thing dies with
// the tab. A real reload, a crash, or a second tab all start empty; surviving those is
// lib/bg/autosave.ts's job (IndexedDB, incremental, written as work lands). This store covers
// only the navigation the sidebar makes trivially easy to do by accident.
//
// A stored snapshot pins whatever it references until the product overwrites it or the tab
// closes. That is the same order of memory the page already held while mounted, so leaving a
// product costs nothing new — but walking away no longer reclaims it either, which is the price
// of not losing the work.
//
// Lives under lib/bg/ next to the queue modules, but nothing in it is background-removal
// specific: both image products key into it the same way.

/**
 * Identity for one product's snapshot, carrying the snapshot's type so a read and a write can
 * never disagree about the shape. Make one at module scope in the page that owns the shape and
 * key it by the product's slug (lib/products.ts), which is already unique across the suite.
 */
export interface SessionKey<T> {
  readonly id: string;
  /** Phantom: somewhere for T to live on the key. Never assigned, never read. */
  readonly snapshotType?: T;
}

export function sessionKey<T>(id: string): SessionKey<T> {
  return { id };
}

const snapshots = new Map<string, unknown>();

/**
 * The product's snapshot, or undefined when it has not been left yet in this tab.
 *
 * A pure read, on purpose — nothing is consumed. React StrictMode double-invokes render, so a
 * useState initializer reading this runs twice, and it then unmounts and remounts the tree for
 * real; a read that cleared the entry would hand one of those passes an empty session and lose
 * everything the user came back for.
 */
export function readSession<T>(key: SessionKey<T>): T | undefined {
  return snapshots.get(key.id) as T | undefined;
}

/**
 * Replaces the product's snapshot, keeping exactly one per key.
 *
 * Meant to be called from an unmount cleanup, so it has to stay idempotent: StrictMode fires
 * that cleanup once during its dev-only mount/unmount/remount cycle, before the user has done
 * anything, and again for real on navigation. Because the write always overwrites, the second
 * pass simply restates what the first said.
 *
 * The snapshot must not carry anything the same unmount destroys. The BG Remover hands back
 * every decoded original's object URL on the way out (releaseItem in lib/bg/batch.ts), so its
 * snapshot has to null out item.original — keeping those elements would revive a queue of
 * broken images pointing at revoked blob: URLs. Anything decoded out of lib/bg/preview-store.ts
 * is the same story, since clearPreviews() closes those bitmaps. Blobs, Files and data: URLs are
 * unaffected and can be snapshotted as they are.
 */
export function saveSession<T>(key: SessionKey<T>, snapshot: T): void {
  snapshots.set(key.id, snapshot);
}

/** Forgets the product's snapshot, so its next mount starts from nothing. */
export function clearSession<T>(key: SessionKey<T>): void {
  snapshots.delete(key.id);
}

// ---- Transient statuses ---------------------------------------------------

/**
 * The statuses that exist only while a run is actively touching an item: 'loading-model',
 * 'removing' and 'editing' from BgItemStatus (lib/bg/batch.ts), 'generating' from GenStatus
 * (lib/gen.ts). Both unions rest in 'ready' / 'done' / 'error', which is what makes one shared
 * normalizer possible.
 */
const TRANSIENT_STATUSES: ReadonlySet<string> = new Set([
  'loading-model',
  'removing',
  'editing',
  'generating',
]);

export function isTransientStatus(status: string): boolean {
  return TRANSIENT_STATUSES.has(status);
}

/**
 * Where an item that was mid-run at snapshot time has to come back.
 *
 * Leaving the product aborts the run, but the cancellation patches resolve AFTER the unmount and
 * so never commit — the snapshot therefore catches those rows frozen in whatever working status
 * they held when the user walked away. Revived untouched they render as spinners that can never
 * finish, and a row frozen in 'editing' additionally refuses another AI edit, because the page
 * reads that status as "a request is already out for this one".
 *
 * `hasResult` picks the honest resting state: the aborted attempt committed nothing, so a row
 * that already carried an image or a cutout goes back to 'done' still holding that older result,
 * and a row that had nothing goes back to 'ready' for the user to run again. Statuses already at
 * rest are returned untouched, which is what lets a caller map it over the whole queue blindly.
 */
export function restingStatus<S extends string>(
  status: S,
  hasResult: boolean,
): S | 'ready' | 'done' {
  if (!isTransientStatus(status)) return status;
  return hasResult ? 'done' : 'ready';
}
