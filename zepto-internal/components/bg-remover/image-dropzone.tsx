'use client';

// Every way an image gets into the BG Remover queue — browse, drag & drop, clipboard paste and
// a compositor-shaped CSV of image URLs — behind one dropzone. Styled after
// components/csv-dropzone.tsx; all three paths report through the single onAdd callback.

import * as React from 'react';
import { toast } from 'sonner';
import {
  ClipboardPasteIcon, FileTextIcon, ImagesIcon, UploadCloudIcon, type LucideIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  draftsFromCsv,
  draftsFromFiles,
  isCsvFile,
  isImageFile,
  type BgItemDraft,
  type CsvImport,
} from '@/lib/bg/batch';
import { isHeicFile, normalizeHeicFiles } from '@/lib/bg/heic';
import { PROJECT_EXTENSION, sniffProjectFile } from '@/lib/bg/project';

export interface CsvPayload {
  fileName: string;
  /** Raw CSV text, kept so the page can re-derive drafts when columns are remapped. */
  text: string;
  imported: CsvImport;
}

type LoadKind = 'files' | 'csv' | 'paste';

interface LoadSummary {
  kind: LoadKind;
  text: string;
}

interface ImageDropzoneProps {
  /** Single funnel for files and pastes; the page assigns ids and appends. */
  onAdd: (drafts: BgItemDraft[]) => void;
  /**
   * When set, a dropped CSV is handed over whole instead of flattened here, so the page can
   * own the column mapping (name column, image URL columns) and rebuild items on change.
   */
  onCsv?: (payload: CsvPayload) => void;
  /** A dropped .zesku working file — restored by the page, not flattened here. */
  onProject?: (file: File) => void;
  /** Queue size, so the zone can say what is loaded overall. */
  itemCount: number;
  disabled?: boolean;
  /**
   * 'canvas' fills the empty canvas and speaks up. 'button' is the same zone with its box
   * taken off — for the queue toolbar, where the only thing still needed is a way to BROWSE,
   * since drop and paste are already bound to the window.
   */
  size?: 'panel' | 'canvas' | 'button';
  className?: string;
}

