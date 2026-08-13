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
// The CSV a batch was imported from is the one thing kept WHOLE rather than per item, in a
// second store. It is what makes the drafts rule survivable: the unfinished rows are not on
// disk, but the sheet that produced them is, so a restored session can re-import whatever the
// crash interrupted — and the column mapping (which cell named which image) still resolves for
// the rows that did finish.
//
// Single-writer assumption: two tabs on /bg-remover would fight over one store (last writer
// wins). Accepted — this is single-user tooling; the store exists for crashes, not sync.

import * as React from 'react';

import type { BgItem, CsvOrigin } from './batch';
import type { ProjectCsv } from './project';
import type { SubjectBounds } from './safe-area';

const DB_NAME = 'zesku-bg-autosave';
const STORE = 'items';
const META_STORE = 'meta';
// v2 only ADDS the meta store; the items store and every record in it survive untouched, which
// is the whole point — a bump that rebuilt `items` would delete the crash net of anyone who
// upgrades mid-batch, at the exact moment it is most likely to be needed.
const DB_VERSION = 2;
/** Single-row store: one sheet per session, so the record replaces itself on every write. */
const CSV_KEY = 'csv';

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
  /** Which CSV cell the row came from; absent on file/paste rows and on pre-v2 records. */
  csv?: CsvOrigin;
  /** Where the row came from before an AI edit replaced its source. URL only, reference only. */
  originalSourceUrl?: string;
  batch?: number;
}

/** The stored sheet. Same shape a .zesku carries, plus when this copy was written. */
export interface AutosaveCsv extends ProjectCsv {
  savedAt: number;
}

// ---- Promisified IDB ------------------------------------------------------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Both guarded by name: this runs for a fresh install (nothing exists) and for the v1 -> v2
      // step (items already does), and createObjectStore throws ConstraintError on a repeat —
      // which would abort the version change and leave the DB unopenable at v2 for good.
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };
    // A second tab still holding a v1 connection stalls the version change. Every operation here
    // opens and closes its own connection, so the block clears within a tick — but a promise
    // that simply never settles would strand the boot read in 'boot' and silently disable
    // autosave for the rest of the session, so it fails loudly and lets the caller's retry win.
    let abandoned = false;
    req.onblocked = () => {
      abandoned = true;
      reject(new Error('autosave: another tab is holding the old database open'));
    };
    // A block that later clears still delivers its connection here, with nobody left to close
    // it — and an open connection is precisely what blocks the NEXT upgrade, so the abandoned
    // one is closed on arrival rather than left to wedge the store it just escaped.
    req.onsuccess = () => (abandoned ? req.result.close() : resolve(req.result));
    req.onerror = () => reject(req.error);
  });
}

