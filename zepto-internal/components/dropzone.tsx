'use client';

// The suite's ONE dropzone shell. Four products used to hand-roll the same dashed box with
// drifting details — Compose's wasn't keyboard-operable, Generate dropped the underlined
// "browse", Compress used its own border tokens. The shell owns interaction (click, Enter/
// Space, drag state, hidden input) and the visual contract (border-border idle, border-primary
// + bg-accent on drag, focus ring); callers supply only their copy as children.

import * as React from 'react';
import { FolderOpenIcon } from 'lucide-react';

import { filesFromDataTransfer, sortByPath } from '@/lib/drop';
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
        // preventDefault is also the SIGNAL to any window-level drop handler that this zone has
        // taken the drop — they check defaultPrevented and stand down. Deliberately not
        // stopPropagation: the window listener still needs to see the event to clear its own
        // drag highlight, which would otherwise stay stuck on after every drop onto a zone.
        e.preventDefault();
        setDrag(false);
        if (disabled) return;
        // Folder-aware: a dropped DIRECTORY is invisible to dataTransfer.files, so the entry
        // tree is walked instead (lib/drop.ts). The DataTransfer must be handed over before
        // this handler returns — the util reads the item list synchronously for that reason.
        void filesFromDataTransfer(e.dataTransfer).then((files) => {
          if (files.length) onFiles(files);
        });
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
  children,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  className?: string;
  /** Extra controls under the copy — a folder picker, say. Must stop their own clicks. */
  children?: React.ReactNode;
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
      {children}
    </DropzoneShell>
  );
}

/**
 * "Add folder", for callers whose dropzone should also accept a directory by BROWSING.
 *
 * A file input cannot offer files and folders at once — `webkitdirectory` turns the picker into
 * a folder picker outright — so opting into folders means a second input and a second control.
 * Dropping a folder needs none of this; DropzoneShell walks the entry tree already.
 *
 * Sits inside a DropzoneShell, whose whole box is a browse button, so the click must not bubble
 * or picking a folder would open the file picker behind it.
 */
export function FolderInputButton({
  onFiles,
  disabled = false,
  className,
  children = 'Add folder',
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);

  // webkitdirectory/directory are not in React's attribute types; setting them on the node
  // keeps this free of an `any` cast.
  React.useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.setAttribute('webkitdirectory', '');
    el.setAttribute('directory', '');
  }, []);

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          inputRef.current?.click();
        }}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-primary underline underline-offset-2 outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50',
          className,
        )}
      >
        <FolderOpenIcon className="size-3.5 shrink-0" aria-hidden />
        {children}
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const files = sortByPath([...(e.target.files ?? [])]);
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}
