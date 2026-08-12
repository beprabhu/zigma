'use client';

// The suite's grid tile: preview on top, name + one status line beneath, and a hover-revealed
// delete control. Both products render their queues as grids of these — the BG Remover's
// cutouts and the Compositor's tiles — so the shell lives here and the products supply only
// the preview inside it.
//
// Multi-select (opt-in via onToggleSelect): a hover checkbox in the top-left corner. Ticking
// any tile enters selection — from then on clicking a tile toggles it instead of opening its
// dialog (Google-Photos style), until the caller's selection empties again. Checkboxes stay
// visible while selection is active so the state of every tile is readable at a glance.

import * as React from 'react';
import { CheckIcon, Trash2Icon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function ResultCell({
  label,
  status,
  selected = false,
  checked = false,
  selectionActive = false,
  onSelect,
  onToggleSelect,
  onRemove,
  removeDisabled,
  children,
}: {
  label: string;
  /** One-line badge/info text; error renders destructive. Omit where the tile has its own caption. */
  status?: { text: string; error: boolean };
  selected?: boolean;
  /** Multi-select: whether this tile is in the caller's selection. */
  checked?: boolean;
  /** Multi-select: true while ANY tile is selected — clicks toggle instead of opening. */
  selectionActive?: boolean;
  onSelect: () => void;
  /** Presence enables the checkbox. shiftKey supports range selection in the caller. */
  onToggleSelect?: (shiftKey: boolean) => void;
  onRemove: () => void;
  removeDisabled: boolean;
  children: React.ReactNode;
}) {
  // The controls are sibling overlays, not children — the whole cell is already a button and
  // buttons cannot nest. Hidden until hover so a wall of tiles stays clean; always shown on
  // touch screens, where there is no hover to reveal them.
  const overlay =
    'opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100';
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={(e) => {
          if (selectionActive && onToggleSelect) onToggleSelect(e.shiftKey);
          else onSelect();
        }}
        className={cn(
          'block w-full rounded-lg p-0.5 text-left outline-none transition-shadow focus-visible:ring-3 focus-visible:ring-ring/50',
          selected && 'ring-2 ring-primary',
          checked && 'ring-2 ring-primary/70',
        )}
      >
        {children}
        <div className="mt-1 truncate text-[11px]">{label}</div>
        {status && (
          <div
            className={cn(
              'truncate text-[11px]',
              status.error ? 'text-destructive' : 'text-muted-foreground',
            )}
            title={status.text}
          >
            {status.text}
          </div>
        )}
      </button>
      {onToggleSelect && (
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label={checked ? `Deselect ${label}` : `Select ${label}`}
          title={checked ? 'Deselect' : 'Select · shift-click for a range'}
          onClick={(e) => onToggleSelect(e.shiftKey)}
          className={cn(
            'absolute top-2 left-2 grid size-5 place-items-center rounded-md border transition-all',
            'focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
            checked
              ? 'border-primary bg-primary text-primary-foreground opacity-100'
              : cn(
                  // Unchecked must still read as a control against both the tile and the image
                  // behind it — a solid backdrop and a strong border, not theme-ghost tints.
                  'border-muted-foreground/70 bg-background text-transparent shadow-sm hover:border-primary hover:text-muted-foreground/50',
                  overlay,
                  selectionActive && 'opacity-100',
                ),
          )}
        >
          <CheckIcon className="size-3.5" strokeWidth={3} />
        </button>
      )}
      <Button
        variant="secondary"
        size="icon-sm"
        title="Delete from queue"
        disabled={removeDisabled}
        onClick={onRemove}
        className={cn('absolute top-2 right-2', overlay, selectionActive && 'hidden')}
      >
        <Trash2Icon />
      </Button>
    </div>
  );
}
