'use client';

// The suite's ONE dropzone shell. Four products used to hand-roll the same dashed box with
// drifting details — Compose's wasn't keyboard-operable, Generate dropped the underlined
// "browse", Compress used its own border tokens. The shell owns interaction (click, Enter/
// Space, drag state, hidden input) and the visual contract (border-border idle, border-primary
// + bg-accent on drag, focus ring); callers supply only their copy as children.

import * as React from 'react';

import { cn } from '@/lib/utils';

export function DropzoneShell({
  onFiles,
  accept,
  multiple = false,
  disabled = false,
  className,
  children,
}: {
  /** Every entry path — click-pick and drop — lands here with a non-empty list. */
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [drag, setDrag] = React.useState(false);

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (disabled) return;
        const files = [...(e.dataTransfer.files ?? [])];
        if (files.length) onFiles(files);
      }}
      className={cn(
        'flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
        drag && 'border-primary bg-accent',
        disabled && 'pointer-events-none opacity-50',
        className,
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
      {children}
    </div>
  );
}

/**
 * The canvas's empty state, which IS the drop target.
 *
 * Every product used to put a small dashed box in the left panel and an inert "nothing here
 * yet" illustration in the middle — so the biggest surface on screen explained the thing it
 * could not do, while the actual target was a strip in a column of settings. This merges them:
 * the empty canvas is where you drop, and the left panel is freed for what you dropped.
 *
 * It is DropzoneShell underneath, so drag state, keyboard operation, the hidden input and the
 * focus ring are the suite's single implementation rather than a fifth copy of them.
 */
export function CanvasDropzone({
  icon,
  title,
  description,
  onFiles,
  accept,
  multiple = false,
  disabled = false,
  className,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <DropzoneShell
      onFiles={onFiles}
      accept={accept}
      multiple={multiple}
      disabled={disabled}
      className={cn('h-full min-h-60 flex-1 justify-center gap-1 px-6 py-12', className)}
    >
      {/* Same marks as the Empty primitive it replaces — the state is unchanged, only its
          ability to accept a file is new, so it should not look like a different screen. */}
      <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-muted text-foreground [&_svg:not([class*='size-'])]:size-5">
        {icon}
      </div>
      <div className="text-sm font-medium text-foreground">{title}</div>
      {description && <div className="max-w-sm text-sm text-muted-foreground">{description}</div>}
    </DropzoneShell>
  );
}
