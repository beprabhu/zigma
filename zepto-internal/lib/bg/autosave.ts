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
// Two things are kept WHOLE rather than per item, in a second store, because neither belongs to
// any single row:
//
// The CSV a batch was imported from. It is what makes the drafts rule survivable: the unfinished
// rows are not on disk, but the sheet that produced them is, so a restored session can re-import
// whatever the crash interrupted — and the column mapping (which cell named which image) still
// resolves for the rows that did finish.
//
// The export ledger — which batches have been written out, and which items were in each. It
// cannot live on the items for a reason that is easy to miss: `batch` is deliberately outside
// `signatureOf` below, so stamping a sealed cohort rewrites NO item records. That is the whole
// point (2,000 items would re-put gigabytes of cutout blobs to record one number each), but it
// means the stamp only reaches disk when something else happens to rewrite the row. A crash
// straight after a seal therefore leaves 500 records that still read as unexported, and a
// restore trusting the per-item field alone would ship every one of them a second time in the
// next ZIP. One small record naming the ids is what makes the seal recoverable.
//
// Single-writer assumption: two tabs on /bg-remover would fight over one store (last writer
// wins). Accepted — this is single-user tooling; the store exists for crashes, not sync.

import * as React from 'react';

import type { BgItem, CsvOrigin } from './batch';
import type { InkFootprint, RegionReport } from './regions';
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
/**
 * The ledger's slot in that same store. A second singleton costs no version bump and must not
 * take one: `meta` is keyed by `key` and object stores hold no schema, so another record shape
 * under another key needs nothing from onupgradeneeded — while a bump would re-run it against
 * everyone's live `items` store mid-batch, which is exactly the risk v2's comment above refuses.
 */
const LEDGER_KEY = 'export-ledger';

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
  /**
   * The cohort this item shipped in, when it has shipped — what a restored item carries back
   * into the queue. Only ever as current as the last time this record was rewritten for some
   * other reason (see the signature note below for why a seal alone does not rewrite it), which
   * is why the ledger record, and not this field, is what decides what a batch contained.
   */
  batch?: number;
  /**
   * The evidence the quality verdict is computed from. Only a live run produces it, so a record
   * without it comes back re-judged on its bounding box alone — eight of the eleven checks
   * unable to fire, and a row that was flagged for residue or a surviving prop restored looking
   * clean. Written beside the cutout it describes, so the two can never disagree.
   */
  regions?: RegionReport[];
  removedRegions?: number;
  residueFraction?: number;
  /** The original's pre-matte footprint — what the coverage-collapse check reads. */
  originalInk?: InkFootprint;
}

/** The stored sheet. Same shape a .zesku carries, plus when this copy was written. */
export interface AutosaveCsv extends ProjectCsv {
  savedAt: number;
}

/**
 * One sealed export. A batch is born when its items are WRITTEN OUT, never when they are
 * flagged: flagged-ness moves under the user's feet — an AI fix un-flags a row while the run is
 * still going — so a cohort defined by it would shed members between the seal and the save, and
 * those images would ship in no ZIP at all. Membership is only ever recorded here, and on the
 * item, after a save has actually succeeded.
 */
