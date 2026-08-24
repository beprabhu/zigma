'use client';

// Mirrors a tool's queue and document into one file, and reads them back.
//
// This replaces useAutosave (lib/bg/autosave.ts:539). The mechanism it keeps is the good part of
// that module — a single-runner pump diffing identity signatures, marking `known` only AFTER a
// chunk commits, chunked writes, deletes before puts, a visible `failing` flag with a timed retry.
// What it drops is the restore/discard dialog, and the three-phase 'boot' | 'held' | 'active' gate
// that existed to support it.
//
// Why the dialog can go. The old store held ONE unnamed session, so a fresh mount's empty `items`
// array was genuinely ambiguous — "a new batch" and "the crashed batch, not yet restored" looked
// identical, and syncing had to be HELD until a human said which. Files remove the ambiguity: this
// mount is editing file X, and file X's rows are read before anything is allowed to write. Nothing
// is left to arbitrate.
//
// The gate that remains is narrower and has nothing to do with the user: between mount and the last
// loaded chunk, `items` is [] while records for this file sit on disk, and a pump that ran there
// would read the difference as "the user deleted everything". Writes are held until the load lands.

import * as React from 'react';

import {
  LOCK_BEAT_MS,
  WRITE_CHUNK,
  broadcast,
  clearMeta,
  loadItems,
  newFileRecord,
  patchFile,
  readFile,
  readMeta,
  releaseLock,
  setKept as setKeptOnDisk,
  subscribe,
  sumBlobBytes,
  touchLock,
  writeItems,
  writeMeta,
} from './store';
import { clearOpen, forgetOpen, rememberOpen } from './open';
import { makeThumb } from './thumb';
import type { FileRecord, ItemId, ItemRecord, ToolCodec } from './types';

export type FilePhase = 'loading' | 'active' | 'failed';

export interface LoadedFile<TItem, TDoc> {
  fileId: string;
  /** Rows rebuilt from disk, in stored key order. Empty for a brand-new file. */
  items: TItem[];
  /** null when the file is new, or when its doc could not be parsed. */
  doc: TDoc | null;
  /** The per-file singletons named in `metaKeys`, by key. Absent keys are simply not present. */
  meta: Record<string, unknown>;
  /** True when this file already existed on disk — i.e. the page is resuming, not starting. */
  existing: boolean;
  /**
   * The raw records the items were built from, in the same order — each RE-KEYED to its row's
   * final id, which is not always the stored one (see the collision backstop in the loader).
   * Anything that patches rows by `record.id` later, the way hydrateImages does, must be handed
   * the id the row actually wears, or a late patch lands on whichever row inherited the old
   * number: that is exactly how deleted-row gaps once put every row's picture on its neighbour.
   *
   * Here for codecs whose rebuild cannot finish synchronously: itemFrom has to return an item
   * immediately, but a stored picture is only usable once it has decoded. Generate hands the page
   * its rows straight away and fills the images in behind them, which needs the blobs these still
   * hold. Drop the reference once used — they keep every blob in the file alive.
   */
  records: ItemRecord[];
}

export interface UseFileStoreOptions<TItem, TDoc> {
  codec: ToolCodec<TItem, TDoc>;
  /** The live queue. Every mutation path must flow through the state this comes from. */
  items: TItem[];
  /** The live document state. Projected through codec.docOf before it is written. */
  doc: TDoc;
  /** Per-file singleton keys to read at open — 'csv', 'ledger'. */
  metaKeys?: readonly string[];
  /**
   * Seeds page state from disk. Called exactly once, before the phase goes 'active'.
   *
   * Not called for a file that turns out to be empty — there is nothing to seed and a caller would
   * have to guard every setter against clobbering a queue the user has already started.
   */
  onLoad?: (loaded: LoadedFile<TItem, TDoc>) => void;
  /**
   * The file id to open, when the caller already knows it (a session snapshot carrying one). Falls
   * back to the pending request from the homepage, then to a fresh uuid.
   */
  fileId?: string | null;
  /**
   * True when `items` was seeded from a live session snapshot for THIS file — a hop to another
   * product and back, not a fresh open.
   *
   * The rows on screen and the records on disk are then the same rows, so reading them back would
   * append a second copy of every one of them (four rows where the user left two). Instead the load
   * pass is used only to seed the change-detection map, which is also what stops a 3,000-row queue
   * re-putting a gigabyte of blobs on every product switch.
   */
  adopted?: boolean;
}

