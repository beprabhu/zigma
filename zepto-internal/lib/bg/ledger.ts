// The export ledger: which queued images have already shipped inside a ZIP, which ones the next
// ZIP will carry, and which already-downloaded ZIPs a later edit has quietly made obsolete.
//
// React-free like lib/bg/batch.ts — the page owns items[] and every side effect, this module owns
// the rules. Nothing here reads a clock, a ref or a run's internals (see recordBatch for the one
// ambient read, which no decision depends on). A batch that seals mid-run has to be reproducible
// from the committed queue alone: the decision is taken while inference is still landing results,
// and a decision that also depended on when it was asked could not be re-derived after the fact,
// which is the one thing that matters once the bytes have left the building.
//
// The model is a LEDGER, not a filter. A batch is born when items are EXPORTED, never when they
// are flagged. Flag state is a live verdict that moves under you — an AI fix un-flags an image,
// a redo can flag one that was fine — so a cohort defined as "the flagged ones" loses and gains
// members between the moment a ZIP is planned and the moment it is written, and the ones it loses
// land in no ZIP at all. That is the failure this whole file exists to make impossible: with 550
// images and two exports, a user must be able to say "these two ZIPs are my 550".
//
// So membership is a STAMP (BgItem.batch), written only after a save succeeds, and the cohorts
// below are defined by the ABSENCE of that stamp rather than by any quality signal. Everything
// else — numbering, staleness, the rail's summary — reads the same stamps back.

import { exportFileName } from './batch';
import type { BgItem, CutoutItem } from './batch';
import type { VerdictLookup } from './quality';

/**
 * How many clean images a live batch collects before it seals. 500 is the user-facing shape of
 * the feature ("the ~500 that came out clean ship straight away"), not a technical ceiling —
 * raising it only makes the first ZIP arrive later.
 */
export const DEFAULT_SEAL_SIZE = 500;

// ---- Item-level predicates ------------------------------------------------

/** Whether this item has already gone out in a ZIP. The stamp is the only durable record. */
export function isExported(item: BgItem): boolean {
  return typeof item.batch === 'number';
}

/**
 * Whether something is currently rewriting this item. Mirrors the results grid's spinner rule,
 * and it is a stronger statement than "not done": an item mid-AI-edit still HOLDS its previous
 * cutout for the whole Azure round trip (aiEditOne only clears it when the reply arrives), so a
 * cohort that went by cutout alone would ship the exact picture the user is paying to replace —
 * and stamp it exported, so the fix that lands a minute later would never ship at all.
 */
export function isInFlight(item: BgItem): boolean {
  return item.status === 'removing' || item.status === 'loading-model' || item.status === 'editing';
}

/**
 * Whether this item could be written into a ZIP right now: it has pixels, and nothing in flight
 * is about to replace them.
 *
 * The statuses that fall out here, spelled out so none of them goes missing silently:
 *   - never run / cancelled / errored on a first run — no cutout, nothing to encode;
 *   - 'removing' or 'loading-model' — a redo KEEPS the old cutout until the new one lands
 *     (cutOut only patches status on the way in), so these rows do have pixels; they are held
 *     back because those pixels are about to be replaced, not because they are missing;
 *   - 'editing', or a re-removal pending after one — held back by isInFlight above;
 *   - 'error' that still carries a cutout — an AI edit that failed AFTER the item already had a
 *     good cutout leaves exactly this, and it DOES ship. Nothing further will change it, the
 *     pixels are the ones the user already accepted, and excluding it on the strength of its
 *     status alone would drop it from both ZIPs: 550 in, 549 out, with nothing to point at.
 * Everything excluded here stays unexported, so it rejoins a cohort the moment it settles —
 * exclusion defers an item, it never drops one.
 */
function isShippable(item: BgItem): item is CutoutItem {
  return item.cutout !== null && !isInFlight(item);
}

// ---- Cohorts --------------------------------------------------------------

export interface CohortOptions {
  /**
   * Ids belonging to a batch that has sealed but whose save has not landed yet. A seal cannot
   * stamp anything until the file is written (pickSave needs the user's click, and encoding a
   * 500-image ZIP takes minutes), so for that whole window the items are unstamped yet already
   * spoken for. Without this set the next seal re-selects them and the same images go out in two
   * ZIPs under two different numbers.
   */
  claimed?: ReadonlySet<number>;
}

/**
 * The cohort a live seal ships: finished, has pixels, the quality heuristic is happy, not yet
 * exported. This is the ~500 in "the ~500 that came out clean should be exported straight away".
 *
 * `status === 'done'` is not redundant next to the verdict — assessQuality returns OK for
 * anything that is not done, so an item that is merely mid-run would read as clean.
 *
 * The verdict table is passed in rather than computed: a live seal is evaluated on every commit
 * of a 3,000-image queue, and re-assessing the whole queue per call is precisely the cost
 * VerdictLookup exists to avoid. It must be the table built from THIS items array — verdictLookup
 * answers OK for an item it has never seen, so a table one render behind the queue would call a
 * freshly-landed bad matte clean and seal it into a ZIP that is already downloaded.
 */