const ICONS: Record<LoadKind, LucideIcon> = {
  files: ImagesIcon,
  csv: FileTextIcon,
  paste: ClipboardPasteIcon,
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function ImageDropzone({
  onAdd, onCsv, onProject, itemCount, disabled = false, size = 'panel', className,
}: ImageDropzoneProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const pasteCount = React.useRef(0);
  const [drag, setDrag] = React.useState(false);
  const [summary, setSummary] = React.useState<LoadSummary | null>(null);

  const add = React.useCallback(
    (drafts: BgItemDraft[], next: LoadSummary) => {
      if (!drafts.length) return;
      setSummary(next);
      onAdd(drafts);
    },
    [onAdd],
  );

  const handleFiles = React.useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      // A saved project restores a whole session; it outranks everything else in the drop.
      // Sniffed, not just extension-matched: an extension-stripped or .zip-renamed save must
      // still open (sniffProjectFile reads 4 bytes at most — images and CSVs skip it by name).
      if (onProject) {
        for (const candidate of files) {
          if (await sniffProjectFile(candidate)) {
            onProject(candidate);
            return;
          }
        }
      }
      // A CSV is a whole batch on its own, so it wins over anything else in the same drop.
      const csv = files.find(isCsvFile);
      if (csv) {
        let text: string;
        try {
          // Both callers fire this without awaiting, so a read failure (file moved or
          // permission revoked between the drop and the read) has to be reported here or the
          // dropzone silently does nothing.
          text = await csv.text();
        } catch (e) {
          toast.error(`Could not read ${csv.name}: ${(e as Error).message}`);
          return;
        }
        const imported = draftsFromCsv(text);
        if (!imported.headers.length) {
          toast.error(`${csv.name} does not look like a CSV.`);
          return;
        }
        if (onCsv) {
          // Even a CSV with zero detected URLs goes up — the page's column mapper is exactly
          // the tool for rescuing a file the auto-detection misread.
          setSummary({
            kind: 'csv',
            text: `${csv.name} — ${plural(imported.rowCount, 'row')}, ${plural(imported.drafts.length, 'image URL')}`,
          });
          onCsv({ fileName: csv.name, text, imported });
          return;
        }
        if (!imported.drafts.length) {
          toast.error(`No image URL columns detected in ${csv.name}.`);
          return;
        }
        add(imported.drafts, {
          kind: 'csv',
          text: `${csv.name} — ${plural(imported.rowCount, 'row')}, ${plural(imported.drafts.length, 'image URL')} from ${imported.imageColumns.join(', ')}`,
        });
        return;
      }

      // HEIC converts to JPEG here, at the door — browsers cannot decode it, and after this
      // point nothing downstream needs to know the format existed.
      const heicCount = files.filter(isHeicFile).length;
      const normalized = await normalizeHeicFiles(files, (file, e) =>
        toast.error(`Could not convert ${file.name}: ${(e as Error).message}`),
      );
      const drafts = draftsFromFiles(normalized);
      if (!drafts.length) {
        toast.error('Drop image files or a CSV of image URLs.');
        return;
      }
      add(drafts, {
        kind: 'files',
        text: `${plural(drafts.length, 'image file')} added${heicCount ? ` (${plural(heicCount, 'HEIC file')} converted)` : ''}`,
      });
    },
    [add, onCsv, onProject],
  );

  // Drops are bound to the window, like paste below: the zone itself is small, and a file
  // dropped a few pixels outside it hits the browser default instead — navigating away from
  // the app and taking the session with it. The zone's own drag handlers were removed in
  // favour of these; the highlight now signals "drop anywhere on this page".
  React.useEffect(() => {
    if (disabled) return;
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files');
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDrag(true);
    };
    const onDragLeave = (event: DragEvent) => {
      // relatedTarget is null only when the drag leaves the window, not when crossing children.
      if (event.relatedTarget === null) setDrag(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDrag(false);
      void handleFiles(Array.from(event.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [disabled, handleFiles]);

  // Paste is bound to the window because there is nothing sensible to focus first; the listener
  // only exists while this product is mounted, so other pages keep their own paste behaviour.
  React.useEffect(() => {
    if (disabled) return;
    const onPaste = (event: ClipboardEvent) => {
      const clipboard = event.clipboardData?.items;
      if (!clipboard) return;
      const files = Array.from(clipboard)
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null && isImageFile(file));
      if (!files.length) return;
      event.preventDefault();
      const drafts: BgItemDraft[] = files.map((file) => {
        pasteCount.current += 1;
        // Clipboard files are all called "image.png"; a counter keeps exports readable.
        return { name: `pasted-${pasteCount.current}`, source: { kind: 'file', file } };
      });
      add(drafts, { kind: 'paste', text: `${plural(drafts.length, 'pasted image')} added` });
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [add, disabled]);

  const SummaryIcon = summary ? ICONS[summary.kind] : UploadCloudIcon;
  const browse = () => {
    if (!disabled) inputRef.current?.click();
  };

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept={`image/*,.heic,.heif,.csv,text/csv,${PROJECT_EXTENSION},.zip`}
      multiple
      hidden
      onChange={(e) => {
        const files = e.target.files ? Array.from(e.target.files) : [];
        // Reset first: picking the same file twice must still fire a change event.
        e.target.value = '';
        void handleFiles(files);
      }}
    />
  );

  // No box, no copy — drop and paste are on the window, so a populated queue only needs the
  // one affordance those two cannot provide.
  if (size === 'button') {
    return (
      <>
        {fileInput}
        <Button variant="outline" size="sm" disabled={disabled} onClick={browse}>
          <UploadCloudIcon data-icon="inline-start" />
          Add
        </Button>
      </>
    );
  }

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={browse}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          browse();
        }
      }}
      className={cn(
        'flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
        size === 'canvas' && 'h-full min-h-60 flex-1 justify-center px-6 py-12',
        drag && 'border-primary bg-accent',
        disabled && 'pointer-events-none opacity-50',
        className,
      )}
    >
      {fileInput}
      {size === 'canvas' ? (
        <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-muted text-foreground">
          <SummaryIcon className="size-5" />
        </div>
      ) : (
        <SummaryIcon className="size-6" />
      )}
      {summary ? (
        <div className="space-y-0.5">
          <div className="text-foreground">{summary.text}</div>
          <div className="text-xs">
            {plural(itemCount, 'image')} in the queue · drop, paste or browse to add more
          </div>
        </div>
      ) : (
        <div className="space-y-0.5">
          <div>
            Drop images, a CSV or a .zesku project anywhere on this page, or{' '}
            <u className="text-primary">browse</u>
          </div>
          <div className="text-xs">You can also paste an image from the clipboard</div>
        </div>
      )}
    </div>
  );
}