export interface FileStore {
  /** Stable for the life of the mount. Switching files is a route change, hence a remount. */
  fileId: string;
  phase: FilePhase;
  /** Rows read so far — a progress signal while a large file loads. */
  loadedCount: number;
  /** When this session last wrote a record. The header's "Saved HH:MM". */
  lastSavedAt: number | null;
  /** True after a write failure until one succeeds. Writes self-retry; the user still deserves to know. */
  failing: boolean;
  /** Set when a NAMED file could not be read. Distinct from "no IndexedDB" — see the note below. */
  error: Error | null;
  retry(): void;
  /** Mirrors a per-file singleton. null deletes it. Cheap to call on every render. */
  setMeta(key: string, value: unknown | null): void;
  /** True once this file has a header on disk — i.e. it appears on the homepage. */
  minted: boolean;
  /** The header as last written or read. Null until the file is minted. */
  record: FileRecord | null;
  /** Pins the file against the 7-day sweep, or unpins it. */
  setKept(kept: boolean): void;
}

/** One slot's worth of write-once-when-changed state, shared by the header and every meta key. */
interface Slot<T> {
  want: T | undefined;
  written: T | undefined;
  writing: boolean;
  retry: ReturnType<typeof setTimeout> | null;
}

function newSlot<T>(): Slot<T> {
  return { want: undefined, written: undefined, writing: false, retry: null };
}

const RETRY_MS = 5000;

/**
 * A signature nothing can equal, for a stored record with no live row behind it.
 *
 * A fresh array every read would also never match, but this reads as what it means, and the pump's
 * comparison is length-then-elementwise so a unique sentinel object settles it in one step.
 */
const ORPHANED: readonly unknown[] = [Symbol('orphaned-record')];

/** What the header writer compares to decide whether anything is worth rewriting. */
interface HeaderWant {
  name: string;
  itemCount: number;
  bytes: number;
  doc: unknown;
  thumbSource: Blob | null;
  hasContent: boolean;
}

function sameHeader(a: HeaderWant, b: HeaderWant): boolean {
  return (
    a.name === b.name &&
    a.itemCount === b.itemCount &&
    a.bytes === b.bytes &&
    // Identity, so an unchanged result never re-encodes a thumbnail. Codecs are required to return
    // the same Blob reference for an unchanged row (see ToolCodec.thumbSourceOf).
    a.thumbSource === b.thumbSource &&
    a.hasContent === b.hasContent &&
    // By value: `doc` is rebuilt on every render by the pages that own it, so identity would rewrite
    // the header on every keystroke. It is small by contract, which is what makes this affordable.
    JSON.stringify(a.doc) === JSON.stringify(b.doc)
  );
}

// (The id backstop for rows coming off disk lives inline in the load effect below — it needs
// every stored id in hand before it can mint safely, so it runs after the cursor finishes.)

