'use client';

// CSV file dropzone — the suite's DropzoneShell with CSV-specific copy and states — plus the
// tile a loaded CSV turns into. The pair mirrors how prompts work everywhere else: an empty
// slot invites a file, a filled slot is a compact "file card" (components/md-file-tile.tsx),
// so a CSV reads the same in Compose, Generate and Cleanup once it is in.

import * as React from 'react';
import { FileSpreadsheetIcon, XIcon } from 'lucide-react';

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropzoneShell } from '@/components/dropzone';
import {
  Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle,
} from '@/components/ui/item';
import { cn } from '@/lib/utils';

interface CsvDropzoneProps {
  fileName: string | null;
  rowCount: number;
  onFile: (file: File) => void;
}

/** Spreadsheet-mark file icon — same hand-drawn stroke style as MdFileIcon, so a .csv card and
    a .md card sit side by side as siblings rather than strangers. */
export function DocFileIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="4" y="3" width="16" height="18" rx="2.5" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </svg>
  );
}

export function CsvFileIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="2" y="5" width="20" height="14" rx="2.5" />
      <path d="M2 10.5h20" />
      <path d="M9.25 10.5V19" />
      <path d="M15.75 10.5V19" />
    </svg>
  );
}

export function CsvDropzone({ fileName, rowCount, onFile }: CsvDropzoneProps) {
  return (
    <DropzoneShell accept=".csv,text/csv" onFiles={(files) => onFile(files[0])}>
      {fileName ? (
        <>
          <CsvFileIcon className="size-6" />
          <span>
            <strong className="text-foreground">{fileName}</strong>
            {' — '}{rowCount} row{rowCount === 1 ? '' : 's'}
          </span>
        </>
      ) : (
        <>
          <FileSpreadsheetIcon className="size-6" />
          <span>Drop CSV here or <span className="text-primary underline underline-offset-2">browse</span></span>
        </>
      )}
    </DropzoneShell>
  );
}

/**
 * The loaded-CSV card — MdFileTile's shape (icon, name, one-line preview, status chip) with the
 * two actions a sheet needs instead of an editor: click the body to replace the file, the ✕ to
 * remove it. Two sibling buttons in one Item, same reason as MdFileTile's switcher variant —
 * button-in-button is invalid HTML.
 *
 * Removal takes an optional confirm: pass `removeConfirm` copy wherever the CSV's rows carry
 * generated work that leaves with them, omit it where removal only drops a mapping.
 */
export function CsvFileTile({
  name,
  description,
  badge,
  onReplace,
  onRemove,
  removeConfirm,
  disabled = false,
  className,
}: {
  /** The uploaded file's name, e.g. "catalogue-aug.csv". */
  name: string;
  /** One truncating line under the name — the header row is the natural choice. */
  description: string;
  /** Short status chip: "1,240 rows", … */
  badge: string;
  /** Body click → picker; the chosen .csv lands here, exactly like a fresh drop. */
  onReplace: (file: File) => void;
  onRemove: () => void;
  /** Confirm copy for destructive removals; omitted = remove immediately. */
  removeConfirm?: { title: string; description: React.ReactNode };
  disabled?: boolean;
  className?: string;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);

  const removeButton = (
    <Button
      variant="ghost"
      size="icon-sm"
      disabled={disabled}
      // The wrapper already dims the whole tile when disabled.
      className="disabled:opacity-100"
      aria-label="Remove CSV"
    />
  );

  return (
    <Item
      variant="outline"
      className={cn('flex-nowrap gap-0 p-0', disabled && 'pointer-events-none opacity-50', className)}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset first: picking the same file twice must still fire a change event.
          e.target.value = '';
          if (file) onReplace(file);
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        title="Replace CSV"
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 self-stretch rounded-l-lg py-2.5 pl-3 pr-1.5 text-left transition-colors duration-100 outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ItemMedia variant="icon">
          <DocFileIcon className="text-muted-foreground" />
        </ItemMedia>
        <ItemContent className="min-w-0 gap-0">
          <ItemTitle className="w-full truncate">{name}</ItemTitle>
          <ItemDescription className="truncate text-xs">{description}</ItemDescription>
        </ItemContent>
        <Badge variant="chip" className="shrink-0">{badge}</Badge>
      </button>
      <ItemActions className="shrink-0 gap-0 pr-1.5">
        {removeConfirm ? (
          <AlertDialog>
            <AlertDialogTrigger render={removeButton}>
              <XIcon className="text-muted-foreground" />
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{removeConfirm.title}</AlertDialogTitle>
                <AlertDialogDescription>{removeConfirm.description}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={onRemove}
                  className="bg-destructive text-white hover:bg-destructive/90"
                >
                  Remove
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            className="disabled:opacity-100"
            aria-label="Remove CSV"
            onClick={onRemove}
          >
            <XIcon className="text-muted-foreground" />
          </Button>
        )}
      </ItemActions>
    </Item>
  );
}
