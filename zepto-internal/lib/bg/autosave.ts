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

/** Cutouts run ~1 MB each; two dozen per transaction keeps commits fast and bounded, where a
    single transaction over a freshly restored 3,000-item project moves gigabytes at once and
    fails wholesale — which is exactly how a week of batches went unprotected. */
const WRITE_CHUNK = 24;

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
  /** True after a write failure until a write succeeds again. Failures self-retry, but the
      user deserves to know the crash net has holes while they do. */
  failing: boolean;
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
  const [failing, setFailing] = React.useState(false);
  // 'boot' -> reading the store; 'held' -> records await a decision; 'active' -> mirroring.
  const phaseRef = React.useRef<'boot' | 'held' | 'active'>('boot');
  const recordsRef = React.useRef<AutosaveRecord[]>([]);
  const knownRef = React.useRef(new Map<number, Signature>());
  const persistAskedRef = React.useRef(false);
  // Single-runner pump. The effect only records "state changed" and the latest items; the
  // running pass computes its diff AGAINST THE CURRENT state when it starts. Pre-computing
  // the diff at effect time raced a still-running pass two ways: a mid-pass deletion was
  // diffed against a `known` map the pass had not marked yet (no delete enqueued — the item's
  // record survived and resurrected on the next restore), and every items change during a
  // long pass re-enqueued puts for everything not yet marked (gigabytes of write
  // amplification on a big restore).
  const latestItemsRef = React.useRef<BgItem[]>([]);
  const dirtyRef = React.useRef(false);
  const runningRef = React.useRef(false);
  const retryTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Created once (state initializer, not useCallback): the runner re-invokes itself from its
  // own finally/retry, and a named function may self-reference where a const cannot.
  const [pump] = React.useState(() => function pumpOnce(): void {
    if (runningRef.current || !dirtyRef.current) return;
    runningRef.current = true;
    dirtyRef.current = false;

    (async () => {
      const known = knownRef.current;
      const savedAt = Date.now();
      // `known` is only marked AFTER a chunk commits: a failed write leaves its items
      // unmarked, so a later pass recomputes and retries them. The old code marked before
      // writing and swallowed the failure — records could silently never exist.
      const puts: { record: AutosaveRecord; sig: Signature }[] = [];
      const seen = new Set<number>();

      for (const item of latestItemsRef.current) {
        seen.add(item.id);
        const sig = signatureOf(item);
        const prev = known.get(item.id);
        if (prev && prev.cutout === sig.cutout && prev.source === sig.source && prev.name === sig.name) {
          continue;
        }
        const record = recordOf(item, savedAt);
        if (record) {
          puts.push({ record, sig });
        }
        // Work discarded in place (redo in flight, AI edit cleared the cutout): the item stays
        // known with its stale record until new work replaces it — deleting here would throw
        // away the last recoverable state right when a crash is most likely.
      }

      const deletes: number[] = [];
      for (const id of known.keys()) {
        if (!seen.has(id)) deletes.push(id);
      }
      if (!puts.length && !deletes.length) return;

      if (puts.length && !persistAskedRef.current) {
        persistAskedRef.current = true;
        // Best effort: persisted storage exempts the store from eviction under disk pressure.
        void navigator.storage?.persist?.().catch(() => {});
      }

      // Deletes FIRST: under quota pressure the user's own pruning must be able to free
      // space, or the failing puts would starve the deletes forever and wedge autosave.
      if (deletes.length) {
        await writeBatch([], deletes);
        for (const id of deletes) known.delete(id);
      }
      for (let at = 0; at < puts.length; at += WRITE_CHUNK) {
        const chunk = puts.slice(at, at + WRITE_CHUNK);
        await writeBatch(chunk.map((p) => p.record), []);
        for (const p of chunk) known.set(p.record.id, p.sig);
      }
      if (puts.length) setLastSavedAt(savedAt);
      setFailing(false);
    })()
      .catch((e) => {
        // Never an app failure — but never silent either: `failing` drives a visible warning,
        // and a timed retry keeps its promise even when the queue goes quiet.
        console.error('autosave: write failed, will retry', e);
        setFailing(true);
        if (retryTimerRef.current === null) {
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            dirtyRef.current = true;
            pumpOnce();
          }, 5000);
        }
      })
      .finally(() => {
        runningRef.current = false;
        // Drain whatever changed while this pass was committing.
        pumpOnce();
      });
  });

  React.useEffect(() => {
    latestItemsRef.current = items;
    if (phaseRef.current !== 'active') return;
    dirtyRef.current = true;
    pump();
  }, [items, pump]);

  React.useEffect(
    () => () => {
      if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
    },
    [],
  );

  const restore = React.useCallback(async () => {
    // Idempotent: a second call (double-click while the dialog animates out) must not run
    // clearAutosave again — that wipes the records the sync effect just re-put.
    if (phaseRef.current === 'active') return [];
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
    if (phaseRef.current === 'active') return;
    recordsRef.current = [];
    setPending(null);
    void clearAutosave().catch(() => {});
    phaseRef.current = 'active';
  }, []);

  return { pending, restore, discard, lastSavedAt, failing };
}