export function cleanUnexported(
  items: readonly BgItem[],
  verdictOf: VerdictLookup,
  options: CohortOptions = {},
): CutoutItem[] {
  const { claimed } = options;
  return items.filter(
    (item): item is CutoutItem =>
      !isExported(item) &&
      !claimed?.has(item.id) &&
      item.status === 'done' &&
      item.cutout !== null &&
      // A row restored from a file that predates saved quality evidence has no verdict worth
      // acting on — eight of the eleven checks cannot fire, so "ok" here means "nothing was
      // measured", not "nothing is wrong". Sealing those into a batch would ship exactly the
      // images an operator was keeping back. They fall to the remaining cohort instead, where
      // shipping them is a decision someone makes rather than one the tool makes for them.
      !item.qualityUnknown &&
      verdictOf(item).level === 'ok',
  );
}

/** Rows whose verdict could not be recomputed — surfaced so the shortfall is never silent. */
export function unverifiedUnexported(
  items: readonly BgItem[],
  options: CohortOptions = {},
): CutoutItem[] {
  const { claimed } = options;
  return items.filter(
    (item): item is CutoutItem =>
      !isExported(item) && !claimed?.has(item.id) && item.cutout !== null && !!item.qualityUnknown,
  );
}

/**
 * Everything else that can still ship: has pixels, not yet exported, REGARDLESS of flag state.
 *
 * Deliberately takes no verdict lookup — not an oversight to be tidied up later. This is the
 * cohort that makes ZIP1 + ZIP2 add up to the queue, and it can only do that by ignoring quality
 * entirely: an item that was flagged, went through Azure and came back clean must ship here with
 * the rest of its cohort, and so must one that is still flagged and never will be fixed. Filter
 * this by verdict and those images belong to no cohort at all, which is a silent loss of exactly
 * the images a human already spent the most attention on.
 */
export function remainingUnexported(
  items: readonly BgItem[],
  options: CohortOptions = {},
): CutoutItem[] {
  const { claimed } = options;
  return items.filter(
    (item): item is CutoutItem => !isExported(item) && !claimed?.has(item.id) && isShippable(item),
  );
}

/**
 * The members of an already-shipped batch that could go into a replacement ZIP. Members that are
 * gone from the queue, or that cannot ship right now (mid-AI-edit, see isShippable), are absent —
 * a re-export is a best-effort refresh of a file that already exists on disk, not a second
 * cohort, so it must never wait for anything.
 */
export function batchItems(items: readonly BgItem[], batch: number): CutoutItem[] {
  return items.filter((item): item is CutoutItem => item.batch === batch && isShippable(item));
}

// ---- Numbering ------------------------------------------------------------

/**
 * The number the next batch gets. Same shape as nextItemId, and for the same reason: derived
 * from the highest stamp rather than from a count, so deleting every image of batch 2 cannot
 * hand its number to batch 4 and leave the rail with two rows claiming to be the same ZIP.
 *
 * The ledger is consulted too, because a batch whose items were ALL deleted survives nowhere else.
 */
export interface Allocation {
  /** The number the next ZIP stamps on its members. */
  batch: number;
  /** Files promised to earlier ZIPs, so the next one's first file is `offset + 1`. */
  offset: number;
}

/**
 * The next unused batch number and file offset.
 *
 * `pending` is the load-bearing argument: a plan is decided minutes before its save lands, and
 * `batch` is only stamped once it does. Deriving purely from stamps and finished records made
 * every plan decided inside that window identical to the last — same batch number, same offset —
 * so two ZIPs claimed the same range and the second overwrote the first file for file. Anything
 * already promised has to count, whether or not it has been written yet.
 *
 * `floor` is the high-water mark carried over from earlier sessions. Neither number may ever go
 * backwards: files already sitting in the user's folder cannot be un-written, so an offset that
 * retreats — because shipped rows were deleted, or because a restore brought back stamps without
 * their records — renumbers the next ZIP straight into names that already exist on disk.
 */
export function nextAllocation(
  items: readonly BgItem[],
  ledger: readonly BatchRecord[] = [],
  pending: readonly ExportPlan[] = [],
  floor: Allocation = { batch: 1, offset: 0 },
): Allocation {
  let batch = Math.max(1, Math.floor(floor.batch)) - 1;
  let offset = Math.max(0, Math.floor(floor.offset));
  let stamped = 0;
  for (const item of items) {
    if (typeof item.batch === 'number') {
      stamped++;
      if (item.batch > batch) batch = item.batch;
    }
  }
  if (stamped > offset) offset = stamped;
  for (const record of ledger) {
    if (record.batch > batch) batch = record.batch;
    const end = record.offset + record.count;
    if (end > offset) offset = end;
  }
  for (const plan of pending) {
    if (plan.batch > batch) batch = plan.batch;
    const end = plan.offset + plan.items.length;
    if (end > offset) offset = end;
  }
  return { batch: batch + 1, offset };
}