export interface ExportedBatch {
  /** The number stamped onto BgItem.batch for every id below. Seal order, so it also orders
      the ZIPs — and the file numbering that runs continuously across them. */
  batch: number;
  /**
   * Queue ids as they were at export time — which is to say `AutosaveRecord.id`, NOT the id a
   * restored item ends up with. The restore path re-mints ids off the live queue, so these
   * resolve against the records coming off disk (match, then stamp the rebuilt item's `batch`),
   * and testing them against a live queue's ids after a restore matches nothing at all.
   */
  ids: number[];
  exportedAt: number;
  /** What the ZIP was saved as. Display only: the audit trail for "where did these go?". */
  fileName: string;
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
  // leave restored rows unable to resolve the cell they were named from. The ledger rides along
  // for the sharper version of the same problem — kept without its records it claims 500 images
  // already shipped, and the next session's first ZIP would start numbering at 501.
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

/** Field by field, like every other read off disk here: a stored record is still input. */
function parseLedgerMeta(v: unknown): ExportedBatch[] | null {
  if (!v || typeof v !== 'object') return null;
  const l = v as Record<string, unknown>;
  if (!Array.isArray(l.batches)) return null;
  const batches: ExportedBatch[] = [];
  for (const raw of l.batches) {
    if (!raw || typeof raw !== 'object') continue;
    const b = raw as Record<string, unknown>;
    if (typeof b.batch !== 'number' || !Number.isFinite(b.batch)) continue;
    const ids = Array.isArray(b.ids)
      ? b.ids.filter((id): id is number => typeof id === 'number' && Number.isFinite(id))
      : [];
    // An entry that parses down to no usable ids is not evidence that anything shipped, and
    // keeping it would under-count the files already written — which is the number the
    // continuous numbering across ZIPs is derived from, so the next export would restart on top
    // of names the previous one already used and unzipping both into one folder would lose half.
    if (!ids.length) continue;
    batches.push({
      batch: Math.round(b.batch),
      ids: ids.map((id) => Math.round(id)),
      exportedAt: typeof b.exportedAt === 'number' && Number.isFinite(b.exportedAt) ? b.exportedAt : 0,
      // Display only, so a missing name costs a label rather than the entry it describes.
      fileName: typeof b.fileName === 'string' ? b.fileName : '',
    });
  }
  // Nothing usable left is the same fact as no record at all, and every caller below already
  // has to handle "no ledger" — an empty array would be a second way to say it that the orphan
  // check and the dedup would each need to special-case.
  return batches.length ? batches : null;
}

export async function readAutosaveLedger(): Promise<ExportedBatch[] | null> {
  const raw = await withStore<unknown>(META_STORE, 'readonly', (store) => store.get(LEDGER_KEY));
  return parseLedgerMeta(raw);
}

export function saveAutosaveLedger(batches: ExportedBatch[]): Promise<void> {
  return withStore(META_STORE, 'readwrite', (store) =>
    store.put({
      key: LEDGER_KEY,
      // Rebuilt field by field rather than handed over as-is: the caller keeps these entries in
      // React state, and the structured clone would take along whatever a future entry shape
      // grows — a non-clonable value on one entry rejects the put for the whole ledger.
      batches: batches.map((b) => ({
        batch: b.batch,
        ids: [...b.ids],
        exportedAt: b.exportedAt,
        fileName: b.fileName,
      })),
    }),
  ).then(() => undefined);
}

export function clearAutosaveLedger(): Promise<void> {
  return withStore(META_STORE, 'readwrite', (store) => store.delete(LEDGER_KEY)).then(
    () => undefined,
  );
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

/**
 * Same rule, same reason: the ledger is state the page rebuilds — a hop to another product and
 * back rehydrates it as a fresh array of the same entries — so identity would rewrite it on
 * every mount. A seal only ever appends, so the length check settles the common case before any
 * ids are touched; the id scan then catches the one case a length cannot, a batch re-sealed
 * with different membership.
 */
function sameLedger(a: ExportedBatch[] | null, b: ExportedBatch[] | null): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return (
      x.batch === y.batch &&
      x.exportedAt === y.exportedAt &&
      x.fileName === y.fileName &&
      x.ids.length === y.ids.length &&
      x.ids.every((id, j) => id === y.ids[j])
    );
  });
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
    // Structured-cloned as-is. These ride along with the cutout that produced them, so the
    // identity diff below already covers them: nothing can change the analysis without also
    // replacing the blob it was measured from.
    ...(item.regionReport?.length ? { regions: item.regionReport } : null),
    ...(item.removedRegions !== undefined ? { removedRegions: item.removedRegions } : null),
    ...(item.cutout?.residueFraction !== undefined
      ? { residueFraction: item.cutout.residueFraction }
      : null),
    ...(item.originalInk ? { originalInk: item.originalInk } : null),
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
//   batch             stamped on a seal, and kept out so that stamping a 500-item cohort does
//                     not re-put 500 cutout blobs to record one number each. What makes that
//                     safe is NOT that a stale value is harmless — a record whose stamp never
//                     landed restores as unexported and gets shipped a second time — but that
//                     the export ledger holds the same membership by id in a record small
//                     enough to write on every seal, and restore reads it back first. Anything
//                     that re-groups a live queue without a side record like that must compare
//                     it BY VALUE here, and accept that a re-group then rewrites every record
//                     it touches.
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
  /**
   * How many images the held session had already exported, when it had exported any. The prompt
   * is where that has to be said: a recovered queue that is half shipped looks identical to a
   * fresh one on screen, and the user's next move — "export everything" — is the one move that
   * duplicates the ZIP already sitting in their downloads folder.
   */
  exportedCount?: number;
}

/**
 * The held session's records, with its sheet attached to the array rather than wrapping it:
 * restore() feeds a queue rebuild that only ever wanted the rows, and everything that does not
 * care about the CSV should keep reading the result as the plain list it has always been.
 */
