'use client';

// Crash recovery for the BG Remover queue.
//
// One IndexedDB record per queue item, written the moment recoverable work lands — a finished
// cutout, or an AI-regenerated source awaiting re-removal (paid Azure output). Incremental by
// design: a whole-project snapshot would serialize gigabytes on a timer and still lose whatever
// finished after the last tick; here whatever completed before a crash is already on disk.
// Plain drafts are deliberately NOT saved — a dropped original or CSV URL costs nothing to
// re-add, and writing every original would double the batch's disk footprint.
//
// Restore reuses the project-restore item shape ({blob, bounds, width, height, name, origin}),
// so a recovered queue goes through the same battle-tested rebuild path as a .zesku file.
//
// Single-writer assumption: two tabs on /bg-remover would fight over one store (last writer
// wins). Accepted — this is single-user tooling; the store exists for crashes, not sync.

import * as React from 'react';

import type { BgItem } from './batch';
import type { SubjectBounds } from './safe-area';

const DB_NAME = 'zesku-bg-autosave';
const STORE = 'items';

export interface AutosaveRecord {
  id: number;
  name: string;
  /** Display provenance for restored items (file name, URL, or project label). */
  origin: string;
  /** URL sources survive as URLs so redo still works after a restore. */
  sourceUrl: string | null;
  /** AI-regenerated source bytes — the output that cost money; null for ordinary sources. */
  sourceFile: Blob | null;
  sourceFileName: string | null;
  cutout: Blob | null;
  bounds: SubjectBounds | null;
  width: number;
  height: number;
  savedAt: number;
}

// ---- Promisified IDB ------------------------------------------------------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? (req.result as T) : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export function listAutosaved(): Promise<AutosaveRecord[] | undefined> {
  return withStore<AutosaveRecord[]>('readonly', (store) => store.getAll());
}

function writeBatch(puts: AutosaveRecord[], deletes: number[]): Promise<void> {
  if (!puts.length && !deletes.length) return Promise.resolve();
  return withStore('readwrite', (store) => {
    for (const record of puts) store.put(record);
    for (const id of deletes) store.delete(id);
  }).then(() => undefined);
}

export function clearAutosave(): Promise<void> {
  return withStore('readwrite', (store) => store.clear()).then(() => undefined);
}

// ---- Item -> record -------------------------------------------------------

function originOf(item: BgItem): string {
  if (item.source.kind === 'file') return item.source.file.name;
  if (item.source.kind === 'url') return item.source.url;
  return item.source.label;
}

/** Null when the item carries nothing worth recovering (a draft with no finished work). */
function recordOf(item: BgItem, savedAt: number): AutosaveRecord | null {
  const regenerated =
    item.source.kind === 'file' && item.source.regenerated ? item.source.file : null;
  if (!item.cutout && !regenerated) return null;
  return {
    id: item.id,
    name: item.name,
    origin: originOf(item),
    sourceUrl: item.source.kind === 'url' ? item.source.url : null,
    sourceFile: regenerated,
    sourceFileName: regenerated ? regenerated.name : null,
    cutout: item.cutout?.blob ?? null,
    bounds: item.cutout?.bounds ?? null,
    width: item.cutout?.width ?? 0,
    height: item.cutout?.height ?? 0,
    savedAt,
  };
}

// The signature is object identity, not content: a cutout blob or regenerated file is only ever
// swapped wholesale, so identity comparison makes the per-render diff O(n) pointer checks
// instead of content hashing.
interface Signature {
  cutout: Blob | null;
  source: Blob | null;
  name: string;
}

function signatureOf(item: BgItem): Signature {
  return {
    cutout: item.cutout?.blob ?? null,
    source: item.source.kind === 'file' && item.source.regenerated ? item.source.file : null,
    name: item.name,
  };
}

// ---- Sync hook ------------------------------------------------------------

export interface PendingRestore {
  count: number;
  savedAt: number;
}

