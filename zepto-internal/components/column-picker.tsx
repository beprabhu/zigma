'use client';

// Picking CSV columns, everywhere the suite does it: which columns ride along with a prompt
// (Generate, Cleanup) and which ones hold image URLs (Cleanup).
//
// It replaces a column of checkboxes rendered upfront. That list was honest but unbounded — a
// 30-column sheet pushed every control below it off the panel, and with no search the only way
// to find `pack_size` was to read all thirty labels. A combobox costs one click to open, keeps
// the panel a fixed height whatever the CSV looks like, and the chips under the trigger still
// answer "what is being sent?" without opening anything.

import * as React from 'react';
import { CheckIcon, ChevronsUpDownIcon, XIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface ColumnPickerProps {
  /** Every column, in CSV order — the order selections are reported back in. */
  columns: string[];
  selected: string[];
  /** Always ordered by `columns`, so a prompt never depends on click order. */
  onChange: (next: string[]) => void;
  id?: string;
  disabled?: boolean;
  /** Trigger text when nothing is picked. */
  placeholder?: string;
  /** Noun for the summary line: "3 of 12 columns". */
  noun?: string;
  className?: string;
}

export function ColumnPicker({
  columns,
  selected,
  onChange,
  id,
  disabled,
  placeholder = 'None',
  noun = 'columns',
  className,
}: ColumnPickerProps) {
  const [open, setOpen] = React.useState(false);
  const selectedSet = React.useMemo(() => new Set(selected), [selected]);
  // Rebuilt from `columns` on every change: click order is irrelevant to a prompt, and a stable
  // order is what makes two rows of the same sheet produce comparably-ordered prompts.
  const commit = (next: Set<string>) => onChange(columns.filter((column) => next.has(column)));

  function toggle(column: string) {
    const next = new Set(selectedSet);
    if (!next.delete(column)) next.add(column);
    commit(next);
  }

  // Names while they still fit, a count once they don't — "8 of 12 columns" stays readable
  // where eight truncated chips in a 320px panel do not.
  const label =
    selected.length === 0
      ? placeholder
      : selected.length === columns.length
        ? `All ${columns.length} ${noun}`
        : selected.length <= 2
          ? selected.join(', ')
          : `${selected.length} of ${columns.length} ${noun}`;

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              id={id}
              type="button"
              variant="outline"
              disabled={disabled}
              className="w-full justify-between font-normal"
            />
          }
        >
          <span className={cn('truncate', selected.length === 0 && 'text-muted-foreground')}>
            {label}
          </span>
          <ChevronsUpDownIcon data-icon="inline-end" className="opacity-50" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-(--anchor-width) p-0">
          {/* The list owns the check mark rather than CommandItem's built-in one: this is a
              multi-select, so an unpicked row has to keep the space a picked one uses, or the
              labels shift sideways as you tick through them. */}
          <Command>
            <CommandInput placeholder={`Search ${noun}…`} />
            <CommandList>
              <CommandEmpty>No column matches.</CommandEmpty>
              <CommandGroup>
                {columns.map((column) => (
                  <CommandItem
                    key={column}
                    value={column}
                    // Selecting keeps the popover open — picking three columns should cost three
                    // clicks, not three open-pick-reopen rounds.
                    onSelect={() => toggle(column)}
                    className="[&>svg:last-child]:hidden"
                  >
                    <CheckIcon
                      className={cn('shrink-0', selectedSet.has(column) ? 'opacity-100' : 'opacity-0')}
                    />
                    <span className="truncate">{column}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
          {columns.length > 1 && (
            <div className="flex items-center justify-between border-t p-1">
              <Button
                size="xs"
                variant="ghost"
                onClick={() => commit(new Set(columns))}
                disabled={selected.length === columns.length}
              >
                Select all
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => commit(new Set())}
                disabled={selected.length === 0}
              >
                Clear
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
      {selected.length > 0 && (
        // The chips are the answer to "what is actually being sent?" — the one question the
        // old checkbox list answered for free and a closed combobox otherwise hides.
        <div className="flex flex-wrap gap-1">
          {selected.map((column) => (
            <Badge key={column} variant="chip" className="max-w-full gap-0.5 pr-0.5">
              <span className="truncate">{column}</span>
              <Button
                size="icon-xs"
                variant="ghost"
                disabled={disabled}
                aria-label={`Remove ${column}`}
                className="size-4 rounded-sm"
                onClick={() => toggle(column)}
              >
                <XIcon className="size-3" />
              </Button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