export function useFileStore<TItem, TDoc>(
  opts: UseFileStoreOptions<TItem, TDoc>,
): FileStore {
  const { codec, items, doc } = opts;

  // Resolved once, during the first render, and never again for this mount. The caller decides
  // WHICH file via resolveOpen (lib/files/open.ts) — it is the only place that can weigh a homepage
  // request against the tab's live snapshot — and a null answer means "start a new one".
  const [fileId] = React.useState(() => opts.fileId || crypto.randomUUID());

  const [phase, setPhase] = React.useState<FilePhase>('loading');
  const [loadedCount, setLoadedCount] = React.useState(0);
  const [lastSavedAt, setLastSavedAt] = React.useState<number | null>(null);
  const [failing, setFailing] = React.useState(false);
  const [error, setError] = React.useState<Error | null>(null);
  const [minted, setMinted] = React.useState(false);
  const [record, setRecord] = React.useState<FileRecord | null>(null);
  const [loadTick, setLoadTick] = React.useState(0);
  /**
   * Bumped after every pass that committed anything. The header's `bytes` is summed from the
   * change-detection map, which the pump only updates AFTER a chunk lands — so without a signal
   * that fires on deletes too, removing a row left the file still reporting the bytes it no longer
   * occupies, and nothing would correct it until the next put happened to run.
   */
  const [passTick, setPassTick] = React.useState(0);

  const phaseRef = React.useRef<FilePhase>('loading');
  phaseRef.current = phase;

  // Signature + stored byte count per row. `known` is only ever marked AFTER a chunk commits, so a
  // failed write leaves its rows unmarked and a later pass recomputes and retries them.
  const knownRef = React.useRef(new Map<ItemId, { sig: readonly unknown[]; bytes: number }>());
  const mintedRef = React.useRef(false);
  const persistAskedRef = React.useRef(false);
  const deadRef = React.useRef(false);

  // The pump only ever records "something changed" plus the latest items; the running pass computes
  // its diff against the CURRENT state when it starts. Pre-computing at effect time raced a
  // running pass two ways in the old module: a mid-pass deletion diffed against a map the pass had
  // not marked yet enqueued no delete at all, and every change during a long pass re-enqueued puts
  // for everything unmarked.
  const latestItemsRef = React.useRef<TItem[]>(items);
  latestItemsRef.current = items;
  const latestDocRef = React.useRef<TDoc>(doc);
  latestDocRef.current = doc;
  const codecRef = React.useRef(codec);
  codecRef.current = codec;

  const dirtyRef = React.useRef(false);
  const runningRef = React.useRef(false);
  const retryRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const headerSlotRef = React.useRef<Slot<HeaderWant>>(newSlot<HeaderWant>());
  const metaSlotsRef = React.useRef(new Map<string, Slot<unknown>>());
  const thumbRef = React.useRef<{ source: Blob | null; blob: Blob | null }>({
    source: null,
    blob: null,
  });

  const onLoadRef = React.useRef(opts.onLoad);
  onLoadRef.current = opts.onLoad;
  // Frozen at mount, like the old adopt flag it replaces: a re-render after the queue is adopted
  // must not change what the load pass decided to do.
  const adoptedRef = React.useRef(opts.adopted === true);
  const metaKeysRef = React.useRef(opts.metaKeys ?? []);

  // ---- Header writer ------------------------------------------------------

  const [flushHeader] = React.useState(() => function flushHeaderOnce(): void {
    const slot = headerSlotRef.current;
    if (phaseRef.current !== 'active' || deadRef.current || slot.writing || slot.retry !== null) {
      return;
    }
    const want = slot.want;
    if (want === undefined) return;
    if (slot.written !== undefined && sameHeader(want, slot.written)) return;
    // Nothing authored yet: no header, so a rail click alone never litters the grid with an empty
    // Untitled card. The same rule the old module applied to draft rows (autosave.ts:9-10), one
    // level up.
    if (!want.hasContent && !mintedRef.current) return;

    slot.writing = true;
    (async () => {
      // Re-encoded only when the source blob's identity moved, so a 3,000-row run encodes once.
      if (want.thumbSource !== thumbRef.current.source) {
        thumbRef.current = {
          source: want.thumbSource,
          blob: want.thumbSource ? await makeThumb(want.thumbSource) : null,
        };
      }
      const thumb = thumbRef.current.blob;
      const at = Date.now();
      const written = await patchFile(fileId, (current) => {
        const base = current ?? newFileRecord(fileId, codecRef.current.tool, at);
        return {
          ...base,
          name: want.name,
          itemCount: want.itemCount,
          bytes: want.bytes,
          thumb,
          schema: codecRef.current.schema,
          doc: want.doc,
          // Content only. Bumping this on open would hand every card the user merely looked at
          // another week of life, and the 7-day sweep reads exactly this field.
          updatedAt: at,
        };
      });
      mintedRef.current = true;
      setMinted(true);
      // Only once it EXISTS. Pointing the resume at a file with no header would hand the next visit
      // an id that resolves to nothing.
      rememberOpen(codecRef.current.tool, fileId);
      if (written) setRecord(written);
      slot.written = want;
    })()
      .catch((e) => {
        console.error('files: header write failed, will retry', e);
        if (slot.retry === null) {
          slot.retry = setTimeout(() => {
            slot.retry = null;
            flushHeaderOnce();
          }, RETRY_MS);
        }
      })
      .finally(() => {
        slot.writing = false;
        flushHeaderOnce();
      });
  });

  // ---- Per-file singletons ------------------------------------------------

  const [flushMeta] = React.useState(() => function flushMetaOnce(key: string): void {
    const slots = metaSlotsRef.current;
    let slot = slots.get(key);
    if (!slot) {
      slot = newSlot<unknown>();
      slots.set(key, slot);
    }
    // Each key gets its own slot rather than sharing one queue: a ledger seal lands mid-run and must
    // reach disk now, while a sheet's write can be megabytes of text. Queueing the seal behind the
    // sheet would hold open the window where a crash costs a duplicate export for exactly as long
    // as the CSV takes, and a rejecting sheet must not take the ledger's retry down with it.
    if (phaseRef.current !== 'active' || deadRef.current || slot.writing || slot.retry !== null) {
      return;
    }
    const want = slot.want;
    if (want === undefined) return;
    if (slot.written !== undefined && JSON.stringify(want) === JSON.stringify(slot.written)) return;

    slot.writing = true;
    (want === null ? clearMeta(fileId, key) : writeMeta(fileId, key, want))
      .then(() => {
        slot.written = want;
      })
      .catch((e) => {
        // Left unwritten so the next pass recomputes and retries. The timer is what makes that pass
        // happen: unlike an item record, a singleton is written once and then sits idle, so a
        // dropped write has nothing to piggyback on and would stay dropped for the session.
        console.error(`files: ${key} write failed, will retry`, e);
        if (slot.retry === null) {
          slot.retry = setTimeout(() => {
            slot.retry = null;
            flushMetaOnce(key);
          }, RETRY_MS);
        }
      })
      .finally(() => {
        slot.writing = false;
        flushMetaOnce(key);
      });
  });

  const setKept = React.useCallback(
    (kept: boolean) => {
      // Straight to disk rather than through the header writer: pinning is the user's answer to
      // "this must not be deleted", and routing it through a slot that dedups and retries would
      // let it sit unwritten behind an unrelated failure.
      void setKeptOnDisk(fileId, kept).then((next) => {
        if (next) setRecord(next);
      });
    },
    [fileId],
  );

  const setMeta = React.useCallback(
    (key: string, value: unknown | null) => {
      const slots = metaSlotsRef.current;
      let slot = slots.get(key);
      if (!slot) {
        slot = newSlot<unknown>();
        slots.set(key, slot);
      }
      slot.want = value;
      flushMeta(key);
    },
    [flushMeta],
  );

  // ---- Open ---------------------------------------------------------------

  React.useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    setError(null);

    (async () => {
      const header = await readFile(fileId);
      if (cancelled) return;

      const rebuilt: TItem[] = [];
      const rawRecords: ItemRecord[] = [];
      const taken = new Set<ItemId>(latestItemsRef.current.map((i) => codecRef.current.idOf(i)));
      let count = 0;

      if (adoptedRef.current) {
        // Adopted: the live rows ARE these records. Read them only to learn each one's signature
        // and stored size, so the first pass rewrites nothing.
        const live = new Map<ItemId, TItem>(
          latestItemsRef.current.map((item) => [codecRef.current.idOf(item), item]),
        );
        await loadItems(fileId, (chunk) => {
          for (const record of chunk) {
            const match = live.get(record.id);
            knownRef.current.set(record.id, {
              // A record with no live row is one the user removed while the page was unmounted.
              // It still has to enter `known`, with a signature nothing can match, or the pump
              // never sees it as missing and its bytes sit on disk forever under a file whose
              // queue no longer mentions them.
              sig: match ? codecRef.current.signatureOf(match) : ORPHANED,
              bytes: sumBlobBytes(record.blobs ?? {}),
            });
          }
          count += chunk.length;
          if (!cancelled) setLoadedCount(count);
        });
      } else {
        // Records first, ids after. A final id can only be chosen once EVERY stored id is known:
        // a mint inside the stored range would collide with a record still ahead of the cursor,
        // and re-minting that one would cascade down the rest of the file. Holding them all costs
        // nothing extra — they are all kept for the page's onLoad anyway.
        const loaded: ItemRecord[] = [];
        await loadItems(fileId, (chunk) => {
          loaded.push(...chunk);
          count += chunk.length;
          if (!cancelled) setLoadedCount(count);
        });
        if (cancelled) return;

        /**
         * The id backstop. A stored id is used as-is — a ledger naming record ids still resolves
         * after a reload — unless a LIVE row already claims it: something the page minted before
         * the load landed, which every page is supposed to prevent by locking its inputs while
         * the phase is 'loading'. Only the colliding record is re-minted, and numeric mints start
         * past every live AND stored id.
         *
         * It must never be broader than that. An earlier version re-minted whole chunks by
         * position whenever anything was in `taken`, and fed each chunk's own ids back into that
         * check — so every chunk after the first was renumbered `max+1, max+2, …`. On a file with
         * no gaps that landed on the same numbers by luck; on a file with deleted rows everything
         * after a gap slid onto its neighbour's id, hydration pasted images back by the OLD ids,
         * and the pump saved the crossing. Three real Generate files were corrupted this way.
         */
        let numericBase = 0;
        for (const id of taken) if (typeof id === 'number' && id >= numericBase) numericBase = id + 1;
        for (const r of loaded) if (typeof r.id === 'number' && r.id >= numericBase) numericBase = r.id + 1;

        const moves: { put: ItemRecord; oldId: ItemId }[] = [];
        for (const record of loaded) {
          const collides = taken.has(record.id);
          const id = !collides
            ? record.id
            : typeof record.id === 'number'
              ? numericBase++
              : `${record.id}-${crypto.randomUUID().slice(0, 8)}`;
          taken.add(id);
          const rekeyed = collides ? { ...record, id } : record;
          if (collides) moves.push({ put: rekeyed, oldId: record.id });
          // Re-keyed, so anything patching rows by record id later (hydrateImages) hits the id
          // the row actually wears.
          rawRecords.push(rekeyed);
          rebuilt.push(codecRef.current.itemFrom(record, id));
          knownRef.current.set(id, {
            // Seeded from the REBUILT row, not the record: the next pass compares live rows
            // against this, and a signature taken from anything else would differ on the first
            // commit and re-put every row that just came off disk.
            sig: codecRef.current.signatureOf(rebuilt[rebuilt.length - 1]),
            bytes: sumBlobBytes(record.blobs ?? {}),
          });
        }
        // The disk follows a rename NOW, in one transaction, or the record stays keyed under an
        // id a live row owns — the pump would overwrite it with that row's payload and these
        // bytes would be gone. Delete-then-put in the same tx makes the move atomic.
        if (moves.length) {
          await writeItems(fileId, moves.map((m) => m.put), moves.map((m) => m.oldId));
        }
      }
      if (cancelled) return;

      const meta: Record<string, unknown> = {};
      for (const key of metaKeysRef.current) {
        const value = await readMeta(fileId, key);
        if (value !== null) meta[key] = value;
      }
      if (cancelled) return;

      const parsedDoc = header ? codecRef.current.docFrom(header.doc, header.schema) : null;
      mintedRef.current = !!header;
      setMinted(!!header);
      setRecord(header);
      if (header) rememberOpen(codecRef.current.tool, fileId);

      // Seed the header slot from disk so the first pass does not rewrite a header that already
      // says exactly this — which is also what keeps `updatedAt` honest on a plain open.
      if (header) {
        headerSlotRef.current.written = {
          name: header.name,
          itemCount: header.itemCount,
          bytes: header.bytes,
          doc: header.doc,
          thumbSource: null,
          hasContent: true,
        };
        thumbRef.current = { source: null, blob: header.thumb };
      }
      for (const key of metaKeysRef.current) {
        const slot = newSlot<unknown>();
        slot.written = key in meta ? meta[key] : null;
        metaSlotsRef.current.set(key, slot);
      }

      if (!adoptedRef.current && (header || rebuilt.length)) {
        onLoadRef.current?.({
          fileId,
          items: rebuilt,
          records: rawRecords,
          doc: parsedDoc,
          meta,
          existing: true,
        });
      }
      // The homepage's request has been honoured; a later plain rail click should resume through the
      // session snapshot instead of re-opening from a stale request.
      clearOpen();
      setPhase('active');
    })().catch((e) => {
      if (cancelled) return;
      // A NAMED file that will not load is not the same event as "this browser has no IndexedDB".
      // Activating here would leave `known` empty while records for this id sit on disk: new rows
      // would write beside the old ones and reopening would resurrect rows the user had deleted.
      // So it parks in 'loading' — where an empty `known` can never issue a delete — and says so.
      console.error('files: could not open file', e);
      setError(e instanceof Error ? e : new Error(String(e)));
      setPhase('failed');
    });

    return () => {
      cancelled = true;
    };
  }, [fileId, loadTick]);

  const retry = React.useCallback(() => setLoadTick((n) => n + 1), []);

  // ---- The pump -----------------------------------------------------------

  const [pump] = React.useState(() => function pumpOnce(): void {
    if (runningRef.current || !dirtyRef.current || deadRef.current) return;
    if (phaseRef.current !== 'active') return;
    runningRef.current = true;
    dirtyRef.current = false;

    (async () => {
      const known = knownRef.current;
      const activeCodec = codecRef.current;
      const savedAt = Date.now();
      const puts: { record: ItemRecord; sig: readonly unknown[]; bytes: number }[] = [];
      const seen = new Set<ItemId>();

      for (const item of latestItemsRef.current) {
        const id = activeCodec.idOf(item);
        seen.add(id);
        const sig = activeCodec.signatureOf(item);
        const prev = known.get(id);
        if (prev && prev.sig.length === sig.length && prev.sig.every((v, i) => v === sig[i])) {
          continue;
        }
        const payload = await activeCodec.recordOf(item, savedAt);
        if (payload) {
          puts.push({
            record: { fileId, id, savedAt, data: payload.data, blobs: payload.blobs },
            sig,
            bytes: sumBlobBytes(payload.blobs),
          });
        }
        // Work discarded in place (a redo in flight, an AI edit that cleared the result): the row
        // stays known with its stale record until new work replaces it. Deleting here would throw
        // away the last recoverable state at exactly the moment a crash is most likely.
      }

      const deletes: ItemId[] = [];
      for (const id of known.keys()) if (!seen.has(id)) deletes.push(id);
      if (!puts.length && !deletes.length) return;

      if (puts.length && !persistAskedRef.current) {
        persistAskedRef.current = true;
        // Best effort: persisted storage exempts the origin from eviction under disk pressure, and
        // four tools now share that origin.
        void navigator.storage?.persist?.().catch(() => {});
      }

      // Deletes first: under quota pressure the user's own pruning has to be able to free space, or
      // failing puts starve the deletes forever and the store wedges.
      if (deletes.length) {
        await writeItems(fileId, [], deletes);
        for (const id of deletes) known.delete(id);
      }
      for (let at = 0; at < puts.length; at += WRITE_CHUNK) {
        const chunk = puts.slice(at, at + WRITE_CHUNK);
        await writeItems(fileId, chunk.map((p) => p.record), []);
        for (const p of chunk) known.set(p.record.id, { sig: p.sig, bytes: p.bytes });
      }
      if (puts.length) setLastSavedAt(savedAt);
      setFailing(false);
      setPassTick((n) => n + 1);
      broadcast({ type: 'changed', fileId });
    })()
      .catch((e) => {
        console.error('files: write failed, will retry', e);
        setFailing(true);
        if (retryRef.current === null) {
          retryRef.current = setTimeout(() => {
            retryRef.current = null;
            dirtyRef.current = true;
            pumpOnce();
          }, RETRY_MS);
        }
      })
      .finally(() => {
        runningRef.current = false;
        // Drain whatever changed while this pass was committing.
        pumpOnce();
      });
  });

  // Item changes drive the pump; item AND doc changes drive the header.
  React.useEffect(() => {
    if (phase !== 'active') return;
    dirtyRef.current = true;
    pump();
  }, [items, phase, pump]);

  React.useEffect(() => {
    if (phase !== 'active') return;
    let bytes = 0;
    for (const entry of knownRef.current.values()) bytes += entry.bytes;
    headerSlotRef.current.want = {
      name: docName(codec, doc),
      itemCount: codec.countOf(doc, items),
      bytes,
      doc: codec.docOf(doc),
      thumbSource: codec.thumbSourceOf(items),
      hasContent: codec.hasContent(doc, items),
    };
    flushHeader();
  }, [items, doc, codec, phase, passTick, flushHeader]);

  // ---- Heartbeat ----------------------------------------------------------

  React.useEffect(() => {
    // Only once the file actually EXISTS. A heartbeat says "do not sweep this", and nothing can
    // sweep a file with no header — so beating before the header is minted buys nothing and leaks:
    // every mount resolves a fresh uuid, and a visit where the user adds nothing would leave a lock
    // record behind under an id no file will ever have. Cascade delete is keyed on real files, so
    // those orphans are unreachable forever. (Ten of them accumulated on the first test run.)
    if (phase !== 'active' || !minted) return;
    void touchLock(fileId).catch(() => {});
    const timer = setInterval(() => void touchLock(fileId).catch(() => {}), LOCK_BEAT_MS);
    return () => clearInterval(timer);
  }, [fileId, phase, minted]);

  // ---- Another tab deleted this file --------------------------------------

  React.useEffect(
    () =>
      subscribe((event) => {
        if (event.type !== 'deleted' || event.fileId !== fileId) return;
        // Park everything. Without this the pump keeps writing rows under a fileId that has no
        // header — invisible to the homepage AND to the sweep, i.e. bytes nothing can ever reclaim.
        deadRef.current = true;
        dirtyRef.current = false;
        forgetOpen(fileId);
        setFailing(false);
      }),
    [fileId],
  );

  React.useEffect(
    () => () => {
      if (retryRef.current !== null) clearTimeout(retryRef.current);
      if (headerSlotRef.current.retry !== null) clearTimeout(headerSlotRef.current.retry);
      for (const slot of metaSlotsRef.current.values()) {
        if (slot.retry !== null) clearTimeout(slot.retry);
      }
      // The heartbeat is NOT released here. Leaving a product is a navigation, not a close — the
      // session store keeps the queue live and the user is one rail click from being back in it. A
      // released lock would let another tab's sweep take a file that is still on screen; a stale one
      // simply expires in LOCK_STALE_MS.
    },
    [],
  );

  return {
    fileId,
    phase,
    loadedCount,
    lastSavedAt,
    failing,
    error,
    retry,
    setMeta,
    minted,
    record,
    setKept,
  };
}

/**
 * The card's title. Codecs keep the session name on their doc — it is the one field every tool
 * already has (components/session-header.tsx) — but the store has no way to reach into an opaque
 * doc for it, so it reads the projected shape.
 */
function docName<TItem, TDoc>(codec: ToolCodec<TItem, TDoc>, doc: TDoc): string {
  const projected = codec.docOf(doc) as { sessionName?: unknown } | null;
  const name = projected && typeof projected === 'object' ? projected.sessionName : null;
  return typeof name === 'string' ? name : '';
}

export { releaseLock };
