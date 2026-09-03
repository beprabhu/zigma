'use client';

// Reads and writes over the three stores. No React here — the hook in use-file-store.ts owns all
// the scheduling, this module owns the transactions.

import {
  BY_UPDATED,
  FILES_STORE,
  ITEMS_STORE,
  META_STORE,
  fileRange,
  metaKey,
  withStore,
  withTx,
} from './db';
import { forgetOpen } from './open';
import { clearSession, readSession, sessionKey } from '../session-store';
import type { SessionSnapshot } from '../session-store';
import type { FileRecord, ItemId, ItemRecord, MetaRecord, ToolSlug } from './types';

/** Per-file singleton keys. */
export const CSV_KEY = 'csv';
/**
 * Generate's brief — the instruction document every row's prompt is built on.
 *
 * A singleton rather than part of the doc for the same reason the sheet is one: it runs to
 * document length, and listFiles() reads every doc on every homepage mount.
 */
export const BRIEF_KEY = 'brief';
export const LEDGER_KEY = 'ledger';
/** The open-tab heartbeat — see `touchLock`. */
export const LOCK_KEY = 'lock';

/**
 * One sealed export, as stored under LEDGER_KEY.
 *
 * It exists because `BgItem.batch` is deliberately outside the change signature — stamping
 * a 500-image cohort must not re-put 500 cutout blobs to record one number each — so a stamp that
 * moves on its own never reaches the item records. A merge or a split moves nothing BUT stamps,
 * which makes this the only copy of batch membership that is still correct afterwards, and
 * therefore the one a reopened file has to trust over the rows' own stored numbers.
 */
export interface ExportedBatch {
  batch: number;
  /** Member ids, as they were when the batch was written. */
  ids: number[];
  exportedAt: number;
  /** What the ZIP was saved as. Display only. */
  fileName: string;
  /**
   * Where this batch's file numbers begin, and how many it wrote — the two facts a reopened file
   * needs to hand the same names back.
   *
   * Both optional because files written before this existed have neither, and a batch restored
   * without them can still be listed; it just cannot be downloaded again, because guessing a
   * starting number would write a ZIP whose names collide with the one already on disk.
   */
  offset?: number;
  count?: number;
}

/**
 * How stale a heartbeat has to be before the file counts as closed.
 *
 * Generous on purpose: the cost of treating a live file as closed is deleting work someone is
 * looking at, and the cost of treating a dead one as live is that a file survives one sweep and goes
 * on the next. Those are not the same mistake.
 */
export const LOCK_STALE_MS = 30_000;
export const LOCK_BEAT_MS = 10_000;

