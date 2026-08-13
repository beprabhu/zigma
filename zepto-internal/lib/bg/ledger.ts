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
 *   - 'removing' or 'loading-model' — a redo cleared the cutout first, so also nothing;
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
      verdictOf(item).level === 'ok',
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
export function nextBatchNumber(
  items: readonly BgItem[],
  ledger: readonly BatchRecord[] = [],
): number {
  let max = 0;
  for (const item of items) {
    if (typeof item.batch === 'number' && item.batch > max) max = item.batch;
  }
  for (const record of ledger) {
    if (record.batch > max) max = record.batch;
  }
  return max + 1;
}

/**
 * How many files have already been written across every ZIP so far — the offset the next export's
 * numbering continues from, so batch 2 starts at 501 and unzipping both into one folder cannot
 * overwrite anything.
 *
 * A HIGH-WATER MARK, not a live count of stamped items, and the difference is a real collision:
 * export 500, delete 3 of them, export again — counting stamps gives 497, the second ZIP starts
 * at 498, and its first three files land on top of files 498-500 from the first. The ledger's
 * records are the memory of files that exist on disk whether or not their items still exist here.
 *
 * The stamped count is still the floor, because a queue restored from a .zesku carries stamps
 * with no records behind them; there it is the only evidence of how many files were written.
 */
export function exportedFileCount(
  items: readonly BgItem[],
  ledger: readonly BatchRecord[] = [],
): number {
  let stamped = 0;
  for (const item of items) {
    if (isExported(item)) stamped++;
  }
  let high = stamped;
  for (const record of ledger) {
    const end = record.offset + record.count;
    if (end > high) high = end;
  }
  return high;
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
  items: readonly BgItem[],
  ledger: readonly BatchRecord[] = [],
): ExportPlan | null {
  if (!cohort.length) return null;
  return {
    batch: nextBatchNumber(items, ledger),
    offset: exportedFileCount(items, ledger),
    items: [...cohort],
  };
}

export interface SealOptions extends CohortOptions {
  /** Clean-and-unexported images required before a batch seals. Defaults to DEFAULT_SEAL_SIZE. */
  threshold?: number;
  ledger?: readonly BatchRecord[];
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
  options: SealOptions = {},
): ExportPlan | null {
  // A threshold under 1 would seal a one-image ZIP on every single commit of a running batch.
  const threshold = Math.max(1, Math.round(options.threshold ?? DEFAULT_SEAL_SIZE));
  const clean = cleanUnexported(items, verdictOf, options);
  if (clean.length < threshold) return null;
  return planExport(clean.slice(0, threshold), items, options.ledger);
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

export interface LedgerBatch {
  batch: number;
  /** How many images the ZIP holds, or null when only stamps survive (a restored project). */
  shipped: number | null;
  /**
   * How many of them are still in the queue. Lower than `shipped` after a deletion, which is not
   * a problem to fix: the file on disk still contains that image, and its slot in the numbering
   * stays reserved (see exportedFileCount).
   */
  present: number;
  staleness: BatchStaleness;
  offset?: number;
  savedAt?: number;
  fileName?: string;
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
  options: CohortOptions = {},
): LedgerSummary {
  const { claimed: claimedIds } = options;
  const records = new Map<number, BatchRecord>();
  for (const record of ledger) records.set(record.batch, record);

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
      if (record && (item.cutout === null || !record.shipped.has(item.cutout.blob))) {
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
  const numbers = [...new Set([...records.keys(), ...present.keys()])].sort((a, b) => a - b);
  const batches = numbers.map((batch): LedgerBatch => {
    const record = records.get(batch);
    return {
      batch,
      shipped: record ? record.count : null,
      present: present.get(batch) ?? 0,
      staleness: !record ? 'unknown' : changed.has(batch) ? 'stale' : 'current',
      ...(record ? { offset: record.offset, savedAt: record.savedAt } : null),
      ...(record?.fileName ? { fileName: record.fileName } : null),
    };
  });

  return { batches, exported, claimed, ready, waiting, total: items.length };
}
