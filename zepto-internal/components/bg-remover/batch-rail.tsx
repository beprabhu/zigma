'use client';

// One chip per batch of a large CSV import: progress, a spinner while it runs, its own Download
// once it finishes, and click-to-filter so the grid can be narrowed to a single batch.
//
// A batch is born when its images are EXPORTED, so the rail also carries two cohorts that are
// not batches yet, drawn so they cannot be taken for one — dashed, unnumbered, unselectable:
//
//   Filling    the clean cutouts piling up toward the next automatic seal. It has no number
//              because nothing has stamped BgItem.batch for it yet, and no ZIP because the run
//              has not sealed it.
//   Remaining  everything with a cutout that no batch has claimed — flagged or not — which is
//              the cohort the user exports by hand once the AI fixes have landed. Its export is
//              what guarantees the ZIPs add up to the whole queue.
//
// The rail sits ABOVE the results grid as a sibling element, and nothing here may ever become a
// grid row. VirtualGrid computes its window from one uniform row height (cellHeight takes a
// width, not an item, for exactly that reason) — a batch header interleaved between rows would
// desynchronise every scroll offset after it, on the queues large enough to need batching in
// the first place.
//
// Purely presentational: it is handed a progress snapshot per batch and reports clicks back.

import {
  CircleCheckIcon, DownloadIcon, InboxIcon, LayersIcon, PackagePlusIcon, RefreshCwIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { Toggle } from '@/components/ui/toggle';
import { cn } from '@/lib/utils';

export interface BatchProgress {
  /** The value stored on BgItem.batch. Also the chip's identity and selection value. */
  batch: number;
  /** Defaults to "Batch {n}". */
  label?: string;
  /** Items that have settled — finished or failed. */
  done: number;
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
  /** Defaults to "Remaining". */
  label?: string;
}

export interface BatchRailProps {
  /**
   * Ascending by batch number, and it has to stay that way: a newly sealed batch is then always
   * an append, which is what lets every chip already on screen keep its position while a run
   * seals one batch after another.
   */
  batches: readonly BatchProgress[];
  /** null = no batch filter; the grid shows every batch. */
  selected: number | null;
  onSelect: (batch: number | null) => void;
  /** Omit to render the rail as progress + filter only, with no export affordance. */
  onDownload?: (batch: number) => void;
  /** The batch whose ZIP is being built right now — its button shows a spinner. */
  downloadingBatch?: number | null;
  /** Exports are serialised, so one running download disables the rest. */
  downloadDisabled?: boolean;
  /**
   * The cohort filling toward the next seal. Pass it for the WHOLE run, from zero — gating it on
   * `clean > 0` would have it appear a few seconds in and push the chips after it sideways for
   * no reason the user can see.
   */
  filling?: FillingBatch | null;
  /** The unexported tail. Omit to leave the manual-export affordance out entirely. */
  tail?: TailCohort | null;
  /** Omit to show the tail as a count only, with no export button. */
  onExportTail?: () => void;
  /** The tail's ZIP is being built right now. */
  exportingTail?: boolean;
  /**
   * A run is in flight, so the two live counts are still climbing. Rail-level rather than
   * per-cohort: one run feeds both, and two flags that could disagree would only ever be a bug.
   */
  running?: boolean;
  className?: string;
}

export function BatchRail({
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
  running,
  className,
}: BatchRailProps) {
  if (batches.length === 0 && !filling && !tail) return null;

  return (
    // Chips keep their intrinsic width and the rail scrolls: a 3,000-row CSV is six chips at the
    // default batch size, but the size is a setting and wrapping them into a second row would
    // push the grid down the page every time one appeared.
    //
    // Order is what keeps the rail still while a run seals batch after batch. Every chip is a
    // FIXED width, so a growing count never resizes one; sealed chips are appended in ascending
    // order, so a new one lands after the last of them and moves nothing already on screen; and
    // the only two chips a seal can push sideways are the two at the end — Filling, which has
    // nothing to click, and Remaining, which is pinned (see below). Nothing carrying a button
    // ever moves under the pointer.
    <div
      role="group"
      aria-label="Batches"
      className={cn('mb-3 flex items-stretch gap-2 overflow-x-auto pb-1', className)}
    >
      {/* Present from the first render, including while the only chips are the two live cohorts
          and this one can do nothing. QueueFilters states the rule and the bug behind it: a
          control that arrives with a count leaves with one, and the way out of a filter has to
          outlive whatever emptied the grid. */}
      <Toggle
        size="sm"
        variant="outline"
        className="shrink-0 self-center"
        pressed={selected === null}
        // Always lands on null rather than toggling: this chip is the way out of a batch filter,
        // so pressing it must never be a no-op that leaves the grid narrowed.
        onPressedChange={() => onSelect(null)}
        title="Show every batch in the grid."
      >
        <LayersIcon data-icon="inline-start" />
        All batches
      </Toggle>

      {batches.map((entry) => (
        <BatchChip
          key={entry.batch}
          entry={entry}
          selected={selected === entry.batch}
          onSelect={onSelect}
          onDownload={onDownload}
          downloading={downloadingBatch === entry.batch}
          downloadDisabled={downloadDisabled}
        />
      ))}

      {filling && <FillingChip entry={filling} running={running} />}

      {tail && (
        <TailChip
          entry={tail}
          running={running}
          onExport={onExportTail}
          exporting={exportingTail}
          exportDisabled={downloadDisabled}
        />
      )}
    </div>
  );
}

function BatchChip({
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
  const complete = total > 0 && done >= total;

  return (
    // The chip is a container, not a button: a Download nested inside a selectable button would
    // be a button inside a button. Its parts share one border instead, so it still reads as one
    // object. The progress bar is a sibling of the toggle rather than a child because Progress
    // renders a <div>, which is not valid content for a <button>.
    //
    // Fixed width, so a rail of chips is a comparable row of bars rather than a ragged one that
    // reflows as labels and badges come and go mid-run.
    <div
      className={cn(
        'flex w-48 shrink-0 flex-col overflow-hidden rounded-lg border transition-colors',
        selected && 'border-ring',
      )}
    >
      <div className="flex items-stretch">
        <Toggle
          size="sm"
          className="h-auto min-w-0 flex-1 flex-col items-stretch justify-start gap-1 rounded-none px-2.5 py-1.5"
          pressed={selected}
          // Pressing the selected chip again clears the filter — with per-batch chips there is
          // no neutral member to fall back to, so the chip has to be its own toggle.
          onPressedChange={(pressed) => onSelect(pressed ? batch : null)}
          title={
            selected
              ? `Showing only ${label} — press again to show every batch.`
              : `Show only ${label} in the grid.`
          }
        >
          {/* min-w-0 twice over: a flex item's automatic minimum size is its content, so
              without it the label's `truncate` never binds and a long custom label widens the
              chip past the fixed rail width instead of ellipsing. */}
          <span className="flex min-w-0 items-center gap-1.5">
            {running ? (
              <Spinner className="size-3.5 text-primary" />
            ) : complete ? (
              <CircleCheckIcon
                className={cn('size-3.5', errors > 0 ? 'text-amber-500' : 'text-primary')}
              />
            ) : null}
            <span className="min-w-0 truncate text-[0.8rem] font-medium">{label}</span>
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {done}/{total}
            </span>
          </span>

          {(errors > 0 || stale || downloaded) && (
            <span className="flex flex-wrap items-center gap-1">
              {errors > 0 && <Badge variant="chip-warn">{errors} failed</Badge>}
              {/* Surfaced, not hidden: the ZIP already on disk no longer matches this batch —
                  an AI fix landing in a finished batch is routine — and the only person who can
                  judge whether that matters is the one looking at this chip. */}
              {stale ? (
                <Badge
                  variant="chip-warn"
                  title="An image in this batch changed after the ZIP was built, so the downloaded copy is out of date."
                >
                  ZIP out of date
                </Badge>
              ) : downloaded ? (
                <Badge variant="chip">downloaded</Badge>
              ) : null}
            </span>
          )}
        </Toggle>

        {onDownload && (
          <div className="flex items-center border-l px-1">
            <Button
              variant="ghost"
              size="icon-sm"
              // Rendered from the start and disabled until the batch settles, rather than
              // appearing on completion: chips finish one at a time and a button materialising
              // mid-run would reflow the rail under the pointer.
              disabled={!complete || downloading || downloadDisabled}
              title={
                !complete
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
              <span className="sr-only">
                {stale ? `Re-download ${label}` : `Download ${label}`}
              </span>
            </Button>
          </div>
        )}
      </div>

      <Progress
        className="mt-auto gap-0"
        value={done}
        // Progress.Root treats a zero range as unusable, so an empty batch draws as complete
        // rather than as a broken bar.
        max={Math.max(1, total)}
        aria-label={`${label} progress`}
      />
    </div>
  );
}

/**
 * The cohort on its way to becoming the next batch.
 *
 * NOT selectable, and that is the decision rather than an omission. Two reasons, either alone
 * sufficient. Mechanically, the rail's selection is a batch NUMBER and this cohort has none —
 * making it selectable means a sentinel in `onSelect`'s type that every call site has to spell
 * out for a filter that lasts minutes. Behaviourally it is worse: membership here is recomputed
 * from live state, so tiles would come and go from under the user as verdicts land, and at the
 * seal the whole view would empty at once and start refilling from zero — the stranded-on-an-
 * empty-grid failure QueueFilters exists to prevent, arriving on a timer nobody pressed.
 *
 * A batch chip appears the moment it seals, which is the point at which the set stops moving
 * and is worth filtering to.
 */
function FillingChip({ entry, running }: { entry: FillingBatch; running?: boolean }) {
  const { clean, threshold } = entry;
  const target = Math.max(1, threshold);

  return (
    // Dashed and muted: it looks like the outline of a batch rather than one, because it cannot
    // be downloaded or filtered to and should not invite either. Same fixed width as a sealed
    // chip, so the count climbing from 99 to 100 moves nothing outside this box.
    <div
      className="flex w-48 shrink-0 flex-col overflow-hidden rounded-lg border border-dashed"
      title={
        `${clean} clean cutout${clean === 1 ? '' : 's'} of ${threshold} are waiting to be exported. ` +
        `At ${threshold} they become the next batch and get their own chip — flagged images are ` +
        `held back for the Remaining export instead.`
      }
    >
      <div className="flex min-w-0 items-center gap-1.5 px-2.5 py-1.5">
        {running ? (
          <Spinner className="size-3.5 text-muted-foreground" />
        ) : (
          <PackagePlusIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 truncate text-[0.8rem] font-medium text-muted-foreground">
          Filling
        </span>
        {/* "clean" is carried in the visible text rather than left to the tooltip: this number
            counts a narrower set than every other number in the rail, and a bare count sitting
            beside batches that show done/total would read as the same measurement. */}
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{clean} clean</span>
      </div>

      <Progress
        className="mt-auto gap-0"
        // Clamped because results land in bursts: several can settle between the count crossing
        // the threshold and the seal committing, and a value past max draws an indicator wider
        // than its own track.
        value={Math.min(clean, target)}
        max={target}
        aria-label={`${clean} of ${threshold} clean images toward the next batch`}
      />
    </div>
  );
}

/**
 * The leftovers, and the button that ships them.
 *
 * Unselectable for the same reasons as FillingChip — no batch number, live membership — with one
 * extra: this cohort is defined so that it always contains the filling one, and a filter showing
 * both under a single heading would suggest the two chips describe disjoint piles of work.
 */
function TailChip({
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
  const label = entry.label ?? 'Remaining';

  return (
    // Pinned to the right edge, by both mechanisms it takes to stay there: ml-auto holds it
    // against the end while the rail still fits, and sticky takes over once it overflows and
    // auto margins have no free space left to resolve to. Every seal inserts a chip ahead of
    // this one, and an export button that jumps a chip's width each time a batch completes is
    // the reflow-under-the-pointer failure the rail is built to avoid — here it would land on
    // the one button that ships the images nothing else will.
    //
    // The wrapper carries the background so sealed chips scroll UNDER this one rather than
    // through it, and its left padding is the gutter that keeps the seam legible.
    <div className="sticky right-0 ml-auto flex shrink-0 items-stretch bg-background pl-2">
      <div className="flex w-48 flex-col overflow-hidden rounded-lg border border-dashed">
        <div className="flex flex-1 items-stretch">
          <div className="flex min-w-0 flex-1 flex-col gap-1 px-2.5 py-1.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <InboxIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate text-[0.8rem] font-medium">{label}</span>
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">{count}</span>
            </span>

            {flagged > 0 && (
              <span className="flex flex-wrap items-center gap-1">
                {/* Why anything is left at all. Without it a tail of 50 beside batches of 500
                    reads as a run that stopped early rather than as the images held back. */}
                <Badge variant="chip-warn">{flagged} flagged</Badge>
              </span>
            )}
          </div>

          {onExport && (
            <div className="flex items-center border-l px-1">
              <Button
                variant="ghost"
                size="icon-sm"
                // Enabled during a run on purpose. The count is not final then — the tooltip
                // says so — but the alternative is a button that only works once inference has
                // stopped, and abandoning a run to ship what already came out is a legitimate
                // thing to want on a queue this size.
                disabled={count === 0 || exporting || exportDisabled}
                title={
                  count === 0
                    ? 'Nothing is waiting — every finished image is already in a batch.'
                    : `Export the ${count} finished image${count === 1 ? '' : 's'} no batch ` +
                      'has claimed yet — flagged or not, and including the clean ones still ' +
                      'filling the next batch. File numbering carries on from the last batch, ' +
                      'so every ZIP can be unpacked into one folder.' +
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
      </div>
    </div>
  );
}