// ---- Plans ----------------------------------------------------------------

/**
 * One ZIP, decided. Produced before any encoding starts and then handed unchanged to the naming,
 * the ZIP writer, the stamp and the ledger record, so all four agree about what is in the file.
 */
export interface ExportPlan {
  /** The number to stamp on `items` — after the save succeeds, never before. */
  batch: number;
  /** Files written before this one; the first file in this ZIP is number `offset + 1`. */
  offset: number;
  /**
   * The exact contents, in queue order, snapshotted at decision time. An export runs for minutes
   * and results keep landing throughout; reading the live queue again at ZIP-writing time would
   * put images into a file that had already been named and counted.
   */
  items: CutoutItem[];
}

/** A cohort turned into a plan. Null for an empty cohort — there is no such thing as an empty ZIP. */
export function planExport(
  cohort: readonly CutoutItem[],
  alloc: Allocation,
): ExportPlan | null {
  if (!cohort.length) return null;
  return { batch: alloc.batch, offset: alloc.offset, items: [...cohort] };
}

export interface SealOptions extends CohortOptions {
  /** Clean-and-unexported images required before a batch seals. Defaults to DEFAULT_SEAL_SIZE. */
  threshold?: number;
  ledger?: readonly BatchRecord[];
  /** Where this seal's numbers come from. See nextAllocation — never derive them here. */
  alloc: Allocation;
}

/**
 * The live-sealing decision: does a batch seal on this commit, and what exactly is in it.
 *
 * Called from the queue's own commit, never from a timer or from inside the run loop — the run
 * loop patches one item at a time and its view of the queue is a lagging ref, so "have 500 clean
 * results accumulated" can only be answered by the committed array.
 *
 * Seals exactly `threshold` items even when more are clean, so a ZIP is the size it says it is.
 * One batch per call is deliberate: 1,000 clean results arriving in a single commit seal the
 * first 500 here, and the next commit — after those 500 are stamped — seals the next 500. Looping
 * inside one call would mean simulating stamps that have not been written yet, and if the second
 * save then failed the ledger would hold a batch nobody can download.
 *
 * Returns null far more often than not, including forever when the whole queue is smaller than
 * the threshold. Sealing is an accelerator for big runs, never the only route to a file: the
 * manual "export clean" and "export the rest" paths must stay reachable or a 40-image queue would
 * produce nothing at all.
 */
export function planSeal(
  items: readonly BgItem[],
  verdictOf: VerdictLookup,
  options: SealOptions,
): ExportPlan | null {
  // A threshold under 1 would seal a one-image ZIP on every single commit of a running batch.
  // The NaN guard is not theoretical: the seal size is a user-typed number, and an empty field
  // parses to NaN, which passes every comparison below and slices an empty cohort — sealing
  // would simply never fire again, with nothing thrown and nothing to see.
  const raw = Math.round(options.threshold ?? DEFAULT_SEAL_SIZE);
  const threshold = Number.isFinite(raw) ? Math.max(1, raw) : DEFAULT_SEAL_SIZE;
  const clean = cleanUnexported(items, verdictOf, options);
  if (clean.length < threshold) return null;
  return planExport(clean.slice(0, threshold), options.alloc);
}

/**
 * The tail: every clean image still unexported, however few. The threshold is a CEILING on how
 * big one ZIP gets, never a minimum for shipping — treating it as a gate is what left 2,829
 * finished images stranded at the end of a 14,105-image run, with the only remaining button
 * offering to ship them mixed in with 5,264 that still needed an AI fix. That is the exact
 * separation this whole feature exists to make.
 *
 * Deliberately unbounded by the threshold: what is left is by definition less than one full
 * batch, because a full one would already have sealed.
 */
export function planFinalSeal(
  items: readonly BgItem[],
  verdictOf: VerdictLookup,
  options: { alloc: Allocation } & CohortOptions,
): ExportPlan | null {
  return planExport(cleanUnexported(items, verdictOf, options), options.alloc);
}

/**
 * A replacement ZIP for a batch that has gone stale. Keeps the original batch number AND its
 * original offset: the point is to overwrite the files already sitting in the user's folder, so
 * fresh numbers would leave the superseded pictures behind under their old names.
 *
 * The members are re-numbered by their current queue order, so a batch that has since lost items
 * produces a shorter, renumbered ZIP rather than a sparse one — replace the whole folder, not
 * individual files.
 */
export function planReexport(items: readonly BgItem[], record: BatchRecord): ExportPlan | null {
  const members = batchItems(items, record.batch);
  if (!members.length) return null;
  return { batch: record.batch, offset: record.offset, items: members };
}

// ---- Stamping -------------------------------------------------------------