async function withTx<T>(
  stores: string[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => IDBRequest<T> | void,
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

function withStore<T>(
  name: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return withTx<T>([name], mode, (tx) => run(tx.objectStore(name)));
}

export function listAutosaved(): Promise<AutosaveRecord[] | undefined> {
  return withStore<AutosaveRecord[]>(STORE, 'readonly', (store) => store.getAll());
}

function writeBatch(puts: AutosaveRecord[], deletes: number[]): Promise<void> {
  if (!puts.length && !deletes.length) return Promise.resolve();
  return withStore(STORE, 'readwrite', (store) => {
    for (const record of puts) store.put(record);
    for (const id of deletes) store.delete(id);
  }).then(() => undefined);
}

/** Cutouts run ~1 MB each; two dozen per transaction keeps commits fast and bounded, where a
    single transaction over a freshly restored 3,000-item project moves gigabytes at once and
    fails wholesale — which is exactly how a week of batches went unprotected. */
const WRITE_CHUNK = 24;

export function clearAutosave(): Promise<void> {
  // One transaction over both stores: a half-clear that dropped the records but kept the sheet
  // would greet the next session with a CSV whose rows exist nowhere, and the reverse would
  // leave restored rows unable to resolve the cell they were named from.
  return withTx([STORE, META_STORE], 'readwrite', (tx) => {
    tx.objectStore(STORE).clear();
    tx.objectStore(META_STORE).clear();
  }).then(() => undefined);
}

/** Field by field, like every other read off disk here: a stored record is still input. */
function parseCsvMeta(v: unknown): AutosaveCsv | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  // Without text there is nothing to re-parse, and the rest of the record describes columns of
  // a sheet that is not there — worse than no record at all, because the UI would show it.
  if (typeof c.text !== 'string' || !c.text) return null;
  return {
    fileName: typeof c.fileName === 'string' && c.fileName ? c.fileName : 'import.csv',
    text: c.text,
    // '' is meaningful — "name each image from its URL" — so a bad value degrades to it.
    nameColumn: typeof c.nameColumn === 'string' ? c.nameColumn : '',
    imageColumns: Array.isArray(c.imageColumns)
      ? c.imageColumns.filter((column): column is string => typeof column === 'string' && !!column)
      : [],
    savedAt: typeof c.savedAt === 'number' && Number.isFinite(c.savedAt) ? c.savedAt : 0,
  };
}

export async function readAutosaveCsv(): Promise<AutosaveCsv | null> {
  const raw = await withStore<unknown>(META_STORE, 'readonly', (store) => store.get(CSV_KEY));
  return parseCsvMeta(raw);
}

export function saveAutosaveCsv(csv: ProjectCsv, savedAt: number = Date.now()): Promise<void> {
  return withStore(META_STORE, 'readwrite', (store) =>
    store.put({
      key: CSV_KEY,
      fileName: csv.fileName,
      text: csv.text,
      nameColumn: csv.nameColumn,
      imageColumns: [...csv.imageColumns],
      savedAt,
    }),
  ).then(() => undefined);
}

export function clearAutosaveCsv(): Promise<void> {
  return withStore(META_STORE, 'readwrite', (store) => store.delete(CSV_KEY)).then(() => undefined);
}

/**
 * Value equality, not object identity: the page rebuilds its CSV state on every column remap,
 * so an identity check would rewrite the whole sheet each time a checkbox moved. The text is
 * compared last and is usually the same string reference, which makes the common case free.
 */
function sameCsv(a: ProjectCsv | null, b: ProjectCsv | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.fileName === b.fileName &&
    a.nameColumn === b.nameColumn &&
    a.imageColumns.length === b.imageColumns.length &&
    a.imageColumns.every((column, i) => column === b.imageColumns[i]) &&
    a.text === b.text
  );
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
    ...(item.csv ? { csv: { row: item.csv.row, column: item.csv.column } } : null),
    // URL only, and never the pre-edit bytes: those are still fetchable, while the regenerated
    // file above is the copy that cost money and exists nowhere else.
    ...(item.originalSource?.kind === 'url'
      ? { originalSourceUrl: item.originalSource.url }
      : null),
    ...(typeof item.batch === 'number' ? { batch: item.batch } : null),
  };
}

// The signature is object identity, not content: a cutout blob or regenerated file is only ever
// swapped wholesale, so identity comparison makes the per-render diff O(n) pointer checks
// instead of content hashing.
//
// What is NOT in it matters more than what is. Every field here costs a full record rewrite —
// blobs included — for each item it differs on, so a 3,000-item queue turns one changed field
// into gigabytes moved. `name` earns its place because a stale name ships a wrongly named file
// out of the export. The v2 additions do not:
//   csv               fixed when the row is imported and never touched again — and it is an
//                     object, so comparing it at all would have to be by value; by identity, a
//                     single `{...item}` rebuild upstream would rewrite the whole queue.
//   originalSourceUrl written exactly when an AI edit swaps the source, which already moves
//                     `source` below — it rides in on that rewrite for free.
//   batch             grouping only, with nothing downstream that a stale value can corrupt. A
//                     future feature that re-groups a live queue must compare it BY VALUE here,
//                     and accept that a re-group then rewrites every record it touches.
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
  /** Set when the held session also has its sheet, so the prompt can say what comes back. */
  csvFileName?: string;
}

/**
 * The held session's records, with its sheet attached to the array rather than wrapping it:
 * restore() feeds a queue rebuild that only ever wanted the rows, and everything that does not
 * care about the CSV should keep reading the result as the plain list it has always been.
 */
