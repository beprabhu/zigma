// The shapes the file store is built from, and the contract a tool has to satisfy to live in it.
//
// One "file" is one session of one tool — a Compose grid, a Cleanup batch — held under a uuid that
// outlives the tab. It replaces the single unnamed crash net the BG remover used to keep, and the
// restore/discard prompt that came with it: a file is addressed by id, so a fresh mount can no
// longer be mistaken for "the user deleted everything" and nothing has to be arbitrated by a modal.
//
// Split across three records rather than one document, for the reason the crash net it replaces
// established: a whole-project snapshot serializes gigabytes on a timer and still loses whatever
// finished after the last tick. FileRecord is the small header the homepage reads, ItemRecord is per queue row and
// written the moment recoverable work lands, MetaRecord holds the per-file singletons that belong to
// no single row.


/**
 * The four products, as a closed union rather than `string`.
 *
 * Maintained by hand against PRODUCTS (lib/products.ts) rather than derived from it: `Product.slug`
 * is typed `string`, so inferring from the array would widen this back to `string` and every codec
 * registry lookup would lose its exhaustiveness check. Adding a product means adding it here too —
 * nothing in the type system can catch the omission, which is the price of the narrow union.
 */
export type ToolSlug = 'compositor' | 'bg-remover' | 'image-generator' | 'png-compressor';

/**
 * Item ids are NOT one type across the suite: BgItem.id and QueueItem.id are counters
 * (lib/bg/batch.ts, lib/types.ts), while the compressor mints uuids (app/png-compressor/page.tsx).
 * The store stays agnostic, but see the key-range note in db.ts — the mix is the exact reason the
 * prefix range's upper sentinel has to be `[]` and can never be a number.
 */
export type ItemId = number | string;

/**
 * The homepage's row, and the only record read to draw a card. Everything on it is either small or
 * a thumbnail, because listFiles() reads ALL of them on every homepage mount — which is what keeps
 * parsed CSV rows out of `doc` (see below).
 */
export interface FileRecord {
  id: string;
  tool: ToolSlug;
  /** The session name the tool already shows in its header; "Untitled" until the user types one. */
  name: string;
  createdAt: number;
  /**
   * Last CONTENT write. Deliberately not bumped by opening a file: the 7-day sweep reads this, and
   * a browse that touched every card would silently grant every one of them another week.
   */
  updatedAt: number;
  /** Set by the Keep toggle. Non-null = pinned, exempt from expiry. The only thing that is. */
  keptAt: number | null;
  /**
   * Stage one of expiry. Set by the sweep at 7 days, which takes the card off the grid and into
   * Trash; the hard delete comes a week later. A one-shot delete on a wall clock is the only
   * irreversible mass-delete in the app, and it fires while nobody is watching.
   */
  deletedAt: number | null;
  /** Small WebP the grid draws. Null until the file has produced a result worth showing. */
  thumb: Blob | null;
  /**
   * DOCUMENT rows, not persisted item records — the codec reports it via countOf(). A Compose file
   * holding a 3,000-row sheet and a six-band grid but no runs yet has zero item records, and a card
   * reading "0 images" invites the user to delete exactly the mapping work that took longest.
   */
  itemCount: number;
  /**
   * Roughly what this file occupies, summed from the blobs each pass writes. Four tools now share
   * one origin quota where one used to; when it runs out the pump's only signal is a generic
   * `failing` flag, and this is what lets the homepage say which card to
   * delete instead of leaving the user to guess.
   */
  bytes: number;
  /**
   * The codec's own doc shape version. Exists so a tool can evolve what it stores WITHOUT a database
   * version bump — the bump is the dangerous operation here, and under a files model an aborted version
   * change takes everyone's whole document set rather than one crash net.
   */
  schema: number;
  /** Light document identity, owned entirely by the codec. See the size rule on ToolCodec.docOf. */
  doc: unknown;
}

