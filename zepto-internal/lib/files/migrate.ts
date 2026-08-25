'use client';

// One-time import of the old single-session crash net (the "zesku-bg-autosave" database)
// into the file store, as one pinned Cleanup file.
//
// This is what turns the modal into a card. The old store held exactly one unnamed session and
// announced it with a blocking Restore/Discard dialog on every reload; after this runs it is a file
// on the homepage called "Recovered session", pinned so the 7-day sweep can never take it, and the
// user restores it by clicking it like anything else.
//
// Three properties it has to have, in order of how badly the absence hurts:
//
// EXACTLY ONCE ACROSS TABS. The marker is claimed with store.add() — which throws ConstraintError
// when the key exists — BEFORE anything is read. Claiming after minting a file id (the obvious
// ordering) lets two tabs both see "no marker", both mint a different uuid, and both copy-and-delete
// chunks out of the source: one crash net split across two files, irrecoverably, because the rows
// are gone from the old store by the time anyone notices.
//
// RESUMABLE. Rows are deleted from the old store as they land in the new one, so a tab closed
// halfway leaves the remainder exactly where the next run expects it. A stale claim is taken over
// under the SAME file id, never a fresh one.
//
// NON-DESTRUCTIVE ON FAILURE. Anything that throws leaves the old database intact and the marker
// releasable. The old stores are cleared only after the last row has been written, and the database
// is cleared rather than deleted: deleteDatabase() blocks on any open connection, and a blocked
// delete is a promise that never settles.

import { FILES_STORE, ITEMS_STORE, META_STORE, rawTx } from './db';
import { CSV_KEY, LEDGER_KEY, TAB_ID, newFileRecord } from './store';
import { CUTOUT_BLOB, SOURCE_BLOB, type BgDoc, type BgItemData } from './codecs/bg';
import type { FileRecord, ItemRecord, MetaRecord } from './types';

const OLD_DB = 'zesku-bg-autosave';
const OLD_ITEMS = 'items';
const OLD_META = 'meta';
const OLD_CSV_KEY = 'csv';
const OLD_LEDGER_KEY = 'export-ledger';

/** Records under this synthetic file id are app-level, not any real file's. A uuid can never be it. */
const APP_SCOPE = '@app';
const MARKER_KEY = 'migration:bg-autosave';

/** How stale a 'running' claim has to be before another tab may take it over. */
const CLAIM_STALE_MS = 60_000;
/** Rows per transaction — the same order as WRITE_CHUNK, for the same gigabytes-at-once reason. */
const MIGRATE_CHUNK = 12;

interface Marker {
  state: 'running' | 'done';
  fileId: string;
  tabId: string;
  at: number;
}

// ---- The old record shape (read-only; the old module is being retired) ----

interface OldRecord {
  id: number;
  name: string;
  origin: string;
  sourceUrl: string | null;
  sourceFile: Blob | null;
  sourceFileName: string | null;
  cutout: Blob | null;
  bounds: BgItemData['bounds'];
  width: number;
  height: number;
  savedAt: number;
  csv?: BgItemData['csv'];
  originalSourceUrl?: string;
  batch?: number;
  regions?: BgItemData['regions'];
  removedRegions?: number;
  residueFraction?: number;
  originalInk?: BgItemData['originalInk'];
  components?: BgItemData['components'];
  verify?: BgItemData['verify'];
  bands?: BgItemData['bands'];
}

// ---- Old-database access --------------------------------------------------

/** True when the old database actually exists, so probing never creates an empty one. */
async function oldDbExists(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  if (typeof indexedDB.databases !== 'function') return true; // can't tell; the open below copes
  try {
    const list = await indexedDB.databases();
    return list.some((d) => d.name === OLD_DB);
  } catch {
    return true;
  }
}

/** Opens at whatever version is on disk — never triggers an upgrade of a store being retired. */
function openOld(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OLD_DB);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('migrate: old database is blocked'));
  });
}