export interface RestoredAutosave extends Array<AutosaveRecord> {
  csv?: AutosaveCsv;
}

export interface Autosave {
  /** Non-null while a previous session's records await a restore/discard decision. */
  pending: PendingRestore | null;
  /** Clears the store and hands back the records; the caller rebuilds queue items from them. */
  restore(): Promise<RestoredAutosave>;
  discard(): void;
  /**
   * Mirrors the queue's sheet into the meta store; null when no CSV is behind the queue any
   * more (cleared, or replaced by a file drop). Cheap to call on every remap — an unchanged
   * sheet is not rewritten, which matters when the text runs to megabytes.
   */
  saveCsv(csv: ProjectCsv | null): void;
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
export interface AutosaveOptions {
  /**
   * True when the queue on screen was carried across a client-side navigation rather than
   * rebuilt from scratch (lib/bg/session-store.ts). The records on disk then describe THESE
   * rows, so there is nothing to recover: prompting would ask the user to restore work they
   * are already looking at, and the blocking dialog would hold writes for a session that never
   * crashed. Ignored when the store turns out to be empty.
   */
  adopt?: boolean;
}

export function useAutosave(items: BgItem[], opts: AutosaveOptions = {}): Autosave {
  // Read once: a re-render after the queue is adopted must not change what boot decided.
  const adoptRef = React.useRef(opts.adopt ?? false);
  const [pending, setPending] = React.useState<PendingRestore | null>(null);
  const [lastSavedAt, setLastSavedAt] = React.useState<number | null>(null);
  const [failing, setFailing] = React.useState(false);
  // 'boot' -> reading the store; 'held' -> records await a decision; 'active' -> mirroring.
  const phaseRef = React.useRef<'boot' | 'held' | 'active'>('boot');
  const recordsRef = React.useRef<AutosaveRecord[]>([]);
  const heldCsvRef = React.useRef<AutosaveCsv | null>(null);
  const knownRef = React.useRef(new Map<number, Signature>());
  const persistAskedRef = React.useRef(false);
  // The sheet has its own one-slot pump, separate from the item diff: it is a single record,
  // it changes on a human's remap rather than on work completing, and its text can be megabytes
  // — so it is written only when it actually differs from what is on disk. `want` is the last
  // thing asked for (undefined = never asked, null = delete), `written` is what the store is
  // believed to hold (undefined = unknown, so the next request writes regardless).
  const csvWantRef = React.useRef<ProjectCsv | null | undefined>(undefined);
  const csvWrittenRef = React.useRef<ProjectCsv | null | undefined>(undefined);
  const csvWritingRef = React.useRef(false);
  const csvRetryRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // Created once for the same reason as the pump below: the writer re-invokes itself from its
  // own finally and from its retry timer.
  const [flushCsv] = React.useState(() => function flushCsvOnce(): void {
    // The held phase is not just about the item records: the sheet on disk belongs to the
    // crashed session too, and overwriting it before the user answers the prompt would hand
    // back rows whose CSV provenance points into a sheet they never came from.
    // A scheduled retry owns the next attempt. Without that check the failure path below would
    // re-enter from its own finally with the request still unsatisfied, and a store that is
    // rejecting (quota, private mode) would be hammered as fast as it can say no.
    if (phaseRef.current !== 'active' || csvWritingRef.current || csvRetryRef.current !== null) {
      return;
    }
    const want = csvWantRef.current;
    if (want === undefined) return;
    const written = csvWrittenRef.current;
    if (written !== undefined && sameCsv(want, written)) return;

    csvWritingRef.current = true;
    (want === null ? clearAutosaveCsv() : saveAutosaveCsv(want))
      .then(() => {
        csvWrittenRef.current = want;
      })
      .catch((e) => {
        // `written` is left alone so the next pass recomputes and retries. The timer is what
        // makes that pass happen: unlike an item record, the sheet is written once per import
        // and then sits idle, so a dropped write has nothing to piggyback on and would
        // otherwise stay dropped for the whole session.
        console.error('autosave: CSV write failed, will retry', e);
        if (csvRetryRef.current === null) {
          csvRetryRef.current = setTimeout(() => {
            csvRetryRef.current = null;
            flushCsvOnce();
          }, 5000);
        }
      })
      .finally(() => {
        csvWritingRef.current = false;
        // A remap that landed mid-write is still waiting in `want`.
        flushCsvOnce();
      });
  });

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([listAutosaved(), readAutosaveCsv().catch(() => null)])
      .then(([records, csv]) => {
        if (cancelled) return;
        if (records?.length && adoptRef.current) {
          // Same session, new mount. Seeding `known` from the live rows is what keeps this from
          // re-writing the whole queue on every product switch: nothing can have changed while
          // the page was unmounted, so what is on disk already matches what is in memory, and a
          // 3,000-row queue would otherwise re-put a gigabyte of blobs per hop.
          for (const item of latestItemsRef.current) {
            knownRef.current.set(item.id, signatureOf(item));
          }
          phaseRef.current = 'active';
          flushCsv();
        } else if (records?.length) {
          recordsRef.current = records;
          heldCsvRef.current = csv;
          phaseRef.current = 'held';
          setPending({
            count: records.length,
            savedAt: records.reduce((max, r) => Math.max(max, r.savedAt), 0),
            ...(csv ? { csvFileName: csv.fileName } : null),
          });
        } else {
          // A sheet with no records behind it can never be restored — the rows it produced were
          // plain drafts, which this module deliberately does not save — so it is megabytes of
          // text nothing will ever read. Deleting it through the same one-slot writer rather
          // than directly means a CSV dropped while this read was in flight wins the slot
          // instead of racing a delete that would land after it.
          if (csv && csvWantRef.current === undefined) csvWantRef.current = null;
          phaseRef.current = 'active';
          flushCsv();
        }
      })
      .catch(() => {
        // No IndexedDB (private mode, storage denied): the app must keep working without
        // recovery rather than fail with it. The flush still runs — a sheet dropped during the
        // failed read is queued in `want`, and whether the store answers is its problem, not a
        // reason to strand the request.
        if (!cancelled) {
          phaseRef.current = 'active';
          flushCsv();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [flushCsv]);

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
      if (csvRetryRef.current !== null) clearTimeout(csvRetryRef.current);
    },
    [],
  );

  const restore = React.useCallback(async (): Promise<RestoredAutosave> => {
    // Idempotent: a second call (double-click while the dialog animates out) must not run
    // clearAutosave again — that wipes the records the sync effect just re-put.
    if (phaseRef.current === 'active') return [] as RestoredAutosave;
    const records = recordsRef.current as RestoredAutosave;
    const csv = heldCsvRef.current;
    recordsRef.current = [];
    heldCsvRef.current = null;
    setPending(null);
    // Clear before rebuild: the sync effect re-puts every restored item under its NEW queue id,
    // so stale ids never linger to collide with future sessions. The sheet leaves with them and
    // returns the same way — through saveCsv, once the caller has it in state — so what ends up
    // on disk is this session's, never a leftover half of the one being replaced.
    await clearAutosave().catch(() => {});
    csvWrittenRef.current = undefined;
    phaseRef.current = 'active';
    flushCsv();
    if (csv) records.csv = csv;
    return records;
  }, [flushCsv]);

  const discard = React.useCallback(() => {
    if (phaseRef.current === 'active') return;
    recordsRef.current = [];
    heldCsvRef.current = null;
    setPending(null);
    phaseRef.current = 'active';
    // The flush waits for the clear instead of running beside it: a sheet dropped while the
    // dialog was still up is already queued in `want`, and an unsequenced flush would write it
    // only for this transaction to wipe it a moment later.
    void clearAutosave()
      .catch(() => {})
      .then(() => {
        csvWrittenRef.current = undefined;
        flushCsv();
      });
  }, [flushCsv]);

  const saveCsv = React.useCallback(
    (csv: ProjectCsv | null) => {
      csvWantRef.current = csv;
      flushCsv();
    },
    [flushCsv],
  );

  return { pending, restore, discard, saveCsv, lastSavedAt, failing };
}
