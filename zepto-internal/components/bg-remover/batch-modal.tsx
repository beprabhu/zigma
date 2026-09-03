'use client';

// Every batch this session has shipped, on one screen.
//
// The rail this sits behind holds ~200px, which is four rows. A 14,000-image run makes 28 of
// them, so the receipts were a letterbox you scrolled through while the two controls that
// actually DO something — export the clean pile, export the rest — got pushed toward the bottom
// of the panel. Splitting them was the fix: the two live cohorts stay pinned in the pane, where
// they are watched during a run, and the finished batches move here, where there is room to
// operate on them.
//
// What became possible once there was room:
//   download several batches as one ZIP   the lazy 90% of "I have eight ZIPs to save"
//   merge neighbours / split one          bookkeeping only; see the reshape notes in ledger.ts
//   see WHICH images went stale           the ledger already knows, nothing else ever showed it
//
// One rule the layout enforces: a stale batch can never be quiet. The summary chip in the pane
// carries the count in amber, and a stale row here is amber whether or not it is selected — a
// downloaded ZIP that is out of date is the one thing in this product that ships wrong work to
// somebody else.

import * as React from 'react';
import {
  AlertTriangleIcon, CheckIcon, CombineIcon, DownloadIcon, RefreshCwIcon, ScissorsIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type { BgItem } from '@/lib/bg/batch';
import type { BatchReshape, LedgerBatch } from '@/lib/bg/ledger';

const n = (value: number) => value.toLocaleString();

export interface BatchModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Ascending by batch number — the same rows the rail summarises. */
  batches: readonly LedgerBatch[];
  /** Batch numbers that are sealed but whose ZIP has never been written. */
  pendingBatches: ReadonlySet<number>;
  /** The images in a given batch whose picture changed since its ZIP — for the changed list. */
  changedIn: (batch: number) => BgItem[];
  /** Narrows the results grid to one batch. Closing is the caller's job — see onSelect below. */
  onSelect: (batch: number) => void;
  onDownload: (batch: number) => void;
  /** One ZIP for several batches, each file keeping the number it already has. */
  onDownloadTogether: (batches: number[]) => void;
  /** Null when the pick cannot be merged; the string is the reason to show. */
  mergeBlocked: (batches: number[]) => string;
  /** The same, for packaging several batches into one ZIP — a weaker test than merging. */
  combineBlocked: (batches: number[]) => string;
  onMerge: (batches: number[]) => void;
  onSplit: (batch: number, at: number) => void;
  /** What a reshape would cost, for the confirm step. Null when the pick is invalid. */
  previewMerge: (batches: number[]) => BatchReshape | null;
  previewSplit: (batch: number, at: number) => BatchReshape | null;
  downloadingBatch: number | null;
  busy?: boolean;
  /** Images per automatic seal. Applies to the NEXT seal only — sealed batches never change. */
  sealSize: number;
  onSealSizeChange: (size: number) => void;
  /** Clean images waiting right now, so lowering the size can warn about the burst it causes. */
  cleanWaiting: number;
}