/**
 * Writes a plan's membership onto the queue. Pure, so it can be handed straight to setItems and
 * survive StrictMode's double invocation; call it only once the save has actually succeeded,
 * because a stamp is what removes an image from every future cohort.
 *
 * Matches by id and writes NOTHING but `batch`. The plan's items were snapshotted before minutes
 * of encoding, and patching those objects back wholesale would revert whatever landed meanwhile —
 * a rename from a column remap, a tile-fit pin, a cutout from a redo. Same hazard aiEditOne
 * documents, same answer.
 *
 * The spread keeps `source` as the very same object, which matters more than it looks: that
 * reference is the token patchItemIfSource compares by === to decide whether a worker result
 * still belongs to the item. Rebuilding a source here would make every in-flight result for a
 * stamped item look stale and be thrown away. It also keeps autosave quiet — signatureOf reads
 * the cutout blob, the regenerated file and the name, all carried over untouched, so stamping
 * 500 items re-puts nothing and gigabytes of blobs stay where they are.
 *
 * An item that somehow already carries a stamp keeps it. Unreachable while cohorts exclude
 * exported items, but if it ever happens the first ZIP that shipped the image is the one that
 * really contains it, and the truthful failure is a later record that over-counts by one — which
 * the summary's present count exposes — rather than an earlier ZIP silently losing a member.
 */
export function stampBatch(items: BgItem[], plan: ExportPlan): BgItem[] {
  const ids = new Set(plan.items.map((item) => item.id));
  return items.map((item) =>
    ids.has(item.id) && !isExported(item) ? { ...item, batch: plan.batch } : item,
  );
}

// ---- Staleness ------------------------------------------------------------

/**
 * What this session knows about one ZIP it wrote. Session-only on purpose: it holds live object
 * references, so nothing here can be serialized into a .zesku, and after a restore the stamps
 * come back without it (see summarizeLedger's 'unknown').
 */
export interface BatchRecord {
  batch: number;
  /** Files written before this ZIP — see ExportPlan.offset. */
  offset: number;
  /** How many images went into it, including any deleted since. */
  count: number;
  savedAt: number;
  /** What the ZIP was called, so the rail can name the file to look for on disk. */
  fileName?: string;
  /**
   * The cutout Blobs exactly as shipped. Blob identity is the change token — the same identity
   * autosave's signatureOf leans on — because every path that alters an image (a redo, an AI
   * edit and its re-removal) mints a fresh Blob and assigns it, while nothing mutates one in
   * place. So `has(item.cutout.blob)` is a pointer compare that answers "is this still the
   * picture I put in the file", with no hashing and no decode.
   *
   * WEAK on purpose. A strong Set would keep every superseded cutout alive for the life of the
   * session: 50 redone images at ~2 MB each is 100 MB of blobs held by nothing but bookkeeping,
   * on a feature whose entire reason to exist is that 550 full-resolution images do not fit in
   * memory. Weakness costs nothing here — the only blobs ever looked up are ones a live item is
   * still holding, and a blob no item holds can never be the answer to any question asked below.
   */
  shipped: WeakSet<Blob>;
  /**
   * True for a record rebuilt from the stored ledger rather than written by this session.
   *
   * Its `shipped` set is necessarily empty — a WeakSet of Blob identities cannot survive a
   * reload — so the staleness check below would read every member as changed and tell the user
   * 133 files need re-downloading, which is not something we know. Restored rows report
   * 'unknown' instead, which is the true answer and the one reshaping already refuses to act on.
   */
  restored?: boolean;
}

/**
 * The ledger row for a plan that has just been saved. Call it once, outside any state updater —
 * it mints a WeakSet, so a double-invoked updater would leave two records disagreeing about
 * identity.
 *
 * `savedAt` defaults to the wall clock, the only ambient read in this module. It labels a row and
 * nothing branches on it; sealing in particular must never depend on a clock (see planSeal).
 */
export function recordBatch(
  plan: ExportPlan,
  details: { savedAt?: number; fileName?: string } = {},
): BatchRecord {
  const shipped = new WeakSet<Blob>();
  for (const item of plan.items) shipped.add(item.cutout.blob);
  return {
    batch: plan.batch,
    offset: plan.offset,
    count: plan.items.length,
    savedAt: details.savedAt ?? Date.now(),
    ...(details.fileName ? { fileName: details.fileName } : null),
    shipped,
  };
}

/**
 * Whether a downloaded ZIP still matches the queue.
 *
 * 'unknown' is not a hedge — it is the correct answer for a queue restored from a .zesku, where
 * the stamps survive but the blob identities do not: every restored cutout is a Blob read back
 * out of the archive, so an identity compare would call every batch stale and turn the rail into
 * a wall of warnings about files that are perfectly fine. Claiming 'current' instead would be the
 * worse lie, promising a user their ZIP is up to date about a file this session has never seen.
 */
export type BatchStaleness = 'current' | 'stale' | 'unknown';