export interface RestoredAutosave extends Array<AutosaveRecord> {
  csv?: AutosaveCsv;
  /**
   * The held session's export ledger, absent when it had never exported. Read it BEFORE handing
   * the records to the queue rebuild: its ids are the record ids in this same array, and the
   * rebuild re-mints them — so the window in which "was this item already exported?" can still
   * be answered closes the moment the new items exist.
   */
  ledger?: ExportedBatch[];
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
  /**
   * Mirrors the export ledger into the meta store; null (or an empty list) when nothing has
   * shipped yet. Call it right after a save SUCCEEDS, in the same breath as stamping
   * `BgItem.batch` — a ledger written before the bytes land would survive a crash claiming a
   * ZIP the user never got, and those items would then be held back from every later export.
   * Cheap to call on every render: an unchanged ledger is not rewritten.
   */
  saveLedger(batches: ExportedBatch[] | null): void;
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
  // The ledger gets its own slot rather than sharing the sheet's, for the reason a shared one
  // would hurt: a seal lands mid-run and must reach disk now, while the sheet's write can be
  // megabytes of text — queueing the ledger behind it would leave the window where a crash
  // costs a re-export open for exactly as long as the CSV takes. They also fail independently,
  // and a rejecting sheet must not take the ledger's retry down with it.
  const ledgerWantRef = React.useRef<ExportedBatch[] | null | undefined>(undefined);
  const ledgerWrittenRef = React.useRef<ExportedBatch[] | null | undefined>(undefined);
  const ledgerWritingRef = React.useRef(false);
  const ledgerRetryRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldLedgerRef = React.useRef<ExportedBatch[] | null>(null);
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

  // Same one-slot writer, same three guards, for the same reasons — see flushCsvOnce above.
  const [flushLedger] = React.useState(() => function flushLedgerOnce(): void {
    // Holding through the boot decision matters more here than anywhere else: this session's
    // ledger starts empty, so writing it while the crashed one's is still on disk would erase
    // the record of the ZIP that already shipped. The user then answers "restore", gets 550
    // rows back with nothing marked as exported, and the next export re-ships the 500 they
    // already have — under file numbers 1-500, colliding with the ZIP on their disk.
    if (phaseRef.current !== 'active' || ledgerWritingRef.current || ledgerRetryRef.current !== null) {
      return;
    }
    const want = ledgerWantRef.current;
    if (want === undefined) return;
    const written = ledgerWrittenRef.current;
    if (written !== undefined && sameLedger(want, written)) return;

    ledgerWritingRef.current = true;
    (want === null ? clearAutosaveLedger() : saveAutosaveLedger(want))
      .then(() => {
        ledgerWrittenRef.current = want;
      })
      .catch((e) => {
        // Left unwritten so the next pass recomputes and retries, and timed for the same reason
        // the sheet is: seals are minutes apart, so a dropped write has nothing to ride out on
        // and would otherwise stay dropped until the next batch seals — through the whole
        // window where a crash costs a duplicate export.
        console.error('autosave: export ledger write failed, will retry', e);
        if (ledgerRetryRef.current === null) {
          ledgerRetryRef.current = setTimeout(() => {
            ledgerRetryRef.current = null;
            flushLedgerOnce();
          }, 5000);
        }
      })
      .finally(() => {
        ledgerWritingRef.current = false;
        // A seal that landed mid-write is still waiting in `want`.
        flushLedgerOnce();
      });
  });

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([
      listAutosaved(),
      readAutosaveCsv().catch(() => null),
      readAutosaveLedger().catch(() => null),
    ])
      .then(([records, csv, ledger]) => {
        if (cancelled) return;
        if (records?.length && adoptRef.current) {
          // Same session, new mount. Seeding `known` from the live rows is what keeps this from
          // re-writing the whole queue on every product switch: nothing can have changed while
          // the page was unmounted, so what is on disk already matches what is in memory, and a
          // 3,000-row queue would otherwise re-put a gigabyte of blobs per hop.
          for (const item of latestItemsRef.current) {
            knownRef.current.set(item.id, signatureOf(item));
          }
          // Same argument one record further along: the ledger on disk was written by this very
          // session before the hop, so seeding it as "already written" keeps a product switch
          // from re-putting it. Only `written` is seeded, never `want` — a stale disk ledger
          // must never become something this session asks to be kept.
          ledgerWrittenRef.current = ledger;
          phaseRef.current = 'active';
          flushCsv();
          flushLedger();
        } else if (records?.length) {
          recordsRef.current = records;
          heldCsvRef.current = csv;
          heldLedgerRef.current = ledger;
          phaseRef.current = 'held';
          setPending({
            count: records.length,
            savedAt: records.reduce((max, r) => Math.max(max, r.savedAt), 0),
            ...(csv ? { csvFileName: csv.fileName } : null),
            ...(ledger
              ? { exportedCount: ledger.reduce((total, b) => total + b.ids.length, 0) }
              : null),
          });
        } else {
          // A sheet with no records behind it can never be restored — the rows it produced were
          // plain drafts, which this module deliberately does not save — so it is megabytes of
          // text nothing will ever read. Deleting it through the same one-slot writer rather
          // than directly means a CSV dropped while this read was in flight wins the slot
          // instead of racing a delete that would land after it.
          if (csv && csvWantRef.current === undefined) csvWantRef.current = null;
          // An orphan ledger goes the same way, and is the more dangerous of the two to keep: a
          // ledger names ids in a queue that no longer exists, so nothing can ever be matched
          // against it again, while the count it carries would still push this session's first
          // ZIP to start at 501. Deleted through the writer rather than directly for the same
          // reason as the sheet — a seal racing this read wins the slot instead of being wiped
          // by a delete that lands after it.
          if (ledger && ledgerWantRef.current === undefined) ledgerWantRef.current = null;
          phaseRef.current = 'active';
          flushCsv();
          flushLedger();
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
          flushLedger();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [flushCsv, flushLedger]);

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
      if (ledgerRetryRef.current !== null) clearTimeout(ledgerRetryRef.current);
    },
    [],
  );

