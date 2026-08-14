'use client';

// The results grid's view controls: which tiles the grid shows (quality/AI/error) and in what
// order (queue vs worst-first). Purely presentational — counts, the active filter and the sort
// all arrive as props, because the numbers behind them are memoised once per queue change on the
// page and must not be recomputed per render here.
//
// Two labelled selects rather than a rail of toggles. Filter and sort are different questions,
// and a row of identically-shaped pills answers neither — side by side, only the label told you
// which of them changed the grid's contents and which changed its order. A select names its own
// question on its face, and keeps its options out of the layout until they are asked for: one
// row, whatever the vocabulary grows to, above a grid that runs to five figures.

import {
  CircleAlertIcon, LayersIcon, OctagonAlertIcon, SparklesIcon, TriangleAlertIcon,
  type LucideIcon,
} from 'lucide-react';

import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  QUEUE_FILTERS,
  type QueueFilter,
  type QueueFilterCounts,
  type QueueSort,
} from '@/lib/bg/quality';

/** A CSV import puts five digits in here, and `14105` is not a number anyone reads at a glance. */
const formatCount = (count: number) => count.toLocaleString();

interface FilterMeta {
  label: string;
  icon: LucideIcon;
  /** Tone carried by the icon only — a fully coloured row reads as the item's own state
   *  (disabled, destructive) rather than as the severity of the images it counts. */
  iconClassName?: string;
  /** `title` rather than a Tooltip: these live inside a Base UI composite, and wrapping each
   *  item in a trigger puts a second props-merging layer between the list and its roving
   *  focus. The existing model/redo controls label themselves the same way. */
  hint: string;
}

const FILTER_META: Record<QueueFilter, FilterMeta> = {
  'all': {
    label: 'All',
    icon: LayersIcon,
    hint: 'Every image in the queue, however it arrived and whatever state it is in.',
  },
  'flagged': {
    label: 'Flagged',
    icon: CircleAlertIcon,
    iconClassName: 'text-amber-500',
    hint: 'Cutouts the quality check wants a second look at, at any severity. Includes images restored from a saved project, which the AI fix cannot re-run — so this count can sit above the one on the AI-fix button.',
  },
  'flagged-severe': {
    label: 'Severe',
    icon: OctagonAlertIcon,
    iconClassName: 'text-destructive',
    hint: 'The worst tier only: no subject was detected at all, so the matte came back empty.',
  },
  'ai': {
    label: 'AI-generated',
    icon: SparklesIcon,
    iconClassName: 'text-primary',
    hint: 'Images whose source was replaced by an AI edit — the pixels came from Azure, not from your original file.',
  },
  'errored': {
    label: 'Errors',
    icon: TriangleAlertIcon,
    iconClassName: 'text-destructive',
    hint: 'Images whose run failed. Kept separate from the quality flags: a failed image has no cutout to assess.',
  },
};

/** Menu order stated here rather than left to `Object.keys(SORT_META)`: the two options read as a
 *  scale — the order the images arrived in, then the order that puts the damage first. */
const SORT_ORDER: readonly QueueSort[] = ['queue', 'quality'];

const SORT_META: Record<QueueSort, { label: string; hint: string }> = {
  'queue': {
    label: 'Queue order',
    hint: 'The order images were added — CSV row order for an import.',
  },
  'quality': {
    // Deliberately not "Flagged", and deliberately without the amber alert glyph the flagged
    // filter carries: one control to the left is a filter of that name, and a matching label or
    // icon here reads as a second way to press the same thing.
    label: 'Worst first',
    hint: 'Worst verdict first — severe, then flagged, then everything else. Ties keep queue order.',
  },
};

export interface QueueFiltersProps {
  filter: QueueFilter;
  onFilterChange: (filter: QueueFilter) => void;
  /** Per-filter totals over the WHOLE queue, from countQueueFilters(). */
  counts: QueueFilterCounts;
  sort: QueueSort;
  onSortChange: (sort: QueueSort) => void;
  /**
   * Gates the sort select only. The filter is never disabled by it: watching just the flagged
   * tiles land is the point of running a large batch, and locking the view during the one
   * operation that populates it would be backwards.
   */
  disabled?: boolean;
  className?: string;
}