/** This tab, for the lifetime of the module. Lets a heartbeat tell "me" from "some other tab". */
export const TAB_ID =
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Math.random()}`;

export interface LockValue {
  tabId: string;
  at: number;
}

// ---- Cross-tab notification ----------------------------------------------

export type FilesEvent =
  | { type: 'deleted'; fileId: string }
  | { type: 'changed'; fileId: string };

const CHANNEL = 'zigma-files';

let channel: BroadcastChannel | null = null;
function bus(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!channel) channel = new BroadcastChannel(CHANNEL);
  return channel;
}

export function broadcast(event: FilesEvent): void {
  try {
    bus()?.postMessage(event);
  } catch {
    // A closed or unavailable channel must never take down the write that just succeeded.
  }
}

/** Subscribe to other tabs' file events. Returns the unsubscribe. */
export function subscribe(onEvent: (event: FilesEvent) => void): () => void {
  const b = bus();
  if (!b) return () => {};
  const handler = (e: MessageEvent<FilesEvent>) => onEvent(e.data);
  b.addEventListener('message', handler);
  return () => b.removeEventListener('message', handler);
}

// ---- Files ----------------------------------------------------------------

/**
 * Every file, newest first — one card each on the homepage.
 *
 * Reads the whole store, which is only affordable because FileRecord is small by construction: the
 * thumbnail is a downscaled WebP and `doc` is barred from holding anything that scales with the
 * sheet (see ToolCodec.docOf). Soft-deleted files are included; the caller splits them into the
 * grid and Trash, because both views come from this one read.
 */
export async function listFiles(): Promise<FileRecord[]> {
  const all = await withStore<FileRecord[]>(FILES_STORE, 'readonly', (store) =>
    store.index(BY_UPDATED).getAll(),
  );
  return (all ?? []).reverse();
}

export async function readFile(id: string): Promise<FileRecord | null> {
  const rec = await withStore<FileRecord | undefined>(FILES_STORE, 'readonly', (store) =>
    store.get(id),
  );
  return rec ?? null;
}

/**
 * Read-modify-write of one file's header, inside a single transaction.
 *
 * Every header change goes through here rather than putting a record the caller assembled, because
 * the header has two independent writers: the tool page (name, thumb, counts, updatedAt) and the
 * homepage (Keep, delete). A put built from a stale read silently un-pins a file the user just
 * pinned, or resurrects one they just deleted. `patch` receives the record as it is on disk right
 * now and returns what to store; returning null leaves it alone.
 */
export async function patchFile(
  id: string,
  patch: (current: FileRecord | null) => FileRecord | null,
): Promise<FileRecord | null> {
  let result: FileRecord | null = null;
  await withTx([FILES_STORE], 'readwrite', (tx) => {
    const store = tx.objectStore(FILES_STORE);
    const get = store.get(id);
    get.onsuccess = () => {
      const next = patch((get.result as FileRecord | undefined) ?? null);
      if (next) {
        result = next;
        store.put(next);
      }
    };
  });
  if (result) broadcast({ type: 'changed', fileId: id });
  return result;
}

export function newFileRecord(id: string, tool: ToolSlug, at: number): FileRecord {
  return {
    id,
    tool,
    name: '',
    createdAt: at,
    updatedAt: at,
    keptAt: null,
    deletedAt: null,
    thumb: null,
    itemCount: 0,
    bytes: 0,
    schema: 0,
    doc: null,
  };
}

/** The Keep toggle. Pinning also lifts a file back out of Trash — it is the undo for an expiry. */
export function setKept(id: string, kept: boolean): Promise<FileRecord | null> {
  const at = Date.now();
  return patchFile(id, (current) =>
    current ? { ...current, keptAt: kept ? at : null, deletedAt: kept ? null : current.deletedAt } : null,
  );
}

export function setName(id: string, name: string): Promise<FileRecord | null> {
  return patchFile(id, (current) => (current ? { ...current, name } : null));
}

// ---- Items ----------------------------------------------------------------

/** ~1 MB blobs, two dozen per transaction — sized so one failure cannot lose a whole restore. */
export const WRITE_CHUNK = 24;
/**
 * The read side of the same argument. Writes are sized so one transaction cannot
 * move gigabytes and fail wholesale; a getAll over a 3,000-item file has exactly that shape, and it
 * also spikes memory with every blob deserialized at once. A cursor hands them over in chunks.
 */
export const LOAD_CHUNK = 24;

/**
 * Streams one file's item records in chunks, oldest key first.
 *
 * `onChunk` MUST be synchronous — awaiting inside a cursor walk lets the transaction auto-close
 * between microtasks and the rest of the records never arrive. Committing them into React state is
 * exactly the right amount of work to do there.
 */
export async function loadItems(
  fileId: string,
  onChunk: (records: ItemRecord[]) => void,
): Promise<number> {
  let total = 0;
  let buffer: ItemRecord[] = [];
  await withTx([ITEMS_STORE], 'readonly', (tx) => {
    const req = tx.objectStore(ITEMS_STORE).openCursor(fileRange(fileId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        if (buffer.length) {
          onChunk(buffer);
          buffer = [];
        }
        return;
      }
      buffer.push(cursor.value as ItemRecord);
      total += 1;
      if (buffer.length >= LOAD_CHUNK) {
        onChunk(buffer);
        buffer = [];
      }
      cursor.continue();
    };
  });
  return total;
}

/**
 * One chunk of puts and deletes.
 *
 * Deletes run FIRST, in their own pass: under quota
 * pressure the user's own pruning has to be able to free space, or failing puts starve the deletes
 * forever and the store wedges.
 */
export async function writeItems(
  fileId: string,
  puts: ItemRecord[],
  deletes: ItemId[],
): Promise<void> {
  if (!puts.length && !deletes.length) return;
  await withTx([ITEMS_STORE], 'readwrite', (tx) => {
    const store = tx.objectStore(ITEMS_STORE);
    for (const id of deletes) store.delete([fileId, id]);
    for (const record of puts) store.put(record);
  });
}

// ---- Meta -----------------------------------------------------------------

export async function readMeta<T>(fileId: string, key: string): Promise<T | null> {
  const rec = await withStore<MetaRecord | undefined>(META_STORE, 'readonly', (store) =>
    store.get(metaKey(fileId, key)),
  );
  return rec ? (rec.value as T) : null;
}

export async function writeMeta(fileId: string, key: string, value: unknown): Promise<void> {
  await withStore(META_STORE, 'readwrite', (store) =>
    store.put({ fileId, key, savedAt: Date.now(), value } satisfies MetaRecord),
  );
}

export async function clearMeta(fileId: string, key: string): Promise<void> {
  await withStore(META_STORE, 'readwrite', (store) => store.delete(metaKey(fileId, key)));
}

// ---- The open-file heartbeat ---------------------------------------------

/**
 * Says "a tab has this file open" in a place other tabs can read.
 *
 * A module-scope registry would be simpler and would be wrong: it is tab-local, and the homepage is
 * the very thing that makes a second tab normal. Without a fact on disk, tab B's boot sweep can
 * delete the file tab A is working in — and tab A's pump then keeps writing item records under a
 * fileId with no FileRecord, invisible to the homepage AND to the sweep, i.e. unreclaimable.
 *
 * Written before any content write, so the window between opening a file and first saving into it
 * is covered too.
 */
export function touchLock(fileId: string): Promise<void> {
  return writeMeta(fileId, LOCK_KEY, { tabId: TAB_ID, at: Date.now() } satisfies LockValue);
}


/** Whether ANOTHER tab has beaten recently. Reads inside the caller's transaction where it matters. */
export function isHeldElsewhere(lock: unknown, now: number): boolean {
  if (!lock || typeof lock !== 'object') return false;
  const v = lock as Partial<LockValue>;
  if (typeof v.at !== 'number' || !Number.isFinite(v.at)) return false;
  if (v.tabId === TAB_ID) return false;
  return now - v.at < LOCK_STALE_MS;
}

// ---- Delete ---------------------------------------------------------------

export interface DeleteResult {
  deleted: boolean;
  /** Set when the delete was refused because another tab has the file open. */
  heldElsewhere?: boolean;
}

/**
 * Drops the tab's live snapshot of this file, wherever a product is holding one.
 *
 * The resume pointer is not the only thing that can still name a dead file. Every product saves a
 * snapshot carrying its fileId on unmount, and resolveOpen (lib/files/open.ts) prefers that
 * snapshot over the pointer — so without this the next rail click mounts the page 'adopted' over
 * the deleted queue, `known` starts empty because there is nothing left on disk to seed it from,
 * the pump reads every row as new and the header writer re-mints the header. The file comes back
 * whole, minutes after the user watched it go.
 *
 * Matched by fileId rather than cleared by tool: the snapshot under a tool's slug is very often a
 * DIFFERENT file of that tool, and it holds the only copy of everything the disk never sees —
 * dropped File handles, decoded originals — so clearing it over an unrelated delete loses work.
 */
function forgetSession(fileId: string): void {
  for (const tool of ['compositor', 'bg-remover', 'image-generator', 'png-compressor'] as const) {
    // Snapshots are keyed by product slug; see lib/session-store.ts.
    const key = sessionKey<SessionSnapshot>(tool);
    if (readSession(key)?.fileId === fileId) clearSession(key);
  }
}

/**
 * Erases a file and everything under it, in ONE transaction over all three stores.
 *
 * One transaction because a half-delete is worse than either outcome: items with no header are
 * unreachable bytes the homepage can never offer to reclaim, and a header with no items is a card
 * that opens onto an empty queue.
 *
 * Refuses when another tab holds a fresh heartbeat. The check has to happen INSIDE this transaction
 * — a read before it is a decision made on a fact that can change before the delete lands.
 */
export async function deleteFile(fileId: string, opts: { force?: boolean } = {}): Promise<DeleteResult> {
  let heldElsewhere = false;
  await withTx([FILES_STORE, ITEMS_STORE, META_STORE], 'readwrite', (tx) => {
    const meta = tx.objectStore(META_STORE);
    const lockReq = meta.get(metaKey(fileId, LOCK_KEY));
    lockReq.onsuccess = () => {
      const lock = (lockReq.result as MetaRecord | undefined)?.value;
      if (!opts.force && isHeldElsewhere(lock, Date.now())) {
        heldElsewhere = true;
        return;
      }
      tx.objectStore(FILES_STORE).delete(fileId);
      tx.objectStore(ITEMS_STORE).delete(fileRange(fileId));
      meta.delete(fileRange(fileId));
    };
  });
  if (heldElsewhere) return { deleted: false, heldElsewhere: true };
  // Locally as well as by broadcast: a BroadcastChannel does not deliver to the tab that posted,
  // so without this the deleting tab keeps a resume pointer naming a file that no longer exists
  // and the next rail click opens a ghost.
  forgetOpen(fileId);
  forgetSession(fileId);
  // Announced so a tab with this file open parks its pump instead of writing records back into a
  // file that no longer has a header.
  broadcast({ type: 'deleted', fileId });
  return { deleted: true };
}

/** Sums a file's stored blob bytes. Used by the header writer to maintain FileRecord.bytes. */
export function sumBlobBytes(blobs: Record<string, Blob>): number {
  let total = 0;
  for (const key in blobs) total += blobs[key]?.size ?? 0;
  return total;
}