export function BatchModal({
  open,
  onOpenChange,
  batches,
  pendingBatches,
  changedIn,
  onSelect,
  onDownload,
  onDownloadTogether,
  mergeBlocked,
  combineBlocked,
  onMerge,
  onSplit,
  previewMerge,
  previewSplit,
  downloadingBatch,
  busy,
  sealSize,
  onSealSizeChange,
  cleanWaiting,
}: BatchModalProps) {
  const [picked, setPicked] = React.useState<ReadonlySet<number>>(() => new Set());
  const [expanded, setExpanded] = React.useState<number | null>(null);
  const [splitting, setSplitting] = React.useState<{ batch: number; at: number } | null>(null);
  const [confirm, setConfirm] = React.useState<
    { kind: 'merge'; batches: number[]; reshape: BatchReshape }
    | { kind: 'split'; batch: number; at: number; reshape: BatchReshape }
    | null
  >(null);

  /**
   * The pick, narrowed to batches that still exist.
   *
   * Derived rather than reset from an effect: a merge retires the numbers it consumed, and a
   * selection still holding them would arm Merge over rows that are gone. Filtering here means
   * the stale numbers simply stop counting the moment the row list changes, with no ordering
   * question about which update lands first. `expanded` and `splitting` need no such treatment —
   * they are compared against a row's number while rendering that row, so a retired value
   * matches nothing and draws nothing.
   */
  const pickedList = React.useMemo(() => {
    const live = new Set(batches.map((b) => b.batch));
    return [...picked].filter((batch) => live.has(batch)).sort((a, b) => a - b);
  }, [picked, batches]);
  // Two different questions: packaging needs the numbering to line up, merging needs that AND a
  // record of what shipped. Sharing one reason disabled Download together for restored batches it
  // could have handled, and explained the refusal in merge terms.
  const combineReason = pickedList.length >= 2 ? combineBlocked(pickedList) : '';
  const mergeReason = pickedList.length >= 2 ? mergeBlocked(pickedList) : '';
  const blockedReason = combineReason || mergeReason;
  const staleCount = batches.filter((b) => b.staleness === 'stale').length;

  const toggle = (batch: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(batch)) next.delete(batch);
      else next.add(batch);
      return next;
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <div className="shrink-0 border-b px-5 pt-5 pb-4">
          <DialogHeader className="gap-1">
            <DialogTitle>Batches</DialogTitle>
            <DialogDescription>
              {batches.length === 0
                ? 'Nothing has been exported yet.'
                : `${n(batches.length)} batch${batches.length === 1 ? '' : 'es'}${
                    staleCount ? ` · ${n(staleCount)} need re-downloading` : ''
                  }. Every image belongs to exactly one batch, and its file number never changes.`}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="bg-scroll-slim min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div role="list" className="flex flex-col gap-1.5">
            {batches.map((entry) => (
              <BatchDetailRow
                key={entry.batch}
                entry={entry}
                pending={pendingBatches.has(entry.batch)}
                picked={picked.has(entry.batch)}
                onPick={() => toggle(entry.batch)}
                expanded={expanded === entry.batch}
                onExpand={() => setExpanded((prev) => (prev === entry.batch ? null : entry.batch))}
                changed={expanded === entry.batch ? changedIn(entry.batch) : []}
                onSelect={() => {
                  // Closes on the way out: the filter it applies lands on the grid BEHIND this
                  // dialog, so leaving the modal up would look like the click did nothing.
                  onSelect(entry.batch);
                  onOpenChange(false);
                }}
                onDownload={() => onDownload(entry.batch)}
                downloading={downloadingBatch === entry.batch}
                busy={busy}
                splitting={splitting?.batch === entry.batch ? splitting.at : null}
                onStartSplit={() =>
                  setSplitting((prev) =>
                    prev?.batch === entry.batch
                      ? null
                      : { batch: entry.batch, at: Math.max(1, Math.floor(entry.present / 2)) },
                  )
                }
                onSplitAtChange={(at) => setSplitting({ batch: entry.batch, at })}
                onConfirmSplit={() => {
                  const reshape = previewSplit(entry.batch, splitting?.at ?? 0);
                  if (reshape) setConfirm({ kind: 'split', batch: entry.batch, at: splitting!.at, reshape });
                }}
              />
            ))}
          </div>

          <SealSizeField
            sealSize={sealSize}
            onChange={onSealSizeChange}
            cleanWaiting={cleanWaiting}
          />
        </div>

        {/* mx-0/mb-0 undo DialogFooter's built-in -mx-4 -mb-4. Those exist to let a footer bleed to
            the edge of a dialog whose body carries the padding; this one sets p-0 on the content
            and pads each section itself, so the negative margins only pulled the footer 16px left
            of the header and the rows above it. */}
        <DialogFooter className="shrink-0 mx-0 mb-0 flex-col items-stretch gap-2 border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {pickedList.length
              ? `${n(pickedList.length)} selected`
              : 'Select two or more batches to download them as one ZIP, or to merge them.'}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {/* The reason lives beside the disabled buttons rather than inside a tooltip on
                them: a disabled control does not reliably fire hover, so a tooltip is exactly
                the wrong place to explain why something cannot be pressed. */}
            {blockedReason && (
              <span className="max-w-72 text-xs text-amber-600 dark:text-amber-500">
                {blockedReason}
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={pickedList.length < 2 || !!combineReason || busy}
              onClick={() => onDownloadTogether(pickedList)}
              title="One ZIP holding these batches. Every file keeps the number it already has, and no batch record changes."
            >
              <DownloadIcon data-icon="inline-start" />
              Download as one ZIP
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pickedList.length < 2 || !!mergeReason || busy}
              title="Replace these batches with a single one. Permanent, and it can renumber files — the next step says how many."
              onClick={() => {
                const reshape = previewMerge(pickedList);
                if (reshape) setConfirm({ kind: 'merge', batches: pickedList, reshape });
              }}
            >
              <CombineIcon data-icon="inline-start" />
              Merge into one batch
            </Button>
          </div>
        </DialogFooter>

        {confirm && (
          <ReshapeConfirm
            confirm={confirm}
            onCancel={() => setConfirm(null)}
            onConfirm={() => {
              if (confirm.kind === 'merge') onMerge(confirm.batches);
              else onSplit(confirm.batch, confirm.at);
              setConfirm(null);
              setSplitting(null);
              setPicked(new Set());
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function BatchDetailRow({
  entry,
  pending,
  picked,
  onPick,
  expanded,
  onExpand,
  changed,
  onSelect,
  onDownload,
  downloading,
  busy,
  splitting,
  onStartSplit,
  onSplitAtChange,
  onConfirmSplit,
}: {
  entry: LedgerBatch;
  pending: boolean;
  picked: boolean;
  onPick: () => void;
  expanded: boolean;
  onExpand: () => void;
  changed: BgItem[];
  onSelect: () => void;
  onDownload: () => void;
  downloading: boolean;
  busy?: boolean;
  splitting: number | null;
  onStartSplit: () => void;
  onSplitAtChange: (at: number) => void;
  onConfirmSplit: () => void;
}) {
  const stale = entry.staleness === 'stale';
  const unknown = entry.staleness === 'unknown';
  const total = entry.shipped ?? entry.present;
  const missing = total - entry.present;
  // A restored batch cannot be reshaped and has no comparison to show — see the reshape notes in
  // ledger.ts. Its row stays informational rather than offering actions that would have to lie.
  const reshapeable = !unknown && !pending;
  /**
   * Whether a rebuild can name the files the way the ZIP on disk names them. A sealed-but-unsent
   * batch ships from its open plan; any other needs a known starting number, which only a batch
   * whose numbering reached disk still has.
   */
  const downloadable = pending || entry.offset !== undefined;
  /**
   * Whether this row may take part in a multi-batch action. Gated on knowing its file numbers,
   * NOT on being reshapeable: a restored batch cannot be merged, but it can still be packaged
   * into one ZIP alongside its neighbours, and gating the checkbox on merge rules made that
   * impossible even to attempt.
   */
  const selectable = !pending && entry.offset !== undefined;

  return (
    <div
      role="listitem"
      className={cn(
        'rounded-lg border transition-colors',
        stale && 'border-amber-500/50 bg-amber-500/5',
        picked && 'border-primary/60 bg-primary/5',
      )}
    >
      <div className="flex items-center gap-2 px-2.5 py-2">
        <Checkbox
          checked={picked}
          disabled={!selectable || busy}
          onCheckedChange={onPick}
          aria-label={`Select batch ${entry.batch}`}
        />
        <button
          type="button"
          onClick={onSelect}
          className="min-w-0 flex-1 text-left outline-none focus-visible:underline"
          title="Show only this batch in the results grid"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {stale ? (
              <AlertTriangleIcon className="size-3.5 shrink-0 text-amber-500" />
            ) : (
              <CheckIcon className={cn('size-3.5 shrink-0', unknown ? 'text-muted-foreground' : 'text-primary')} />
            )}
            <span className="truncate text-sm font-medium">Batch {entry.batch}</span>
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground tabular-nums">
            {n(total)} file{total === 1 ? '' : 's'}
            {entry.offset !== undefined && ` · numbered ${n(entry.offset + 1)}–${n(entry.offset + total)}`}
            {missing > 0 && ` · ${n(missing)} deleted since`}
            {pending && ' · not downloaded yet'}
            {unknown && (downloadable ? ' · restored, contents unverified' : ' · restored from an earlier session')}
          </span>
        </button>

        {stale && (
          <Button variant="ghost" size="xs" onClick={onExpand} className="shrink-0 text-amber-600 dark:text-amber-500">
            {n(changed.length || 0) !== '0' && expanded ? 'Hide' : 'What changed'}
          </Button>
        )}
        {reshapeable && entry.present > 1 && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            title="Split this batch in two"
            disabled={busy}
            onClick={onStartSplit}
          >
            <ScissorsIcon className="size-3.5" />
          </Button>
        )}
        {/* A batch whose numbering was never stored cannot be rebuilt: its file names would have
            to start somewhere, and any guess collides with the ZIP already on disk. It used to be
            offered anyway and the click did nothing at all — a dead control that looked live. */}
        <Button
          variant={stale ? 'default' : 'outline'}
          size="xs"
          className="shrink-0"
          disabled={downloading || busy || !downloadable}
          onClick={onDownload}
          title={
            !downloadable
              ? 'This batch was restored from an earlier session without its file numbering, so it cannot be rebuilt under the same names. The ZIP you already downloaded is still valid.'
              : stale
                ? 'An image changed after this ZIP was built — build it again'
                : 'Download this batch again'
          }
        >
          {downloading ? (
            <Spinner data-icon="inline-start" />
          ) : stale ? (
            <RefreshCwIcon data-icon="inline-start" />
          ) : (
            <DownloadIcon data-icon="inline-start" />
          )}
          {stale ? 'Rebuild' : 'Download'}
        </Button>
      </div>

      {expanded && stale && (
        <div className="border-t px-2.5 py-2">
          <p className="text-xs text-muted-foreground">
            {changed.length
              ? `${n(changed.length)} image${changed.length === 1 ? '' : 's'} changed since this ZIP was built. Rebuilding writes the same file names, so replace the folder you downloaded.`
              : 'This batch is marked out of date but no changed image is in the queue any more — rebuilding will write what is left.'}
          </p>
          {changed.length > 0 && (
            <ScrollArea className="mt-2 max-h-32">
              <ul className="flex flex-col gap-1 pr-2">
                {changed.map((item) => (
                  <li key={item.id} className="truncate text-xs text-muted-foreground">
                    {item.name}
                    {item.cutout === null && ' — being regenerated'}
                  </li>
                ))}
              </ul>
            </ScrollArea>
          )}
        </div>
      )}

      {splitting !== null && (
        <div className="flex flex-wrap items-center gap-2 border-t px-2.5 py-2">
          <span className="text-xs text-muted-foreground">Keep the first</span>
          <Input
            type="number"
            min={1}
            max={Math.max(1, entry.present - 1)}
            value={splitting}
            onChange={(e) => onSplitAtChange(Number(e.target.value))}
            className="h-7 w-20 text-xs"
            aria-label="Images in the first batch"
          />
          <span className="text-xs text-muted-foreground">
            of {n(entry.present)}, rest become a new batch
          </span>
          <Button
            variant="outline"
            size="xs"
            className="ml-auto"
            disabled={splitting < 1 || splitting >= entry.present}
            onClick={onConfirmSplit}
          >
            Split
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The seal size, where the batches are.
 *
 * Settings already owns this value; this is a second door onto the same one, put here because
 * this is the screen where a person is thinking about batch sizes. It applies to the NEXT seal
 * only — sealed batches are receipts for files already on disk and never change.
 */
function SealSizeField({
  sealSize,
  onChange,
  cleanWaiting,
}: {
  sealSize: number;
  onChange: (size: number) => void;
  cleanWaiting: number;
}) {
  // Lowering the size below what is already waiting seals the backlog immediately, one batch per
  // queue commit — correct, but a surprise worth naming before it happens rather than after six
  // ZIPs have appeared.
  const burst = cleanWaiting > sealSize ? Math.floor(cleanWaiting / Math.max(1, sealSize)) : 0;
  /**
   * Held back until the number is finished.
   *
   * The committed value feeds the live seal effect, so every intermediate keystroke was a real
   * decision: typing 500 over 50 passed through 5, sealing a five-image batch on the spot — and a
   * seal is irreversible, claiming its items and bumping the batch number and file offset for good.
   * `Number('') || 1` made clearing the field commit 1, which is the worst case of the same thing.
   * Enter and blur commit; Escape abandons.
   */
  const [draft, setDraft] = React.useState<string | null>(null);
  const commit = (raw: string) => {
    setDraft(null);
    const next = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(next)) return;
    const clamped = Math.max(1, Math.round(next));
    if (clamped !== sealSize) onChange(clamped);
  };
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-2.5 py-2">
      <span className="text-xs text-muted-foreground">Seal a batch every</span>
      <Input
        type="number"
        min={1}
        value={draft ?? String(sealSize)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(e.currentTarget.value); }
          else if (e.key === 'Escape') { e.preventDefault(); setDraft(null); }
        }}
        className="h-7 w-24 text-xs"
        aria-label="Images per batch"
      />
      <span className="text-xs text-muted-foreground">clean images.</span>
      <span className="text-xs text-muted-foreground/80">
        Applies to the next batch — the ones above keep the sizes they shipped at.
      </span>
      {burst > 1 && (
        <span className="w-full text-xs text-amber-600 dark:text-amber-500">
          {n(cleanWaiting)} clean images are already waiting, so this seals about {n(burst)} batches
          as soon as the next run commits.
        </span>
      )}
    </div>
  );
}

/**
 * The one screen that says what a reshape costs before it happens.
 *
 * `renamed` is the number that matters. Zero means the ZIPs already downloaded stay correct file
 * for file and nothing needs doing — which is the normal case, and worth stating plainly, since
 * "merge" sounds like it should invalidate something. Non-zero means folders have to be replaced,
 * and the count is how many files move.
 */
function ReshapeConfirm({
  confirm,
  onCancel,
  onConfirm,
}: {
  confirm:
    | { kind: 'merge'; batches: number[]; reshape: BatchReshape }
    | { kind: 'split'; batch: number; at: number; reshape: BatchReshape };
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { reshape } = confirm;
  const total = reshape.groups.reduce((sum, g) => sum + g.members.length, 0);
  return (
    <div className="absolute inset-0 z-10 grid place-items-center bg-background/85 p-6 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border bg-card p-5 shadow-lg">
        <h3 className="text-sm font-semibold">
          {confirm.kind === 'merge'
            ? `Merge ${n(confirm.batches.length)} batches into one?`
            : `Split batch ${confirm.batch} in two?`}
        </h3>
        <p className="mt-2 text-xs text-muted-foreground">
          {confirm.kind === 'merge'
            ? `Batches ${confirm.batches.join(', ')} become one batch of ${n(total)} images.`
            : `${n(reshape.groups[0].members.length)} images stay, ${n(reshape.groups[1]?.members.length ?? 0)} move to a new batch.`}
        </p>
        <p
          className={cn(
            'mt-2 text-xs',
            reshape.renamed ? 'text-amber-600 dark:text-amber-500' : 'text-muted-foreground',
          )}
        >
          {reshape.renamed === 0
            ? 'Every file keeps its name and number, so the ZIPs you already downloaded stay correct — nothing to re-download.'
            : `${n(reshape.renamed)} file${reshape.renamed === 1 ? '' : 's'} would be numbered differently. Download the result again and replace the folder you have.`}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Batch numbers are never reused, so this batch gets a new one.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={onConfirm}>
            {confirm.kind === 'merge' ? 'Merge' : 'Split'}
          </Button>
        </div>
      </div>
    </div>
  );
}