/**
 * Where a batch stands, across all three places its existence is recorded.
 *
 * A batch is not one row in one table. It is a sealed PLAN until its ZIP is written, a ledger
 * RECORD afterwards, and a set of per-row STAMPS that outlive the record across a reload. Every
 * screen used to union some subset of those for itself and reach its own conclusions, which is
 * how the rail could count a batch the dialog could not show.
 */
export type BatchState =
  /** Sealed, its ZIP never written. Exists only as an open plan — nothing is stamped yet. */
  | 'waiting'
  /** Written, and every image still matches what went into it. */
  | 'current'
  /** Written, but an image changed afterwards, so the file on disk is out of date. */
  | 'stale'
  /** Stamps survived a reload. What shipped cannot be verified, and may not even be numbered. */
  | 'restored';

/** What a batch will allow, decided once here rather than re-derived by each surface. */
export interface BatchAbilities {
  /** Its ZIP can be produced again (or for the first time) under the names it already owns. */
  download: boolean;
  /** It can take part in a multi-batch action — it is on disk and its numbering is known. */
  select: boolean;
  /** It can be merged or split: on disk, numbered, and its contents accounted for. */
  reshape: boolean;
}

export interface LedgerBatch {
  batch: number;
  /** How many images the ZIP holds, or null when only stamps survive (a restored project). */
  shipped: number | null;
  /**
   * How many of them are still in the queue. Lower than `shipped` after a deletion, which is not
   * a problem to fix: the file on disk still contains that image, and its slot in the numbering
   * stays reserved (see nextAllocation).
   */
  present: number;
  state: BatchState;
  /** Kept as the older name for the same fact, so guards reading it do not all have to move. */
  staleness: BatchStaleness;
  offset?: number;
  savedAt?: number;
  fileName?: string;
  can: BatchAbilities;
  /** Why `can.download` is false, in words a person can act on. Absent when it is true. */
  blocked?: string;
}

/**
 * Everything the batch rail draws, in one pass over the queue.
 *
 * The four counts partition the queue exactly — exported + claimed + ready + waiting === total —
 * which is the invariant that makes "my two ZIPs are my 550" checkable at a glance instead of
 * being an argument about cohort definitions.
 *
 * No `clean` count here: that one needs the verdict table, and the page already memoizes the
 * clean cohort to label its button. Deriving it twice from two different tables is how the two
 * numbers start disagreeing.
 */
export interface LedgerSummary {
  batches: LedgerBatch[];
  /** Stamped — already in a ZIP. */
  exported: number;
  /** Spoken for by a seal whose save has not landed yet. */
  claimed: number;
  /** Unexported and shippable right now; identical to remainingUnexported(...).length. */
  ready: number;
  /**
   * Unexported and not shippable yet: never run, cancelled, failed with nothing to show, or
   * currently in flight. The line that explains why "export the rest (47)" is not 50.
   */
  waiting: number;
  total: number;
}

export function summarizeLedger(
  items: readonly BgItem[],
  ledger: readonly BatchRecord[] = [],
  options: CohortOptions & {
    /**
     * Sealed batches whose ZIP has not been written. THE third source: a plan is stamped onto its
     * rows and recorded in the ledger only once the save lands, so before that a batch exists
     * nowhere else — and a summary built without them reports finished work as not existing.
     */
    plans?: readonly ExportPlan[];
  } = {},
): LedgerSummary {
  const { claimed: claimedIds, plans = [] } = options;
  const records = new Map<number, BatchRecord>();
  for (const record of ledger) records.set(record.batch, record);
  const unwritten = new Map<number, ExportPlan>();
  for (const plan of plans) if (!records.has(plan.batch)) unwritten.set(plan.batch, plan);

  const present = new Map<number, number>();
  const changed = new Set<number>();
  let exported = 0;
  let claimed = 0;
  let ready = 0;
  let waiting = 0;

  for (const item of items) {
    // Same test as isExported, inlined so the batch number narrows to a number below.
    const batch = item.batch;
    if (typeof batch === 'number') {
      exported++;
      present.set(batch, (present.get(batch) ?? 0) + 1);
      const record = records.get(batch);
      // A cleared cutout counts as changed too: it means an AI edit has taken the shipped image
      // away and a re-removal will put a different one back, so the ZIP is already behind. This
      // is also the answer to what happens to an item edited AFTER it shipped — it stays stamped
      // and out of every cohort, and its batch goes stale, because re-exporting the batch (not
      // sneaking the item into a later one) is what keeps the ZIPs a partition of the queue.
      if (record && !record.restored && (item.cutout === null || !record.shipped.has(item.cutout.blob))) {
        changed.add(batch);
      }
      continue;
    }
    if (claimedIds?.has(item.id)) {
      claimed++;
      continue;
    }
    if (isShippable(item)) ready++;
    else waiting++;
  }

  // Union of both sides: a record whose items were all deleted still describes a file on disk,
  // and a stamp with no record behind it is a restored project's batch.
  const numbers = [...new Set([...records.keys(), ...present.keys(), ...unwritten.keys()])]
    .sort((a, b) => a - b);
  const batches = numbers.map((batch): LedgerBatch => {
    const record = records.get(batch);
    const plan = unwritten.get(batch);
    const state: BatchState = plan
      ? 'waiting'
      : !record || record.restored
        ? 'restored'
        : changed.has(batch)
          ? 'stale'
          : 'current';
    // A plan carries its own numbering; a record carries what it was written with; a batch known
    // only by its stamps has none, and nothing may invent one — see `blocked` below.
    const offset = plan ? plan.offset : record?.offset;
    const numbered = offset !== undefined;
    const onDisk = state !== 'waiting';
    const can: BatchAbilities = {
      download: state === 'waiting' || numbered,
      select: onDisk && numbered,
      reshape: onDisk && numbered && state !== 'restored',
    };
    return {
      batch,
      shipped: plan ? plan.items.length : record ? record.count : null,
      present: plan ? plan.items.length : present.get(batch) ?? 0,
      state,
      // The same fact under the name the reshape guards already read.
      staleness: state === 'waiting' ? 'current' : state === 'restored' ? 'unknown' : state,
      ...(numbered ? { offset } : null),
      ...(record ? { savedAt: record.savedAt } : null),
      ...(record?.fileName ? { fileName: record.fileName } : null),
      can,
      ...(can.download
        ? null
        : {
            blocked:
              'This batch was restored from an earlier session without its file numbering, so it cannot be rebuilt under the same names. The ZIP you already downloaded is still valid.',
          }),
    };
  });

  return { batches, exported, claimed, ready, waiting, total: items.length };
}