/** One queue row's recoverable state. The file-scoped generalization of AutosaveRecord. */
export interface ItemRecord {
  fileId: string;
  id: ItemId;
  savedAt: number;
  /** Plain data only — numbers, strings, arrays, plain objects. Never a class, never an element. */
  data: unknown;
  /**
   * Named binary payloads: 'cutout', 'source', 'result', 'output'. Split out of `data` so the header
   * writer can sum a file's bytes and pick a thumbnail source without walking an opaque payload, and
   * so the one rule a codec must not break — nothing non-clonable rides along — is checkable.
   */
  blobs: Record<string, Blob>;
}

/** A per-file singleton: the imported sheet, the export ledger, the open-tab heartbeat. */
export interface MetaRecord {
  fileId: string;
  key: string;
  savedAt: number;
  value: unknown;
}

/** What a codec hands back for one row, or null when the row holds nothing worth recovering. */
export interface ItemPayload {
  data: unknown;
  blobs: Record<string, Blob>;
}

/**
 * The seam that keeps the store from ever naming a tool's types.
 *
 * Implementations live in lib/files/codecs/. The generic pump calls signatureOf on every commit and
 * recordOf only when the signature moved, so both are on the hot path for a 3,000-row queue.
 */
export interface ToolCodec<TItem, TDoc> {
  tool: ToolSlug;
  /** Bumped by the codec when `doc`'s shape changes; read back by docFrom to migrate in place. */
  schema: number;

  idOf(item: TItem): ItemId;

  /**
   * The values whose change means "rewrite this row's record", compared ELEMENTWISE BY IDENTITY.
   *
   * Identity, not content, because a cutout blob or a generated image is only ever swapped
   * wholesale — which turns the per-render diff into O(n) pointer checks instead of content
   * hashing.
   *
   * What you leave OUT matters more than what you put in: every element costs a full record
   * rewrite, blobs included, for each row it differs on. A field that changes for the whole queue
   * at once (a re-group, a batch stamp) turns one user action into gigabytes moved, and belongs in
   * a meta singleton instead — that is precisely why `batch` is not in Cleanup's signature and the
   * export ledger exists.
   */
  signatureOf(item: TItem): readonly unknown[];

  /**
   * The row's recoverable state, or null when there is nothing worth saving.
   *
   * Async because two tools hold their results as HTMLImageElements over data: URLs and have to
   * re-encode to a Blob here, at write time — the store never accepts anything it cannot clone.
   *
   * THE DRAFTS RULE (it holds for every tool): persist recoverable
   * OUTPUT, never raw input the user can re-drop. A dropped original costs nothing to re-add and
   * writing every one of them doubles the batch's footprint — in a store now shared by four tools,
   * that is quota spent on re-droppable bytes instead of on paid Azure output.
   */
  recordOf(item: TItem, savedAt: number): Promise<ItemPayload | null>;

  /** Rebuild a live queue row. `id` may differ from record.id — see the re-mint note in the hook. */
  itemFrom(record: ItemRecord, id: ItemId): TItem;

  /**
   * The document state worth keeping: session name, mode, column mappings, id counters, bands with
   * their parsed rows STRIPPED.
   *
   * Hard size rule: listFiles() reads every FileRecord on every homepage mount, so anything that
   * scales with the sheet cannot live here. GridBand carries its own `records` (lib/types.ts:62) —
   * megabytes per band — and the CSV text is a meta singleton for the same reason.
   */
  docOf(state: TDoc): unknown;
  docFrom(raw: unknown, schema: number): TDoc | null;

  /**
   * Whether the user has authored anything yet. The FileRecord is minted on the first true, so a
   * rail click alone never litters the grid with empty Untitled cards.
   *
   * Judge the DOCUMENT, not the item records: a Generate file that is a written brief and a list of
   * subjects has no items at all and is still very much a file.
   */
  hasContent(doc: TDoc, items: readonly TItem[]): boolean;

  /** Rows in the document — see FileRecord.itemCount for why this is not items.length. */
  countOf(doc: TDoc, items: readonly TItem[]): number;

  /**
   * The blob the card's thumbnail is drawn from, or null. Called only by the header writer, and its
   * identity is what decides whether the thumbnail is re-encoded — so return the SAME blob
   * reference for an unchanged result, or a 3,000-item run re-encodes a thumbnail 3,000 times.
   */
  thumbSourceOf(items: readonly TItem[]): Blob | null;
}