function oldTx<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const req = run(tx);
    tx.oncomplete = () => resolve(req ? (req.result as T) : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ---- Marker ---------------------------------------------------------------

function readMarker(): Promise<Marker | null> {
  return rawTx<MetaRecord | undefined>(
    [META_STORE],
    'readonly',
    (tx) => tx.objectStore(META_STORE).get([APP_SCOPE, MARKER_KEY]) as IDBRequest<MetaRecord | undefined>,
  ).then((rec) => (rec ? ((rec.value as Marker) ?? null) : null));
}

function writeMarker(value: Marker): Promise<void> {
  return rawTx([META_STORE], 'readwrite', (tx) => {
    tx.objectStore(META_STORE).put({
      fileId: APP_SCOPE,
      key: MARKER_KEY,
      savedAt: Date.now(),
      value,
    } satisfies MetaRecord);
  }).then(() => undefined);
}

/**
 * Claims the migration, or reports who holds it.
 *
 * `add` rather than `put` is the whole mechanism: it throws ConstraintError if the key exists, and
 * that throw is what makes the claim atomic against another tab racing the same code path.
 */
async function claim(): Promise<{ mine: boolean; fileId: string; done: boolean }> {
  const fresh: Marker = { state: 'running', fileId: crypto.randomUUID(), tabId: TAB_ID, at: Date.now() };
  try {
    await rawTx([META_STORE], 'readwrite', (tx) => {
      tx.objectStore(META_STORE).add({
        fileId: APP_SCOPE,
        key: MARKER_KEY,
        savedAt: Date.now(),
        value: fresh,
      } satisfies MetaRecord);
    });
    return { mine: true, fileId: fresh.fileId, done: false };
  } catch {
    // Someone got there first — this run, or an earlier one.
  }

  const held = await readMarker();
  if (!held) return { mine: false, fileId: '', done: true };
  if (held.state === 'done') return { mine: false, fileId: held.fileId, done: true };
  if (Date.now() - held.at < CLAIM_STALE_MS) return { mine: false, fileId: held.fileId, done: false };

  // Stale claim: take over, keeping the SAME file id. Minting a new one here is what would split
  // the source across two files, since the rows this run finds are the ones the dead run had not
  // yet copied.
  await writeMarker({ ...held, tabId: TAB_ID, at: Date.now() });
  return { mine: true, fileId: held.fileId, done: false };
}

// ---- The copy -------------------------------------------------------------

function payloadOf(old: OldRecord): { data: BgItemData; blobs: Record<string, Blob> } {
  const data: BgItemData = {
    name: old.name ?? '',
    origin: old.origin ?? '',
    sourceUrl: old.sourceUrl ?? null,
    sourceFileName: old.sourceFileName ?? null,
    bounds: old.bounds ?? null,
    width: old.width ?? 0,
    height: old.height ?? 0,
    ...(old.residueFraction !== undefined ? { residueFraction: old.residueFraction } : null),
    ...(old.csv ? { csv: old.csv } : null),
    ...(old.originalSourceUrl ? { originalSourceUrl: old.originalSourceUrl } : null),
    ...(old.batch !== undefined ? { batch: old.batch } : null),
    ...(old.regions?.length ? { regions: old.regions } : null),
    ...(old.removedRegions !== undefined ? { removedRegions: old.removedRegions } : null),
    ...(old.originalInk ? { originalInk: old.originalInk } : null),
    ...(old.components?.length ? { components: old.components } : null),
    ...(old.verify ? { verify: old.verify } : null),
    ...(old.bands?.length ? { bands: old.bands } : null),
  };
  const blobs: Record<string, Blob> = {};
  if (old.cutout) blobs[CUTOUT_BLOB] = old.cutout;
  if (old.sourceFile) blobs[SOURCE_BLOB] = old.sourceFile;
  return { data, blobs };
}

interface OldLedgerEntry {
  batch: number;
  ids: number[];
  exportedAt: number;
  fileName: string;
}

function batchIdsFrom(ledger: unknown): [number, number[]][] {
  const raw = (ledger as { batches?: unknown } | null)?.batches;
  if (!Array.isArray(raw)) return [];
  const out: [number, number[]][] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const b = entry as Partial<OldLedgerEntry>;
    if (typeof b.batch !== 'number' || !Number.isFinite(b.batch)) continue;
    const ids = Array.isArray(b.ids)
      ? b.ids.filter((id): id is number => typeof id === 'number' && Number.isFinite(id))
      : [];
    if (!ids.length) continue;
    out.push([Math.round(b.batch), ids]);
  }
  return out;
}