  const restore = React.useCallback(async (): Promise<RestoredAutosave> => {
    // Idempotent: a second call (double-click while the dialog animates out) must not run
    // clearAutosave again — that wipes the records the sync effect just re-put.
    if (phaseRef.current === 'active') return [] as RestoredAutosave;
    const records = recordsRef.current as RestoredAutosave;
    const csv = heldCsvRef.current;
    const ledger = heldLedgerRef.current;
    recordsRef.current = [];
    heldCsvRef.current = null;
    heldLedgerRef.current = null;
    setPending(null);
    // Clear before rebuild: the sync effect re-puts every restored item under its NEW queue id,
    // so stale ids never linger to collide with future sessions. The sheet leaves with them and
    // returns the same way — through saveCsv, once the caller has it in state — so what ends up
    // on disk is this session's, never a leftover half of the one being replaced.
    await clearAutosave().catch(() => {});
    csvWrittenRef.current = undefined;
    ledgerWrittenRef.current = undefined;
    phaseRef.current = 'active';
    flushCsv();
    flushLedger();
    if (csv) records.csv = csv;
    // The ledger comes back the same way the sheet does — through saveLedger, once the caller
    // holds it in state — so the ids the caller stamps onto the rebuilt items and the ids that
    // end up on disk are one decision, not two that a crash in between could split.
    if (ledger) records.ledger = ledger;
    return records;
  }, [flushCsv, flushLedger]);

  const discard = React.useCallback(() => {
    if (phaseRef.current === 'active') return;
    recordsRef.current = [];
    heldCsvRef.current = null;
    heldLedgerRef.current = null;
    setPending(null);
    phaseRef.current = 'active';
    // The flush waits for the clear instead of running beside it: a sheet dropped while the
    // dialog was still up is already queued in `want`, and an unsequenced flush would write it
    // only for this transaction to wipe it a moment later.
    void clearAutosave()
      .catch(() => {})
      .then(() => {
        csvWrittenRef.current = undefined;
        ledgerWrittenRef.current = undefined;
        flushCsv();
        flushLedger();
      });
  }, [flushCsv, flushLedger]);

  const saveCsv = React.useCallback(
    (csv: ProjectCsv | null) => {
      csvWantRef.current = csv;
      flushCsv();
    },
    [flushCsv],
  );

  const saveLedger = React.useCallback(
    (batches: ExportedBatch[] | null) => {
      // An empty ledger and no ledger are the same fact — nothing has shipped — so the empty
      // case collapses to the delete instead of putting a record that says nothing. It also
      // keeps `want` down to two states, which is what lets the dedup above be a plain compare
      // rather than one that has to treat [] and null as equal.
      ledgerWantRef.current = batches && batches.length ? batches : null;
      flushLedger();
    },
    [flushLedger],
  );

  return { pending, restore, discard, saveCsv, saveLedger, lastSavedAt, failing };
}
