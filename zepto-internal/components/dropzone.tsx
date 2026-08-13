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
