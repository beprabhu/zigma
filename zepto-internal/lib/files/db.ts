'use client';

// The IndexedDB connection for the file store, and the one-time migration gate in front of it.
//
// Connection handling is carried over from the crash net this replaces, because every line of it
// was paid for: a per-operation open-and-close so a stalled version change clears within a tick, an
// onblocked that rejects LOUDLY rather than leaving a promise unsettled, and a late-arriving
// connection from a cleared block closed on arrival — an open connection being precisely what
// blocks the next upgrade. The cost is real (a 3,000-item restore at WRITE_CHUNK is ~125 opens) but
// a cached connection would need db.onversionchange handling to buy back the same property, and in
// a files world two tabs on two files is normal rather than exotic.
//
// Two tiers on purpose. Everything an application path calls goes through withTx/withStore, which
// await the migration; the migration itself calls rawTx, which does not. Without that split the
// gate deadlocks on itself.

import type { ItemId } from './types';

const DB_NAME = 'zigma-files';
// v1, and it should stay v1 for a very long time. A version bump re-runs onupgradeneeded against
// every live database, and here that database is not one crash net — it is every file the user has.
// Additive change belongs in FileRecord.schema (owned by the codec) or in a new meta key, neither of
// which needs the version to move.
const DB_VERSION = 1;

export const FILES_STORE = 'files';
export const ITEMS_STORE = 'items';
export const META_STORE = 'meta';

/** Index on FileRecord.updatedAt — the homepage's sort, and the sweep's cursor. */
export const BY_UPDATED = 'by_updated';
/** Index on FileRecord.tool, for filtering the grid by product. */
export const BY_TOOL = 'by_tool';

/**
 * Every record belonging to one file, as a range over the PRIMARY key.
 *
 * `items` and `meta` use compound in-line keyPaths (['fileId','id'] / ['fileId','key']) rather than
 * a synthetic key plus a fileId index, and that choice is what makes a whole file one request: one
 * getAll(range) to load it, one delete(range) to erase it. IndexedDB has no delete-by-index, so the
 * index variant needs a cursor step per record — 3,000 of them for a project this code is explicitly
 * built to handle — and it would add a B-tree write to every single item put,
 * in a pump whose whole design is about not paying per-item costs.
 *
 * The upper sentinel is `[]` and MUST NOT be a number. Item ids are mixed across the suite: counters
 * in Cleanup and Compose, uuid strings in Compress. IndexedDB orders every number before every
 * string, so `[fileId, Infinity]` silently excludes every string-keyed record — a cascade delete
 * that leaves a Compress file's items on disk forever, with no error to notice. An empty array sorts
 * after numbers, strings, dates and binary alike, so it is the only correct universal bound.
 */
export function fileRange(fileId: string): IDBKeyRange {
  return IDBKeyRange.bound([fileId], [fileId, []], false, true);
}

/** One record's compound key. Exported so callers never hand-build an array in the wrong order. */
export function itemKey(fileId: string, id: ItemId): [string, ItemId] {
  return [fileId, id];
}

export function metaKey(fileId: string, key: string): [string, string] {
  return [fileId, key];
}

// ---- Connection -----------------------------------------------------------

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Guarded by name, always. createObjectStore throws ConstraintError on a repeat, and that
      // aborts the version change — leaving the database unopenable at this version for good
      // The guards cost nothing and the failure mode is unrecoverable.
      if (!db.objectStoreNames.contains(FILES_STORE)) {
        const files = db.createObjectStore(FILES_STORE, { keyPath: 'id' });
        files.createIndex(BY_UPDATED, 'updatedAt');
        files.createIndex(BY_TOOL, 'tool');
      }
      if (!db.objectStoreNames.contains(ITEMS_STORE)) {
        db.createObjectStore(ITEMS_STORE, { keyPath: ['fileId', 'id'] });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: ['fileId', 'key'] });
      }
    };
    // A second tab holding an older connection stalls the version change. Because every operation
    // here opens and closes its own connection the block clears within a tick — but a promise that
    // never settled would strand the caller forever and silently disable the store for the session,
    // so it fails loudly and lets a retry win.
    let abandoned = false;
    req.onblocked = () => {
      abandoned = true;
      reject(new Error('files: another tab is holding an older database open'));
    };
    // A block that later clears still delivers its connection here with nobody left to close it,
    // and an open connection is exactly what blocks the NEXT upgrade.
    req.onsuccess = () => (abandoned ? req.result.close() : resolve(req.result));
    req.onerror = () => reject(req.error);
  });
}

type TxRunner<T> = (tx: IDBTransaction) => IDBRequest<T> | void;

/**
 * Ungated transaction. Only the migration should reach for this — everything else must go through
 * withTx so it cannot observe a half-migrated store.
 */
export async function rawTx<T>(
  stores: string[],
  mode: IDBTransactionMode,
  run: TxRunner<T>,
): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const req = run(tx);
      tx.oncomplete = () => resolve(req ? (req.result as T) : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// ---- The migration gate ---------------------------------------------------

let readyPromise: Promise<void> | null = null;

/**
 * Resolves once one-time migrations have run. Awaited by every application read and write, which is
 * what makes "the migration finishes before any tool's first load resolves" true by construction
 * rather than by whichever component happened to mount first.
 *
 * The import is dynamic to break the cycle — migrate.ts needs rawTx from this module — and it is
 * deliberately NOT re-tried on failure: a migration that threw has already claimed or released its
 * own marker, and hammering it would fight whatever tab is holding it. A failed migration leaves the
 * old crash net where it is, which is the safe direction.
 */
export function whenReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = import('./migrate')
      .then((m) => m.runMigrations())
      .catch((e) => {
        console.error('files: migration failed, continuing without it', e);
      });
  }
  return readyPromise;
}

export async function withTx<T>(
  stores: string[],
  mode: IDBTransactionMode,
  run: TxRunner<T>,
): Promise<T | undefined> {
  await whenReady();
  return rawTx<T>(stores, mode, run);
}

export function withStore<T>(
  name: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return withTx<T>([name], mode, (tx) => run(tx.objectStore(name)));
}

/** Promisifies one request inside a transaction the caller already owns. */
export function reqAs<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
