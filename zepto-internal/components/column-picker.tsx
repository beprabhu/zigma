'use client';

// Picking CSV columns, everywhere the suite does it: which columns ride along with a prompt
// (Generate, Cleanup) and which ones hold image URLs (Cleanup, Compose).
//
// It replaces a column of checkboxes rendered upfront. That list was honest but unbounded — a
// 30-column sheet pushed every control below it off the panel, and with no search the only way
// to find `pack_size` was to read all thirty labels. A combobox costs one click to open, keeps
// the panel a fixed height whatever the CSV looks like, and the chips still answer "what is
// being sent?" without opening anything.
//
// Built on @shadcn/combobox (Base UI), not the older Popover+Command recipe: multi-select with
// removable chips IS the primitive's ComboboxChips/Chip/ChipRemove, and filtering comes from
// Base UI's Intl.Collator matching rather than cmdk's fuzzy scoring — which used to rank
// `shelf-composite` as a match for "select".

import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Combobox, ComboboxChip, ComboboxChips, ComboboxChipsInput, ComboboxContent, ComboboxEmpty,
  ComboboxItem, ComboboxList, ComboboxValue, useComboboxAnchor,
} from '@/components/ui/combobox';
import { cn } from '@/lib/utils';

export interface ColumnPickerProps {
  /** Every column, in CSV order — the order selections are reported back in. */
  columns: string[];
  selected: string[];
  /** Always ordered by `columns`, so a prompt never depends on click order. */
  onChange: (next: string[]) => void;
  id?: string;
  disabled?: boolean;
  /** Field text when nothing is picked. */
  placeholder?: string;
  /** Noun for the empty state: "No column matches." */
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
  noun = 'column',
  className,
}: ColumnPickerProps) {
  // The chips box is what the list hangs off, so the popup is as wide as the field however
  // many chips have wrapped it onto a second line.
  const anchor = useComboboxAnchor();

  // Rebuilt from `columns` on every change: click order is irrelevant to a prompt, and a stable
  // order is what makes two rows of the same sheet produce comparably-ordered prompts.
  const commit = (next: string[]) => {
    const picked = new Set(next);
    onChange(columns.filter((column) => picked.has(column)));
  };

  return (
    <Combobox
      items={columns}
      multiple
      value={selected}
      onValueChange={commit}
      disabled={disabled}
    >
      <ComboboxChips ref={anchor} className={cn('w-full', className)}>
        <ComboboxValue>
          {(value: string[]) => (
            <>
              {value.map((column) => (
                <ComboboxChip key={column} aria-label={column}>
                  {column}
                </ComboboxChip>
              ))}
              {/* Placeholder only while empty: repeating "None" beside three chips that
                  plainly are not none read as a contradiction. */}
              <ComboboxChipsInput
                id={id}
                disabled={disabled}
                placeholder={value.length ? '' : placeholder}
              />
            </>
          )}
        </ComboboxValue>
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>No {noun} matches.</ComboboxEmpty>
        <ComboboxList>
          {(column: string) => (
            <ComboboxItem key={column} value={column}>
              {column}
            </ComboboxItem>
          )}
        </ComboboxList>
        {/* Kept from the old picker: "every column" and "none" are the two selections a wide
            sheet actually wants, and both are tedious one chip at a time. */}
        {columns.length > 1 && (
          <div className="flex items-center justify-between border-t p-1">
            <Button
              size="xs"
              variant="ghost"
              disabled={selected.length === columns.length}
              onClick={() => commit(columns)}
            >
              Select all
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={selected.length === 0}
              onClick={() => commit([])}
            >
              Clear
            </Button>
          </div>
        )}
      </ComboboxContent>
    </Combobox>
  );
}
