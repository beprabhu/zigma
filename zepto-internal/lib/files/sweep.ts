'use client';

// The 7-day expiry.
//
// This is the only irreversible mass-delete in the app, it runs on a wall clock, and it runs while
// nobody is watching — so it is deliberately two-stage. At 7 days an unkept file is SOFT-deleted:
// `deletedAt` is stamped, the card leaves the grid for Trash, and everything is still on disk. Only
// a week after that is anything actually destroyed. A user who comes back from leave to a missing
// batch has a week to notice; a one-shot delete would give them nothing.
//
// Three exemptions, and every one of them is a file that would otherwise be deleted out from under
// someone:
//   pinned            keptAt set — the whole point of the Keep toggle
//   held by a tab     a fresh heartbeat in meta[[fileId,'lock']] (see store.touchLock)
//   live in this tab  a file the session store is still holding across a navigation, which no
//                     heartbeat covers once the page has unmounted

import { FILES_STORE, ITEMS_STORE, META_STORE, BY_UPDATED, fileRange, metaKey, withTx } from './db';
import { LOCK_KEY, broadcast, isHeldElsewhere } from './store';
import { forgetOpen } from './open';
import type { FileRecord, MetaRecord } from './types';

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Unkept and untouched for this long: off the grid, into Trash. */
export const EXPIRE_MS = 7 * DAY_MS;
/** And this long in Trash before the bytes actually go. */
export const PURGE_MS = 7 * DAY_MS;

export interface SweepResult {
  trashed: string[];
  purged: string[];
  /** Records whose file no longer exists (or never did) — see sweepOrphans. */
  orphans: number;
}

/** App-level records live under this synthetic id and belong to no file. Never swept. */
const APP_SCOPE = '@app';

export interface SweepOptions {
  /** File ids this tab still holds live — from the session store, not from what is mounted. */
  exclude?: ReadonlySet<string>;
  now?: number;
}

/**
 * Runs one expiry pass.
 *
 * Everything happens inside a single transaction over all three stores, including re-reading each
 * candidate's heartbeat. Checking the lock beforehand would be a decision made on a fact that can
 * change before the delete lands — and the fact in question is "is someone working in this right
 * now".
 *
 * Fails soft: with no IndexedDB (private mode, storage denied) the app must keep working without
 * expiry rather than fail with it.
 */
export async function sweepExpired(opts: SweepOptions = {}): Promise<SweepResult> {
  const now = opts.now ?? Date.now();
  const exclude = opts.exclude ?? new Set<string>();
  const result: SweepResult = { trashed: [], purged: [], orphans: 0 };

  try {
    await withTx([FILES_STORE, ITEMS_STORE, META_STORE], 'readwrite', (tx) => {
      const files = tx.objectStore(FILES_STORE);
      const items = tx.objectStore(ITEMS_STORE);
      const meta = tx.objectStore(META_STORE);

      // Only files whose last CONTENT write is older than the threshold are even candidates. The
      // index makes that a range rather than a walk of every file the user owns.
      const cursorReq = files
        .index(BY_UPDATED)
        .openCursor(IDBKeyRange.upperBound(now - EXPIRE_MS, true));

      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        const file = cursor.value as FileRecord;
        const advance = () => cursor.continue();

        if (file.keptAt !== null || exclude.has(file.id)) {
          advance();
          return;
        }

        const lockReq = meta.get(metaKey(file.id, LOCK_KEY));
        lockReq.onsuccess = () => {
          const lock = (lockReq.result as MetaRecord | undefined)?.value;
          if (isHeldElsewhere(lock, now)) {
            advance();
            return;
          }

          if (file.deletedAt === null) {
            // Stage one. Nothing is destroyed; the card moves to Trash.
            files.put({ ...file, deletedAt: now });
            result.trashed.push(file.id);
          } else if (now - file.deletedAt >= PURGE_MS) {
            // Stage two. One range delete per store — the compound keyPath is what makes a whole
            // file's rows one request rather than a cursor step per row.
            files.delete(file.id);
            items.delete(fileRange(file.id));
            meta.delete(fileRange(file.id));
            result.purged.push(file.id);
          }
          advance();
        };
        lockReq.onerror = advance;
      };
    });
  } catch (e) {
    console.error('files: expiry sweep skipped', e);
    return result;
  }

  // Announced so a tab holding one of these parks its pump rather than writing rows back under a
  // header that no longer exists.
  for (const fileId of result.purged) {
    // Same reason as deleteFile: this tab never hears its own broadcast, so it has to drop the
    // resume pointer itself or the rail would reopen a file the sweep just destroyed.
    forgetOpen(fileId);
    broadcast({ type: 'deleted', fileId });
  }
  for (const fileId of result.trashed) broadcast({ type: 'changed', fileId });

  result.orphans = await sweepOrphans().catch(() => 0);
  return result;
}

/**
 * Reclaims records whose file has no header.
 *
 * Cascade delete is keyed on real files, so anything written under an id that never became one is
 * unreachable by every other path here — it can only be found by looking for it. That is not a
 * hypothetical: the heartbeat used to start before the header was minted, and a visit where the
 * user added nothing left a lock behind under a uuid no file would ever have.
 *
 * Deliberately a full scan of `items` and `meta` keys rather than a range: the whole point is to
 * find ids that are not in `files`, which no index over `files` can answer. Keys only — the blobs
 * are never deserialized — and it runs once per tab, behind the expiry sweep.
 */
async function sweepOrphans(): Promise<number> {
  let removed = 0;
  await withTx([FILES_STORE, ITEMS_STORE, META_STORE], 'readwrite', (tx) => {
    const known = new Set<string>([APP_SCOPE]);
    const idsReq = tx.objectStore(FILES_STORE).getAllKeys();
    idsReq.onsuccess = () => {
      for (const id of idsReq.result) known.add(String(id));
      for (const name of [ITEMS_STORE, META_STORE]) {
        const store = tx.objectStore(name);
        const keysReq = store.getAllKeys();
        keysReq.onsuccess = () => {
          for (const key of keysReq.result) {
            // Compound keys, so element 0 is always the fileId.
            const fileId = Array.isArray(key) ? String(key[0]) : '';
            if (fileId && !known.has(fileId)) {
              store.delete(key);
              removed += 1;
            }
          }
        };
      }
    };
  });
  return removed;
}

/** Whole days until a file leaves the grid, or null when it never will. */
export function daysUntilExpiry(file: FileRecord, now: number = Date.now()): number | null {
  if (file.keptAt !== null) return null;
  const deadline = (file.deletedAt ?? file.updatedAt) + (file.deletedAt ? PURGE_MS : EXPIRE_MS);
  return Math.max(0, Math.ceil((deadline - now) / DAY_MS));
}
