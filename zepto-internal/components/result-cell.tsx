'use client';

// The suite's grid tile: preview on top, name + one status line beneath, and a hover-revealed
// delete control. Both products render their queues as grids of these — the BG Remover's
// cutouts and the Compositor's tiles — so the shell lives here and the products supply only
// the preview inside it.

import * as React from 'react';
import { Trash2Icon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function ResultCell({
  label,
  status,
  selected = false,
  onSelect,
  onRemove,
  removeDisabled,
  children,
}: {
  label: string;
  /** One-line badge/info text; error renders destructive. Omit where the tile has its own caption. */
  status?: { text: string; error: boolean };
  selected?: boolean;
  onSelect: () => void;
  onRemove: () => void;
  removeDisabled: boolean;
  children: React.ReactNode;
}) {
  // The control is a sibling overlay, not a child — the whole cell is already a button and
  // buttons cannot nest. Hidden until hover so a wall of tiles stays clean; always shown on
  // touch screens, where there is no hover to reveal it. Delete only: anything richer (redo,
  // AI edit, download) lives in the dialog a click opens.
  const overlay =
    'opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100';
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'block w-full rounded-lg p-0.5 text-left outline-none transition-shadow focus-visible:ring-3 focus-visible:ring-ring/50',
          selected && 'ring-2 ring-primary',
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
      <Button
        variant="secondary"
        size="icon-sm"
        title="Delete from queue"
        disabled={removeDisabled}
        onClick={onRemove}
        className={cn('absolute top-2 right-2', overlay)}
      >
        <Trash2Icon />
      </Button>
    </div>
  );
}