// ---- Reshaping ------------------------------------------------------------
//
// Merging and splitting batches, which is bookkeeping and nothing more.
//
// It is only safe because of one accident of the numbering: a file's number comes from the
// batch's offset plus the item's position, and those positions run CONTINUOUSLY across batches —
// batch 1 is files 1-500, batch 2 is 501-1000. Join them and the merged batch is files 1-1000:
// the same numbers, over the same images, in the same order. The ZIPs already on the user's disk
// stay correct file for file; only the receipt changes.
//
// That accident holds while two conditions do, and both are CHECKED rather than assumed:
//
//   adjacency   the picked batches must be neighbours whose file ranges touch. Merging batch 1
//               with batch 5 would put files 1-500 and 2001-2500 under one offset and renumber
//               the second half onto names the batches in between already own.
//   order       a merged batch re-derives its members in queue order, and queue order usually
//               matches seal order — but not always: an image flagged early, fixed late and
//               sealed into batch 3 can sit in the queue ahead of batch 2's members. So every
//               reshape REPORTS how many files would change name (`renamed`) instead of
//               promising none, and the caller says so before the user commits.
//
// Restored batches ('unknown' staleness) cannot be reshaped at all. Their records are gone, so
// there is no way to know which blobs actually shipped, and a merged record would have to either
// claim every image is current — lying about a file this session never wrote — or call all of
// them stale. Refusing is the only honest third option.

/** One batch a reshape will create. */
export interface ReshapeGroup {
  /** The new number. Old numbers are retired and never reused — see nextAllocation. */
  batch: number;
  offset: number;
  /**
   * Its members in FINAL order, which is queue order — the same order batchItems will hand back
   * when the batch is next exported, so the names predicted here are the names that get written.
   * Each item still carries its OLD stamp at this point, which is what lets the record rebuild
   * below look up where its blob shipped from.
   */
  members: CutoutItem[];
}

export interface BatchReshape {
  /** Batch numbers whose ledger rows and stamps are being replaced. */
  retire: number[];
  groups: ReshapeGroup[];
  /**
   * How many files come out under a different name than the ZIP on disk gave them.
   *
   * Zero is the normal answer and means the downloaded folders stay correct with no re-download.
   * Non-zero means the affected batches must be downloaded again and their folders replaced —
   * the same rule a re-export after a deletion already follows.
   */
  renamed: number;
  /** Highest number handed out, for advancing the allocation floor. */
  maxBatch: number;
}

/** The file name a member currently has on disk, from the batch it shipped in. */
function shippedName(item: CutoutItem, index: number, offset: number): string {
  return exportFileName(item.name, index, { offset });
}

/**
 * Counts members whose name would move. `before` maps item id → the name its ZIP used; groups
 * carry the names it would get.
 */
function countRenamed(before: Map<number, string>, groups: readonly ReshapeGroup[]): number {
  let renamed = 0;
  for (const group of groups) {
    group.members.forEach((item, index) => {
      const was = before.get(item.id);
      if (was !== undefined && was !== shippedName(item, index, group.offset)) renamed++;
    });
  }
  return renamed;
}

/** Every member's current on-disk name, across the batches a reshape touches. */
function namesBefore(
  items: readonly BgItem[],
  batches: readonly number[],
  offsetOf: (batch: number) => number,
): Map<number, string> {
  const before = new Map<number, string>();
  for (const batch of batches) {
    const offset = offsetOf(batch);
    batchItems(items, batch).forEach((item, index) => {
      before.set(item.id, shippedName(item, index, offset));
    });
  }
  return before;
}

