'use client';

// Find-a-row search, shared by all four workspaces.
//
// One rule holds everywhere it is used, and it is the whole reason this is safe: searching changes
// what is DRAWN, never what is queued. Runs, exports, batch seals and "clear all" keep reading the
// real list. Wiring a search term into those would mean a designer who typed "lays" to check one
// tile, then hit Export, would ship three files instead of three hundred — silently, because the
// export would look like it worked.
//
// Matching is AND across whitespace-separated words, so "lays 100g" narrows rather than widens, and
// it searches the CSV cells behind a row as well as its visible name. That second part is the point
// for the sheet-driven products: the row a person is hunting for is usually identified by an SKU
// code or a pack size that never appears in the tile's title.

import * as React from 'react';
import { SearchIcon, XIcon } from 'lucide-react';

import {
  InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupText,
} from '@/components/ui/input-group';
import { cn } from '@/lib/utils';

export function QueueSearch({
  value,
  onChange,
  placeholder = 'Search…',
  count,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /**
   * How much the grid is showing — "8,543 images", or "12 of 8,543" once something narrows it.
   *
   * It rides inside the field rather than beside it because the two are one thought: the number
   * is the answer to whatever is typed here, and a separate line of text next to the box made the
   * toolbar read as three controls where there are two.
   */
  count?: React.ReactNode;
  className?: string;
}) {
  return (
    <InputGroup className={cn('h-8 w-56 sm:w-72', className)}>
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => onChange(e.target.value)}
        // Escape clears without reaching for the mouse, the way every find field behaves. The
        // native type="search" clear button is Chrome-only and unstyled, hence the explicit one.
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            e.stopPropagation();
            onChange('');
          }
        }}
        // type="search" for the semantics and the Escape behaviour browsers give it, but WebKit
        // also draws its own unstyleable clear button — which sat next to ours as a second, uglier
        // X. Hidden so there is exactly one way to clear.
        className="text-xs [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
      />
      {(count || value) && (
        <InputGroupAddon align="inline-end">
          {count && (
            <InputGroupText className="text-xs tabular-nums whitespace-nowrap">
              {count}
            </InputGroupText>
          )}
          {value && (
            <InputGroupButton
              size="icon-xs"
              variant="ghost"
              aria-label="Clear search"
              onClick={() => onChange('')}
            >
              <XIcon />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}

/**
 * The query, split into the words a row has to satisfy. Empty when nothing is being searched —
 * callers test that first and skip filtering entirely rather than walking the queue for nothing.
 */
export function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Whether one row matches every term.
 *
 * `fields` is whatever identifies the row to a human: its name, its row number, and the cells of
 * the sheet it came from. Nullish entries are skipped so callers can pass optional fields inline
 * without guarding each one.
 */
export function matchesTerms(fields: readonly (string | number | null | undefined)[], terms: readonly string[]): boolean {
  if (!terms.length) return true;
  const hay = fields
    .filter((f) => f !== null && f !== undefined && f !== '')
    .join(' ')
    .toLowerCase();
  return terms.every((term) => hay.includes(term));
}

/** The cells of a CSV-backed row, for the sheet-searching half of the rule above. */
export function recordValues(record: Record<string, string> | undefined): string[] {
  return record ? Object.values(record) : [];
}