export interface Autosave {
  /** Non-null while a previous session's records await a restore/discard decision. */
  pending: PendingRestore | null;
  /** Clears the store and hands back the records; the caller rebuilds queue items from them. */
  restore(): Promise<AutosaveRecord[]>;
  discard(): void;
  /** When this session last wrote a record — the UI's "Autosaved HH:MM" signal. */
  lastSavedAt: number | null;
}

/**
 * Mirrors `items` into IndexedDB. Every mutation path (run completion, AI-fix replacement,
 * removal, wholesale clear) flows through setItems, so diffing the committed array is the one
 * hook point that cannot miss a write.
 *
 * Boot handshake: while a previous session's records exist and are undecided, syncing is HELD —
 * otherwise the initial empty `items` array would read as "everything was deleted" and wipe the
 * crashed session before the user could restore it.
 */
export function useAutosave(items: BgItem[]): Autosave {
  const [pending, setPending] = React.useState<PendingRestore | null>(null);
  const [lastSavedAt, setLastSavedAt] = React.useState<number | null>(null);
  // 'boot' -> reading the store; 'held' -> records await a decision; 'active' -> mirroring.
  const phaseRef = React.useRef<'boot' | 'held' | 'active'>('boot');
  const recordsRef = React.useRef<AutosaveRecord[]>([]);
  const knownRef = React.useRef(new Map<number, Signature>());
  const persistAskedRef = React.useRef(false);

  React.useEffect(() => {
    let cancelled = false;
    listAutosaved()
      .then((records) => {
        if (cancelled) return;
        if (records?.length) {
          recordsRef.current = records;
          phaseRef.current = 'held';
          setPending({
            count: records.length,
            savedAt: records.reduce((max, r) => Math.max(max, r.savedAt), 0),
          });
        } else {
          phaseRef.current = 'active';
        }
      })
      .catch(() => {
        // No IndexedDB (private mode, storage denied): the app must keep working without
        // recovery rather than fail with it.
        if (!cancelled) phaseRef.current = 'active';
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (phaseRef.current !== 'active') return;
    const known = knownRef.current;
    const savedAt = Date.now();
    const puts: AutosaveRecord[] = [];
    const seen = new Set<number>();

    for (const item of items) {
      seen.add(item.id);
      const sig = signatureOf(item);
      const prev = known.get(item.id);
      if (prev && prev.cutout === sig.cutout && prev.source === sig.source && prev.name === sig.name) {
        continue;
      }
      const record = recordOf(item, savedAt);
      if (record) {
        puts.push(record);
        known.set(item.id, sig);
      } else if (prev) {
        // Work was discarded in place (redo in flight, AI edit cleared the cutout): the item
        // stays known with its stale record until new work replaces it — deleting here would
        // throw away the last recoverable state right when a crash is most likely.
        continue;
      }
    }

    const deletes: number[] = [];
    for (const id of known.keys()) {
      if (!seen.has(id)) {
        deletes.push(id);
        known.delete(id);
      }
    }

    if (puts.length && !persistAskedRef.current) {
      persistAskedRef.current = true;
      // Best effort: persisted storage exempts the store from eviction under disk pressure.
      void navigator.storage?.persist?.().catch(() => {});
    }
    writeBatch(puts, deletes)
      .then(() => {
        if (puts.length) setLastSavedAt(savedAt);
      })
      .catch(() => {
        // Same stance as the boot read: autosave failures must never surface as app failures.
      });
  }, [items]);

  const restore = React.useCallback(async () => {
    const records = recordsRef.current;
    recordsRef.current = [];
    setPending(null);
    // Clear before rebuild: the sync effect re-puts every restored item under its NEW queue id,
    // so stale ids never linger to collide with future sessions.
    await clearAutosave().catch(() => {});
    phaseRef.current = 'active';
    return records;
  }, []);

  const discard = React.useCallback(() => {
    recordsRef.current = [];
    setPending(null);
    void clearAutosave().catch(() => {});
    phaseRef.current = 'active';
  }, []);

  return { pending, restore, discard, lastSavedAt };
}