export interface ReshapeCheck {
  ok: boolean;
  /** Why not, phrased for the user. Empty when ok. */
  reason: string;
}

/**
 * Whether a set of batches may be merged.
 *
 * Adjacency is tested on the FILE RANGES, not on the numbers: after earlier merges the numbers
 * have gaps, and what actually has to be contiguous is the run of files, since that is what the
 * merged offset has to cover exactly.
 */
/**
 * Whether these batches can go into ONE ZIP that keeps every file's existing number.
 *
 * Numbering facts only. Packaging asks a smaller question than merging does: it needs to know
 * where each batch's numbers start and that together they cover one unbroken run, and nothing
 * more. Whether the pictures still match the ZIP already on disk is not its business — a stale
 * batch is combinable for the same reason it is re-downloadable, and so is a restored one whose
 * numbering survived. Merging is the one that additionally needs to trust the contents, because
 * it rewrites the records for good.
 */
export function canCombineBatches(
  summary: readonly LedgerBatch[],
  picked: readonly number[],
): ReshapeCheck {
  if (picked.length < 2) return { ok: false, reason: 'Pick two or more batches.' };
  const rows = summary.filter((b) => picked.includes(b.batch));
  if (rows.length !== picked.length) return { ok: false, reason: 'Some picked batches no longer exist.' };
  if (rows.some((b) => !b.can.select)) {
    return {
      ok: false,
      reason: 'Only batches already on disk with known file numbering can be combined — otherwise the ZIP would have to invent names that collide with one already written.',
    };
  }
  const ordered = [...rows].sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0));
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    if ((ordered[i].offset ?? 0) !== (prev.offset ?? 0) + (prev.shipped ?? prev.present)) {
      return {
        ok: false,
        reason: 'Only batches whose file numbers run back to back can be combined — otherwise the ZIP would renumber over files another batch already owns.',
      };
    }
  }
  return { ok: true, reason: '' };
}

export function canMergeBatches(
  summary: readonly LedgerBatch[],
  picked: readonly number[],
): ReshapeCheck {
  const combinable = canCombineBatches(summary, picked);
  if (!combinable.ok) return combinable;
  const rows = summary.filter((b) => picked.includes(b.batch));
  if (rows.some((b) => !b.can.reshape)) {
    return {
      ok: false,
      reason: 'Batches restored from a saved file cannot be merged — this session has no record of what shipped in them.',
    };
  }
  const sorted = [...rows].sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const end = (prev.offset ?? 0) + (prev.shipped ?? prev.present);
    if ((sorted[i].offset ?? 0) !== end) {
      return {
        ok: false,
        reason: 'Only batches whose file numbers run back to back can be merged — otherwise the merged ZIP would renumber over files another batch already owns.',
      };
    }
  }
  return { ok: true, reason: '' };
}

/**
 * Merges adjacent batches into one, under a fresh number at the earliest offset.
 *
 * Null when the pick is invalid or nothing is left to merge; call canMergeBatches first for the
 * reason to show.
 */
export function planMerge(
  items: readonly BgItem[],
  summary: readonly LedgerBatch[],
  picked: readonly number[],
  alloc: Allocation,
): BatchReshape | null {
  if (!canMergeBatches(summary, picked).ok) return null;
  const rows = summary.filter((b) => picked.includes(b.batch));
  const offsetOf = (batch: number) => rows.find((b) => b.batch === batch)?.offset ?? 0;
  const offset = Math.min(...rows.map((b) => b.offset ?? 0));

  const pickedSet = new Set(picked);
  // Queue order across all of them, which is exactly what batchItems will return for the merged
  // number once the stamps land.
  const members = items.filter(
    (item): item is CutoutItem =>
      typeof item.batch === 'number' && pickedSet.has(item.batch) && isShippable(item),
  );
  if (!members.length) return null;

  const groups: ReshapeGroup[] = [{ batch: alloc.batch, offset, members }];
  return {
    retire: [...picked].sort((a, b) => a - b),
    groups,
    renamed: countRenamed(namesBefore(items, picked, offsetOf), groups),
    maxBatch: alloc.batch,
  };
}

/**
 * Splits one batch in two at `at` (the count that stays in the first half).
 *
 * Names never move here — both halves keep their members' positions, and the second half's
 * offset is the first's plus its length — but `renamed` is still computed rather than asserted,
 * because the one thing this module does not do is promise things it has not checked.
 */
export function planSplit(
  items: readonly BgItem[],
  summary: readonly LedgerBatch[],
  batch: number,
  at: number,
  alloc: Allocation,
): BatchReshape | null {
  const row = summary.find((b) => b.batch === batch);
  if (!row || !row.can.reshape || row.offset === undefined) return null;
  const members = batchItems(items, batch);
  if (at < 1 || at >= members.length) return null;

  const groups: ReshapeGroup[] = [
    { batch: alloc.batch, offset: row.offset, members: members.slice(0, at) },
    { batch: alloc.batch + 1, offset: row.offset + at, members: members.slice(at) },
  ];
  return {
    retire: [batch],
    groups,
    renamed: countRenamed(namesBefore(items, [batch], () => row.offset ?? 0), groups),
    maxBatch: alloc.batch + 1,
  };
}

