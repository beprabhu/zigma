'use client';

// The results grid's view controls: which tiles the grid shows (quality/AI/error chips) and in
// what order (queue vs worst-first). Purely presentational — counts, the active filter and the
// sort all arrive as props, because the numbers behind them are memoised once per queue change
// on the page and must not be recomputed per render here.

import * as React from 'react';
import {
  CircleAlertIcon, FilterXIcon, LayersIcon, OctagonAlertIcon, SparklesIcon, TriangleAlertIcon,
  type LucideIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import {
  QUEUE_FILTERS,
  type QueueFilter,
  type QueueFilterCounts,
  type QueueSort,
} from '@/lib/bg/quality';

interface FilterMeta {
  label: string;
  icon: LucideIcon;
  /** Tone carried by the icon only — a fully coloured chip competes with its pressed state. */
  iconClassName?: string;
  /** `title` rather than a Tooltip: these live inside a Base UI composite, and wrapping each
   *  item in a trigger puts a second props-merging layer between the group and its roving
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

export interface QueueFiltersProps {
  filter: QueueFilter;
  onFilterChange: (filter: QueueFilter) => void;
  /** Per-chip totals over the WHOLE queue, from countQueueFilters(). */
  counts: QueueFilterCounts;
  sort: QueueSort;
  onSortChange: (sort: QueueSort) => void;
  /**
   * Tiles actually on screen. Defaults to the active chip's count; pass it explicitly when
   * another control (the batch rail) narrows the grid further, so the escape hatch below fires
   * on the real result and not on this strip's share of it.
   */
  visible?: number;
  /**
   * Gates the sort switch only. The filter chips are never disabled by it: watching just the
   * flagged tiles land is the point of running a large batch, and locking the view during the
   * one operation that populates it would be backwards.
   */
  disabled?: boolean;
  /**
   * Trailing slot, left of the sort switch — where the page hangs "AI-fix flagged" and its Auto
   * switch. Those act on the queue rather than describing it, so they stay owned by the page.
   */
  actions?: React.ReactNode;
  className?: string;
}

/**
 * Mount this whenever the queue is non-empty and keep it mounted. It must NEVER be conditioned
 * on a count: the toolbar it replaces was rendered behind `flaggedCount > 0`, so fixing the last
 * flagged image while the flagged view was active took away the grid's contents AND the only
 * control that could restore them — an empty screen with no way out but a reload.
 */
export function QueueFilters({
  filter,
  onFilterChange,
  counts,
  sort,
  onSortChange,
  visible,
  disabled,
  actions,
  className,
}: QueueFiltersProps) {
  const shown = visible ?? counts[filter];
  const stranded = filter !== 'all' && shown === 0;

  return (
    <div className={cn('mb-3 flex flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          size="sm"
          variant="outline"
          value={[filter]}
          // An empty array means the pressed chip was pressed again. Held rather than cleared:
          // there is no "no filter" state — 'all' is it, and it has its own chip.
          onValueChange={(next) => next[0] && onFilterChange(next[0] as QueueFilter)}
          aria-label="Filter the results grid"
        >
          {QUEUE_FILTERS.map((value) => {
            const { label, icon: Icon, iconClassName, hint } = FILTER_META[value];
            const count = counts[value];
            const active = value === filter;
            return (
              <ToggleGroupItem
                key={value}
                value={value}
                // The active chip is never disabled, even at zero — it is the thing the user is
                // standing on and has to be able to leave. Empty chips they are NOT standing on
                // are dead ends, so those go inert instead of navigating to a blank grid.
                disabled={count === 0 && !active}
                title={hint}
                aria-label={`${label}, ${count} image${count === 1 ? '' : 's'}`}
              >
                <Icon data-icon="inline-start" className={active ? iconClassName : undefined} />
                {label}
                <span className="text-muted-foreground tabular-nums">{count}</span>
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>

        {actions && (
          <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>
        )}

        <ToggleGroup
          size="sm"
          variant="outline"
          className={cn(!actions && 'ml-auto')}
          value={[sort]}
          onValueChange={(next) => next[0] && onSortChange(next[0] as QueueSort)}
          disabled={disabled}
          aria-label="Sort the results grid"
        >
          <ToggleGroupItem
            value="queue"
            title="The order images were added — CSV row order for an import."
          >
            Queue order
          </ToggleGroupItem>
          <ToggleGroupItem
            value="quality"
            // Deliberately not "Flagged": a sort labelled the same as a filter chip beside it
            // reads as a second way to press the same thing.
            title="Worst verdict first — severe, then flagged, then everything else. Ties keep queue order."
          >
            <CircleAlertIcon data-icon="inline-start" />
            Worst first
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {stranded && (
        // The chips above already offer the way out; this states WHY the grid is blank before
        // the caller's empty state can be misread as "the queue is gone".
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-2.5 py-1.5 text-xs text-muted-foreground">
          <FilterXIcon className="size-3.5 shrink-0" />
          <span className="min-w-0">
            No images match {FILTER_META[filter].label} right now — {counts.all} still queued.
          </span>
          <Button variant="ghost" size="xs" className="ml-auto" onClick={() => onFilterChange('all')}>
            Show all
          </Button>
        </div>
      )}
    </div>
  );
}
