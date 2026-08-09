'use client';

// Figma-style file header for a product's left panel: an editable session name on top (the
// "file name"), the suite context line under it, and a row of live status chips ("20 images",
// "3 flagged", "Autosaved 19:42"). The name is working state, not decoration — pages feed it
// into their .zesku and export-ZIP filenames, so what you call the session is what lands on
// disk.

import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export interface SessionChip {
  label: string;
  /** 'warn' renders amber — flagged counts, degraded states. */
  tone?: 'default' | 'warn';
}

export function SessionHeader({
  name,
  onNameChange,
  placeholder = 'Untitled session',
  product,
  chips = [],
  disabled = false,
}: {
  name: string;
  onNameChange: (name: string) => void;
  placeholder?: string;
  /** Shown as "Zigma · {product}" under the name. */
  product: string;
  chips?: SessionChip[];
  disabled?: boolean;
}) {
  return (
    <div className="px-4 py-3">
      {/* An input styled as a heading, like Figma's rename-in-place: no separate edit mode,
          no pencil icon — click and type. The border only appears on hover/focus so at rest
          it reads as a title. */}
      <input
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        aria-label="Session name"
        className={cn(
          '-mx-1.5 w-[calc(100%+0.75rem)] truncate rounded-md border border-transparent bg-transparent px-1.5 py-0.5',
          'text-sm font-semibold outline-none transition-colors',
          'hover:border-border focus:border-ring placeholder:text-muted-foreground/60',
          'disabled:pointer-events-none disabled:opacity-60',
        )}
      />
      <div className="mt-0.5 px-0 text-xs text-muted-foreground">Zigma · {product}</div>
      {chips.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <Badge
              key={chip.label}
              variant="secondary"
              className={cn(
                'px-1.5 text-[10px]',
                chip.tone === 'warn'
                  ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {chip.label}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
