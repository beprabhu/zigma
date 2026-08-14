'use client';

// The batches list: one row per export artifact, stacked in the right panel's "Process & export"
// column. Batches ARE exports — a ZIP that exists or is about to — so they live beside the other
// export controls rather than among the grid's view controls, where they read as a third kind of
// filter chip next to five real ones.
//
// The list carries two cohorts that are not batches yet, drawn so they cannot be taken for one —
// dashed, unnumbered, unselectable:
//
//   Filling    the clean cutouts piling up toward the next automatic seal. It has no number
//              because nothing has stamped BgItem.batch for it yet, and no ZIP because the run
//              has not sealed it.
//   Remaining  everything with a cutout that no batch has claimed — flagged or not — which is
//              the cohort the user exports by hand once the AI fixes have landed. Its export is
//              what guarantees the ZIPs add up to the whole queue.
//
// Vertical beats the horizontal rail this replaces for one reason above the rest: a rail grows
// along the axis its own buttons sit on, so every seal slid the Download and Export buttons out
// from under a pointer already aiming at them. Rows grow downward, and the two rows a run keeps
// changing (Filling, Remaining) are pinned outside the scrolling group below.
//
// Purely presentational: it is handed a progress snapshot per batch and reports clicks back.

import {
  CircleCheckIcon, DownloadIcon, FilterXIcon, InboxIcon, PackagePlusIcon, RefreshCwIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import { Toggle } from '@/components/ui/toggle';
import { cn } from '@/lib/utils';

export interface BatchProgress {
  /** The value stored on BgItem.batch. Also the row's identity and selection value. */
  batch: number;
  /** Defaults to "Batch {n}". */
  label?: string;
  /**
   * Items of this batch still accounted for in the queue. Below `total` in two unrelated cases —
   * a batch the runner has not finished, and a shipped batch whose images were later deleted —
   * which is why the row never draws this as progress unless `running` says a run is behind it.
   */
  done: number;
  /** How many files the ZIP holds, or will hold. The count the row shows. */
  total: number;
  /** Settled-but-failed items, counted inside `done`. A batch can complete and still be partly broken. */
  errors?: number;
  /** This batch is the one the runner is currently working. */
  running?: boolean;
  /** A ZIP for this batch has been produced at least once. */
  downloaded?: boolean;
  /**
   * An item in this batch changed after that download — an AI fix landing in a finished batch is
   * the ordinary case. The ZIP on the user's disk is now stale.
   */
  stale?: boolean;
}

/**
 * The cohort accumulating toward the next seal: finished, clean and not yet exported.
 *
 * Deliberately not a BatchProgress. It has no `batch` number to be identified by, and its
 * membership is a live predicate rather than a stamp — an item leaves it the moment a quality
 * flag lands on it and rejoins when an AI fix clears one — so anything that treats it as a batch
 * would be describing a set that has already changed.
 */
export interface FillingBatch {
  /** True when no run is in flight: the row becomes an action instead of a progress readout. */
  idle?: boolean;
  /** Clean unexported cutouts counted so far — the numerator of the seal. */
  clean: number;
  /** How many it takes to seal. The page's batch size; 500 by default. */
  threshold: number;
}

/**
 * The unexported tail: every item that HAS a cutout and no batch, whatever its flag says.
 *
 * Flag state is not part of the definition on purpose. Flagged-ness moves — an AI fix un-flags
 * an item — so a cohort defined by it would let items slip out between the seal and the export
 * and end up in no ZIP at all. "Has a cutout, not yet exported" is the only membership rule that
 * makes the sealed ZIPs plus this one add up to the queue exactly once.
 */
export interface TailCohort {
  /** Everything still unexported, including the clean ones counted by FillingBatch above — one
   *  set contains the other, which is why exporting this cohort ends the run cleanly. */
  count: number;
  /** How many of those are flagged. Shown because it is the reason the tail exists at all. */
  flagged?: number;
  /** Defaults to "Not yet exported" — see TailRow for why that wording is load-bearing. */
  label?: string;
}

export interface BatchListProps {
  /**
   * Ascending by batch number, and it has to stay that way: a newly sealed batch is then always
   * an append, which is what lets every row already on screen keep its position while a run
   * seals one batch after another.
   */
  batches: readonly BatchProgress[];
  /** null = no batch filter; the grid shows every batch. */
  selected: number | null;
  onSelect: (batch: number | null) => void;
  /** Omit to render the list as progress + filter only, with no export affordance. */
  onDownload?: (batch: number) => void;
  /** The batch whose ZIP is being built right now — its button shows a spinner. */
  downloadingBatch?: number | null;
  /** Exports are serialised, so one running download disables the rest. */
  downloadDisabled?: boolean;
  /**
   * The cohort filling toward the next seal. Pass it for the WHOLE run, from zero — gating it on
   * `clean > 0` would have it appear a few seconds in and push every row under it down for no
   * reason the user can see.
   */
  filling?: FillingBatch | null;
  /** The unexported tail. Omit to leave the manual-export affordance out entirely. */
  tail?: TailCohort | null;
  /** Omit to show the tail as a count only, with no export button. */
  onExportTail?: () => void;
  /** Ships the clean cohort as its own batch — the idle filling row's action. */
  onExportClean?: () => void;
  exportingClean?: boolean;
  /** The tail's ZIP is being built right now. */
  exportingTail?: boolean;
  /**
   * A run is in flight, so the two live counts are still climbing. List-level rather than
   * per-cohort: one run feeds both, and two flags that could disagree would only ever be a bug.
   */
  running?: boolean;
  className?: string;
}

/** Six digits of queue is normal here, and 14000 vs 14,000 is a misread waiting to happen. */
const n = (value: number) => value.toLocaleString();

/**
 * Every row is one line: state icon, label, an inline progress track, the count, then the action
 * cell behind a hairline. One line rather than two because this list lives in the export footer,
 * where every extra row of chips pushed the Save/Export CTAs down — and the states the chips
 * carried ("ready", "downloaded", "out of date") fit an icon's colour plus a tooltip without
 * losing anything a glance actually needs.
 *
 * The track is what makes the single line scan: the label ellipses, the bar absorbs whatever
 * width is left, and the numbers sit tabular at a fixed right edge so rows compare down the
 * column. A sealed batch draws its bar full — constant, but that constancy is the signal, since
 * the one bar that is NOT full is the thing still moving.
 *
 * The hairline before the action cell is not decoration: the row and the button are two separate
 * targets doing very different things (narrow the grid / write a ZIP to disk), and the seam is
 * what says so before the click rather than after.
 *
 * has-[:focus-visible]: the container clips its children so the toggle's own ring is cut away
 * entirely — the row wears it instead, which is the only reason keyboard focus is visible here
 * at all.
 */
const ROW =
  'flex items-stretch overflow-hidden rounded-lg border transition-colors ' +
  'has-[:focus-visible]:border-ring has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50';

/** The content line of a row that is not selectable; the Toggle mirrors these below. */
const ROW_BODY = 'flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5';

/** The track eats the slack; min-w-6 keeps a sliver of bar alive under the longest labels. */
const ROW_TRACK = 'min-w-6 flex-1 gap-0';

/** Fixed and tabular so the numbers stack into a column the eye can compare down. */
const ROW_COUNT = 'shrink-0 text-xs text-muted-foreground tabular-nums';

export function BatchList({
  batches,
  selected,
  onSelect,
  onDownload,
  downloadingBatch = null,
  downloadDisabled,
  filling,
  tail,
  onExportTail,
  exportingTail,
  onExportClean,
  exportingClean,
  running,
  className,
}: BatchListProps) {
  // A 40-image queue never seals anything, and an empty "Batches" section under the export
  // controls would read as a feature that is broken rather than one that has not applied yet.
  if (batches.length === 0 && !filling && !tail) return null;

  return (
    // A group, not a list: only the sealed rows below are batches, and the list role sits on
    // exactly those. Announcing "3 items" over a set that also contains two cohorts which are
    // pointedly NOT batches would undo the distinction the dashed borders are drawing.
    <div role="group" aria-label="Batches" className={cn('flex flex-col gap-1.5', className)}>
      {/* Live rows first: the seal countdown is the only number in this section that moves on
          its own, so it sits where the eye lands rather than under a growing pile of history. */}
      {filling && (
        <FillingRow
          entry={filling}
          running={running}
          onExport={onExportClean}
          exporting={exportingClean}
        />
      )}

      {batches.length > 0 && (
        // Capped and scrolled INSIDE the section instead of growing it. 14,000 images seal 28
        // ZIPs; a 28-row section pushes the tail's Export button — the one control that ships
        // the images no batch will ever claim — off the bottom of the panel, and buries the
        // other export settings under it. With the cap, a seal grows this box and moves nothing
        // outside it, so the button under the pointer stays under the pointer.
        //
        // -mx-1/px-1 cancel out, leaving rows aligned with the ones outside the box while the
        // viewport clips 4px further out — enough that a focused row's ring is not sliced off.
        <ScrollArea className="-mx-1 max-h-60">
          {/* The list role belongs here rather than on the group above: ScrollArea's viewport
              sits between the two, and a listitem separated from its list by a generic element
              is not owned by it. */}
          <div role="list" className="flex flex-col gap-1.5 px-1">
            {batches.map((entry) => (
              <BatchRow
                key={entry.batch}
                entry={entry}
                selected={selected === entry.batch}
                onSelect={onSelect}
                onDownload={onDownload}
                downloading={downloadingBatch === entry.batch}
                downloadDisabled={downloadDisabled}
              />
            ))}
          </div>
        </ScrollArea>
      )}

      {tail && (
        <TailRow
          entry={tail}
          running={running}
          onExport={onExportTail}
          exporting={exportingTail}
          exportDisabled={downloadDisabled}
        />
      )}

      {selected !== null && (
        // The way out, and it has to exist independently of the rows. Pressing the selected row
        // again clears the filter, but the row is not guaranteed to be there to press: a reset
        // or a restore can leave `selected` pointing at a batch this list no longer draws, and
        // the filter it applies is on the CENTER grid, a panel away from the control that set
        // it. QueueFilters carries the same escape hatch for the same reason — a narrowed grid
        // must never outlive the only control that can widen it.
        <Button
          variant="ghost"
          size="xs"
          className="self-start text-muted-foreground"
          title="The results grid is showing one batch only. Clear the filter to see every image again."
          onClick={() => onSelect(null)}
        >
          <FilterXIcon data-icon="inline-start" />
          Show all batches
        </Button>
      )}
    </div>
  );
}

function BatchRow({
  entry,
  selected,
  onSelect,
  onDownload,
  downloading,
  downloadDisabled,
}: {
  entry: BatchProgress;
  selected: boolean;
  onSelect: (batch: number | null) => void;
  onDownload?: (batch: number) => void;
  downloading: boolean;
  downloadDisabled?: boolean;
}) {
  const { batch, done, total, errors = 0, running, downloaded, stale } = entry;
  const label = entry.label ?? `Batch ${batch}`;
  // Shipped members that are no longer in the queue — a deletion after the export. Worth stating
  // when someone counts the rows against the ZIP on disk, not worth a badge: the file still holds
  // them and their numbering slot stays reserved, so there is nothing to act on.
  const missing = running ? 0 : Math.max(0, total - done);
  const selectHint = selected
    ? `Showing only ${label} — press again to show every image.`
    : `Show only ${label} in the results grid.`;

  return (
    // border-ring alone for the selected row. The Toggle already tints its own half with the
    // suite's pressed fill, and anything heavier on a list this dense (a bar, a filled row) turns
    // "one row is selected" into "something is wrong with this row".
    <div role="listitem" className={cn(ROW, selected && 'border-ring')}>
      <Toggle
        size="sm"
        className="h-auto min-w-0 flex-1 items-center justify-start gap-2 rounded-none px-2.5 py-1.5"
        pressed={selected}
        // Pressing the selected row again clears the filter — with per-batch rows there is no
        // neutral member to fall back to, so the row has to be its own toggle.
        onPressedChange={(pressed) => onSelect(pressed ? batch : null)}
        // The words the old second-line chips carried live here now; the icon's colour is the
        // at-a-glance version. A tooltip is enough because none of these states needs acting on
        // from this row — the button beside it already changes shape for the one that does.
        title={
          (stale
            ? 'An image in this batch changed after its ZIP was built — the downloaded copy is out of date. '
            : errors > 0
              ? `${n(errors)} of its images failed. `
              : '') +
          (missing > 0
            ? `${n(missing)} of its ${n(total)} images have since been deleted from the queue; ` +
              'the ZIP on disk still contains them. '
            : '') +
          selectHint
        }
      >
        {running ? (
          <Spinner className="size-3.5 shrink-0 text-primary" />
        ) : (
          <CircleCheckIcon
            className={cn(
              'size-3.5 shrink-0',
              errors > 0 || stale ? 'text-amber-500' : downloaded ? 'text-primary' : 'text-muted-foreground',
            )}
          />
        )}
        {/* min-w-0 so `truncate` binds: a flex item's automatic minimum size is its content, and
            without the floor a long label pushes the bar and count out of the row instead of
            ellipsing. */}
        <span className="min-w-0 truncate text-[0.8rem] font-medium">{label}</span>
        <Progress
          className={ROW_TRACK}
          value={running ? done : total}
          max={total}
          aria-hidden
        />
        <span className={ROW_COUNT}>
          {running ? `${n(done)}/${n(total)}` : `${n(total)} file${total === 1 ? '' : 's'}`}
        </span>
      </Toggle>

      {onDownload && (
        // Outside the Toggle, not inside it: a button nested in a button is invalid HTML, and
        // Base UI merges props rather than rescuing the nesting.
        <div className="flex items-center border-l px-1">
          <Button
            variant="ghost"
            size="icon-sm"
            // Only a live run blocks the ZIP. Notably NOT gated on done === total: a shipped
            // batch missing a deleted member would otherwise lose its Download for good, and
            // re-downloading is exactly what someone does after an AI fix lands in it.
            disabled={running || downloading || downloadDisabled}
            title={
              running
                ? `${label} is still running — its ZIP can be built once every image has settled.`
                : stale
                  ? `${label} changed after it was downloaded — build the ZIP again to pick the new cutouts up.`
                  : downloaded
                    ? `Download ${label} again.`
                    : `Download ${label} as a ZIP.`
            }
            onClick={() => onDownload(batch)}
          >
            {downloading ? <Spinner /> : stale ? <RefreshCwIcon /> : <DownloadIcon />}
            <span className="sr-only">{stale ? `Re-download ${label}` : `Download ${label}`}</span>
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The cohort on its way to becoming the next batch.
 *
 * NOT selectable, and that is the decision rather than an omission. Two reasons, either alone
 * sufficient. Mechanically, selection here is a batch NUMBER and this cohort has none — making
 * it selectable means a sentinel in `onSelect`'s type that every call site has to spell out for
 * a filter that lasts minutes. Behaviourally it is worse: membership is recomputed from live
 * state, so tiles would come and go from under the user as verdicts land, and at the seal the
 * whole view would empty at once and start refilling from zero — the stranded-on-an-empty-grid
 * failure QueueFilters exists to prevent, arriving on a timer nobody pressed.
 *
 * A batch row appears the moment it seals, which is the point at which the set stops moving and
 * is worth filtering to.
 */
function FillingRow({
  entry,
  running,
  onExport,
  exporting,
}: {
  entry: FillingBatch;
  running?: boolean;
  onExport?: () => void;
  exporting?: boolean;
}) {
  const { clean, threshold, idle } = entry;
  const target = Math.max(1, threshold);
  // At rest these images are not "filling" anything — no further results are coming, so they are
  // a batch that simply has not been asked for yet, and the row says so and offers the ask.
  const ready = Boolean(idle) && clean > 0;

  return (
    // Dashed and muted: the outline of a batch rather than one, because it can be neither
    // downloaded nor filtered to and should not invite either.
    <div
      className={cn(ROW, 'border-dashed')}
      title={
        ready
          ? `${n(clean)} clean cutout${clean === 1 ? '' : 's'} that no batch has taken. Export ` +
            'them as their own ZIP so finished work stays separate from the flagged images ' +
            'still waiting on an AI fix.'
          : `${n(clean)} clean cutout${clean === 1 ? '' : 's'} of ${n(threshold)} are waiting to ` +
            `be exported. At ${n(threshold)} they become the next batch and get their own row — ` +
            'flagged images are held back for the Remaining export instead.'
      }
    >
      <div className={ROW_BODY}>
        {running ? (
          <Spinner className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <PackagePlusIcon
            className={cn('size-3.5 shrink-0', ready ? 'text-primary' : 'text-muted-foreground')}
          />
        )}
        <span
          className={cn(
            'min-w-0 truncate text-[0.8rem] font-medium',
            ready ? undefined : 'text-muted-foreground',
          )}
        >
          {ready ? 'Clean · not batched' : 'Filling'}
        </span>
        {/* The bar is a progress reading toward a seal; once nothing more is coming it measures
            nothing, and a part-full track beside an export button reads as "not ready yet". */}
        {!ready && (
          <Progress
            className={ROW_TRACK}
            // Clamped because results land in bursts: several can settle between the count
            // crossing the threshold and the seal committing, and a value past max draws an
            // indicator wider than its own track.
            value={Math.min(clean, target)}
            max={target}
            aria-label={`${n(clean)} of ${n(threshold)} clean images toward the next batch`}
          />
        )}
        <span className={cn(ROW_COUNT, ready && 'ml-auto')}>
          {ready ? n(clean) : `${n(clean)}/${n(threshold)} clean`}
        </span>
      </div>
      {ready && onExport && (
        <>
          <div className="w-px shrink-0 bg-border" aria-hidden />
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-auto shrink-0 rounded-none px-2.5"
            onClick={onExport}
            disabled={exporting}
            title={`Export these ${n(clean)} clean images as their own batch`}
          >
            {exporting ? <Spinner /> : <DownloadIcon />}
            <span className="sr-only">Export {n(clean)} clean images as a batch</span>
          </Button>
        </>
      )}
    </div>
  );
}

/**
 * The leftovers, and the button that ships them.
 *
 * Unselectable for the same reasons as FillingRow — no batch number, live membership — with one
 * extra: this cohort is defined so that it always contains the filling one, and a filter showing
 * both under a single heading would suggest the two rows describe disjoint piles of work.
 */
function TailRow({
  entry,
  running,
  onExport,
  exporting,
  exportDisabled,
}: {
  entry: TailCohort;
  running?: boolean;
  onExport?: () => void;
  exporting?: boolean;
  exportDisabled?: boolean;
}) {
  const { count, flagged = 0 } = entry;
  // "Not yet exported" rather than "Remaining", because the number below it is a flagged count
  // and the toolbar has one too — over the WHOLE queue, including images that already shipped.
  // Two flagged numbers that disagree by design need the smaller one to say out loud which set
  // it is counting; "Remaining" left that to the reader and lost.
  const label = entry.label ?? 'Not yet exported';

  return (
    <div className={cn(ROW, 'border-dashed')}>
      <div
        className={ROW_BODY}
        title={
          `${n(count)} finished image${count === 1 ? '' : 's'} have a cutout that no ZIP has ` +
          'claimed yet — flagged or not, and including the clean ones still filling the next ' +
          "batch. The toolbar's Flagged count measures the whole queue instead, so the two " +
          'numbers are not the same thing.'
        }
      >
        <InboxIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-[0.8rem] font-medium">{label}</span>
        {/* Inline amber text rather than a badge on its own line: the flagged share is the
            reason this cohort exists, but it is context, not a state to act on from here. The
            count keeps the right edge so the column of numbers stays a column. */}
        {flagged > 0 && (
          <span className="shrink-0 text-xs text-amber-500 tabular-nums">
            {n(flagged)} flagged
          </span>
        )}
        <span className={cn(ROW_COUNT, 'ml-auto')}>{n(count)}</span>
      </div>

      {onExport && (
        <div className="flex items-center border-l px-1">
          <Button
            variant="ghost"
            size="icon-sm"
            // Enabled during a run on purpose. The count is not final then — the tooltip says
            // so — but the alternative is a button that only works once inference has stopped,
            // and abandoning a run to ship what already came out is a legitimate thing to want
            // on a queue this size.
            disabled={count === 0 || exporting || exportDisabled}
            title={
              count === 0
                ? 'Nothing is waiting — every finished image is already in a batch.'
                : `Export the ${n(count)} finished image${count === 1 ? '' : 's'} no batch has ` +
                  'claimed yet — flagged or not, and including the clean ones still filling the ' +
                  'next batch. File numbering carries on from the last batch, so every ZIP can ' +
                  'be unpacked into one folder.' +
                  (running
                    ? ' The run is still going, so whatever finishes after this will not be in it.'
                    : '')
            }
            onClick={onExport}
          >
            {exporting ? <Spinner /> : <DownloadIcon />}
            <span className="sr-only">{`Export ${label}`}</span>
          </Button>
        </div>
      )}
    </div>
  );
}