async function importOldSession(fileId: string): Promise<number> {
  const db = await openOld();
  try {
    if (!db.objectStoreNames.contains(OLD_ITEMS)) return 0;

    // The sheet and the ledger first: they are small, and a run interrupted after the rows but
    // before these would leave restored rows unable to resolve the cell they were named from.
    let csv: unknown = null;
    let ledger: unknown = null;
    if (db.objectStoreNames.contains(OLD_META)) {
      // Both come back FLAT — the old meta store is keyed by `key`, so the payload fields sit
      // beside it on the record rather than under a `value`.
      csv = await oldTx<unknown>(db, [OLD_META], 'readonly', (tx) =>
        tx.objectStore(OLD_META).get(OLD_CSV_KEY),
      );
      ledger = await oldTx<unknown>(db, [OLD_META], 'readonly', (tx) =>
        tx.objectStore(OLD_META).get(OLD_LEDGER_KEY),
      );
    }

    const batchIds = batchIdsFrom(ledger);
    const now = Date.now();

    // The header goes in BEFORE the rows, and pinned. A migration interrupted at any point after
    // this leaves a reachable, un-sweepable card holding whatever made it across, rather than
    // orphaned item records with no header to find them by.
    const header: FileRecord = {
      ...newFileRecord(fileId, 'bg-remover', now),
      name: 'Recovered session',
      keptAt: now,
      schema: 1,
      doc: {
        sessionName: 'Recovered session',
        allocFloor: null,
        batchIds,
        rowCount: 0,
      } satisfies BgDoc,
    };
    await rawTx([FILES_STORE], 'readwrite', (tx) => {
      tx.objectStore(FILES_STORE).put(header);
    });

    if (csv && typeof csv === 'object') {
      const c = csv as Record<string, unknown>;
      await rawTx([META_STORE], 'readwrite', (tx) => {
        tx.objectStore(META_STORE).put({
          fileId,
          key: CSV_KEY,
          savedAt: now,
          // Re-shaped field by field: the old record carried its own primary key alongside the
          // payload, and copying it verbatim would put a stray `key` into the new value.
          value: {
            fileName: c.fileName,
            text: c.text,
            nameColumns: c.nameColumns ?? c.nameColumn,
            imageColumns: c.imageColumns,
            promptColumns: c.promptColumns,
          },
        } satisfies MetaRecord);
      });
    }
    if (batchIds.length) {
      await rawTx([META_STORE], 'readwrite', (tx) => {
        tx.objectStore(META_STORE).put({
          fileId,
          key: LEDGER_KEY,
          savedAt: now,
          value: (ledger as { batches?: unknown }).batches,
        } satisfies MetaRecord);
      });
    }

    // Chunked copy-then-delete. `getAll(null, N)` always returns the next N because the previous N
    // are gone by the time it runs — which is also what makes an interrupted run resumable.
    let moved = 0;
    for (;;) {
      const batch = await oldTx<OldRecord[]>(db, [OLD_ITEMS], 'readonly', (tx) =>
        tx.objectStore(OLD_ITEMS).getAll(null, MIGRATE_CHUNK),
      );
      if (!batch?.length) break;

      const records: ItemRecord[] = batch.map((old) => ({
        fileId,
        id: old.id,
        savedAt: old.savedAt ?? now,
        ...payloadOf(old),
      }));
      await rawTx([ITEMS_STORE], 'readwrite', (tx) => {
        const store = tx.objectStore(ITEMS_STORE);
        for (const record of records) store.put(record);
      });
      // Only now is it safe to drop the source rows.
      await oldTx(db, [OLD_ITEMS], 'readwrite', (tx) => {
        const store = tx.objectStore(OLD_ITEMS);
        for (const old of batch) store.delete(old.id);
      });

      moved += batch.length;
      // Keeps the claim fresh so a long migration is never mistaken for a dead one.
      await writeMarker({ state: 'running', fileId, tabId: TAB_ID, at: Date.now() });
    }

    // Everything is across. Clear rather than delete — deleteDatabase blocks on any open
    // connection, and this tab may well have one from a page that has not unmounted yet.
    const stores = [OLD_ITEMS, ...(db.objectStoreNames.contains(OLD_META) ? [OLD_META] : [])];
    await oldTx(db, stores, 'readwrite', (tx) => {
      for (const name of stores) tx.objectStore(name).clear();
    });

    await rawTx([FILES_STORE], 'readwrite', (tx) => {
      const store = tx.objectStore(FILES_STORE);
      const get = store.get(fileId);
      get.onsuccess = () => {
        const current = get.result as FileRecord | undefined;
        if (current) store.put({ ...current, itemCount: moved, updatedAt: Date.now() });
      };
    });

    return moved;
  } finally {
    db.close();
  }
}

// ---- Entry point ----------------------------------------------------------

/**
 * Runs every one-time migration. Called once per tab by db.ts's `whenReady`, and awaited by every
 * application read and write — which is what makes "the migration finished first" a fact rather
 * than a scheduling hope.
 */
export async function runMigrations(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;

  const marker = await readMarker().catch(() => null);
  if (marker?.state === 'done') return;

  if (!(await oldDbExists())) {
    // Nothing to bring across. Record that, so no later run pays for the probe again.
    await writeMarker({ state: 'done', fileId: '', tabId: TAB_ID, at: Date.now() }).catch(() => {});
    return;
  }

  const held = await claim();
  if (held.done) return;
  if (!held.mine) {
    // Another live tab is doing it. Its writes will land; this one simply proceeds, and the store
    // it reads is the same store that tab is filling.
    return;
  }

  try {
    const moved = await importOldSession(held.fileId);
    await writeMarker({ state: 'done', fileId: held.fileId, tabId: TAB_ID, at: Date.now() });
    if (moved) console.info(`files: recovered ${moved} item(s) from the previous autosave`);
  } catch (e) {
    // The claim is left as 'running' with this tab's timestamp: it goes stale in a minute and the
    // next run takes over the same file id and picks up from whatever is left in the old store.
    console.error('files: could not import the previous autosave', e);
    throw e;
  }
}