/**
 * Mount this whenever the queue is non-empty and keep it mounted. It must NEVER be conditioned on
 * a count: the toolbar it replaces was rendered behind `flaggedCount > 0`, so fixing the last
 * flagged image while the flagged view was active took away the grid's contents AND the only
 * control that could restore them — an empty screen with no way out but a reload.
 *
 * The trigger is what discharges that now. It is always mounted and always reachable whatever the
 * counts do, so "All" is one click away from every state, and it keeps the active filter's count
 * on its face so a grid that just emptied says why it did without needing a row of its own.
 */
export function QueueFilters({
  filter,
  onFilterChange,
  counts,
  sort,
  onSortChange,
  disabled,
  className,
}: QueueFiltersProps) {
  const active = FILTER_META[filter];
  const ActiveIcon = active.icon;

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <Select
        value={filter}
        onValueChange={(value) => {
          // Base UI hands back null when a selection is cleared. Held rather than applied: there
          // is no "no filter" state — 'all' is it, and it has its own item.
          if (value) onFilterChange(value);
        }}
      >
        <SelectTrigger
          size="sm"
          // Fixed width, with the count pinned to its right edge rather than trailing the label.
          // The number climbs for the whole of a run, and a trigger sized to its content would
          // step the sort control sideways every time it crossed a power of ten — under a pointer
          // already on its way there.
          className="w-64"
          title={active.hint}
        >
          <span className="shrink-0 text-xs text-muted-foreground">Show</span>
          {/* The row lives in a span of its own rather than on SelectValue: the trigger styles
              that slot with both `flex` and `line-clamp-1`, whose displays compete, and this
              layout must not depend on which of them lands last. */}
          <SelectValue>
            <span className="flex w-full min-w-0 items-center gap-1.5">
              <ActiveIcon className={active.iconClassName} />
              <span className="min-w-0 truncate">{active.label}</span>
              {/* 'All' carries no number: the count line beside this control already states the
                  queue total. A narrowed view carries its own, because that is the moment the
                  grid stops matching that line and the user has to be told how much they hid.
                  It is this filter's count over the WHOLE queue — the same number as its menu
                  row — and a batch filter can narrow the grid further, so the count line, not
                  this, remains the authority on how many tiles are actually on screen. */}
              {filter !== 'all' && (
                <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                  {formatCount(counts[filter])}
                </span>
              )}
            </span>
          </SelectValue>
        </SelectTrigger>

        <SelectContent>
          {QUEUE_FILTERS.map((value) => {
            const { label, icon: Icon, iconClassName, hint } = FILTER_META[value];
            const count = counts[value];
            return (
              <SelectItem
                key={value}
                value={value}
                // The active option is never disabled, even at zero — it is the thing the user is
                // standing on and has to be able to see and leave. Empty options they are NOT
                // standing on go inert, so the menu cannot walk anyone onto a blank grid.
                disabled={count === 0 && value !== filter}
                title={hint}
                // Without it the trailing number is read as a second, nameless label.
                aria-label={`${label}, ${formatCount(count)} image${count === 1 ? '' : 's'}`}
              >
                {/* Tinted on every row, not just the active one: five of them read top to bottom
                    as a legend for the marks the grid puts on the tiles themselves — the same
                    amber, the same destructive red. */}
                <Icon className={iconClassName} />
                <span className="min-w-0 truncate">{label}</span>
                {/* Right-aligned so the five numbers stack into a column that can be compared
                    down the menu instead of hunted for after each label. */}
                <span className="ml-auto shrink-0 pl-3 text-muted-foreground tabular-nums">
                  {formatCount(count)}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>

      <Select
        value={sort}
        onValueChange={(value) => {
          if (value) onSortChange(value);
        }}
        disabled={disabled}
      >
        <SelectTrigger size="sm" className="w-44" title={SORT_META[sort].hint}>
          <span className="shrink-0 text-xs text-muted-foreground">Sort</span>
          <SelectValue>{SORT_META[sort].label}</SelectValue>
        </SelectTrigger>

        <SelectContent>
          {SORT_ORDER.map((value) => (
            <SelectItem key={value} value={value} title={SORT_META[value].hint}>
              {SORT_META[value].label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