/**
 * Re-stamps the queue for a reshape. Pure, like stampBatch, and writes NOTHING but `batch` for
 * the same reasons — a snapshot patched back wholesale would revert renames and redos that
 * landed meanwhile, and touching `source` would make in-flight results look stale.
 *
 * Unlike stampBatch this deliberately overwrites an existing stamp: moving an image from a
 * retired batch to its replacement is the entire operation.
 */
export function applyReshape(items: BgItem[], reshape: BatchReshape): BgItem[] {
  const moves = new Map<number, number>();
  for (const group of reshape.groups) {
    for (const item of group.members) moves.set(item.id, group.batch);
  }
  const retired = new Set(reshape.retire);
  return items.map((item) => {
    const next = moves.get(item.id);
    if (next !== undefined) return { ...item, batch: next };
    // A retired batch's member that is no longer shippable (deleted mid-reshape, or in flight)
    // has no group to go to. Leaving the old stamp would point at a row that is gone, so it goes
    // back to unexported — visible in the tail, which is where an image nothing has shipped
    // belongs.
    if (typeof item.batch === 'number' && retired.has(item.batch)) {
      const next = { ...item };
      delete next.batch;
      return next;
    }
    return item;
  });
}

/**
 * The ledger rows a reshape produces.
 *
 * The shipped set is rebuilt member by member rather than merged: a WeakSet cannot be
 * enumerated, so the only way to carry identity across is to ask each OLD record whether it
 * shipped this exact blob. That is also what preserves staleness — an image edited since its
 * download fails its old record's test, is left out of the new set, and the reshaped batch
 * reports stale exactly as its predecessor did.
 */
export function reshapeRecords(
  reshape: BatchReshape,
  ledger: readonly BatchRecord[],
  details: { savedAt?: number } = {},
): BatchRecord[] {
  const old = new Map<number, BatchRecord>();
  for (const record of ledger) old.set(record.batch, record);
  const savedAt = details.savedAt ?? Date.now();

  return reshape.groups.map((group) => {
    const shipped = new WeakSet<Blob>();
    let fileName: string | undefined;
    for (const item of group.members) {
      const source = typeof item.batch === 'number' ? old.get(item.batch) : undefined;
      if (source?.shipped.has(item.cutout.blob)) shipped.add(item.cutout.blob);
      // The first contributing batch's file name, purely so the row can still name something on
      // disk. It is a label; nothing branches on it.
      if (!fileName && source?.fileName) fileName = source.fileName;
    }
    return {
      batch: group.batch,
      offset: group.offset,
      count: group.members.length,
      savedAt,
      ...(fileName ? { fileName } : null),
      shipped,
    };
  });
}

/**
 * One ZIP holding several batches' files, each keeping the number it already has.
 *
 * A convenience over the same machinery as a re-export: same adjacency rule, same offset, so the
 * combined archive unzips over the separate folders it replaces. It changes NO stamps and
 * retires NO batches — the receipts stay exactly as they were, the user just clicks save once
 * instead of eight times.
 */
export function planCombined(
  items: readonly BgItem[],
  summary: readonly LedgerBatch[],
  picked: readonly number[],
): ExportPlan | null {
  if (!canCombineBatches(summary, picked).ok) return null;
  const rows = summary.filter((b) => picked.includes(b.batch));
  const offset = Math.min(...rows.map((b) => b.offset ?? 0));
  const startOf = new Map(rows.map((b) => [b.batch, b.offset ?? 0]));
  const members = items.filter(
    (item): item is CutoutItem =>
      typeof item.batch === 'number' && startOf.has(item.batch) && isShippable(item),
  );
  if (!members.length) return null;
  // Ordered by the batch's own starting number, not by where the rows happen to sit in the queue.
  // exportItems names files positionally (offset + index + 1), so a queue where batch 3's images
  // precede batch 2's would have written each of them under the other's number — and the promise
  // this action makes is that every file keeps the name it already has. Stable within a batch, so
  // members keep their relative order there.
  members.sort((a, b) => (startOf.get(a.batch as number) ?? 0) - (startOf.get(b.batch as number) ?? 0));
  return { batch: Math.min(...picked), offset, items: members };
}

/**
 * The images in a batch whose picture has changed since its ZIP was written — the "what changed"
 * list. Empty for a current batch, and for a restored one, where nothing can be compared.
 */
export function changedSince(items: readonly BgItem[], record: BatchRecord): BgItem[] {
  return items.filter(
    (item) =>
      item.batch === record.batch &&
      (item.cutout === null || !record.shipped.has(item.cutout.blob)),
  );
}
