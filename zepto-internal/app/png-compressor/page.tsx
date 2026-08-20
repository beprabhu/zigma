'use client';

// PNG Compressor — batch-shrink PNGs via /api/compress-local (pngquant + oxipng on this
// machine; nothing leaves localhost). Drop files, tweak colors/lossless, download singly
// or as a ZIP.

import * as React from 'react';
import { toast } from 'sonner';
import {
  CircleStopIcon, DownloadIcon, RotateCcwIcon, ShrinkIcon, SlidersHorizontalIcon, Trash2Icon,
  TriangleAlertIcon, UploadCloudIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { Toggle } from '@/components/ui/toggle';
import { Progress } from '@/components/ui/progress';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';

import { ClearAllButton } from '@/components/selection';
import { CanvasDropzone, DropzoneShell } from '@/components/dropzone';
import { buildZipStream, type ZipStreamEntry } from '@/lib/zip';
import { canvasToPngBlob, formatKb, loadImageFromFile, mapWithLimit, releaseCanvas } from '@/lib/bg/batch';
import { compressPng } from '@/lib/compress';
import { useProcessing } from '@/components/process-panel';

type ItemStatus = 'queued' | 'working' | 'done' | 'error';

interface Item {
  id: string;
  file: File;
  previewUrl: string;
  status: ItemStatus;
  output?: Blob;
  outputUrl?: string;
  error?: string;
}

const COLOR_CHOICES = [256, 128, 64, 32, 16] as const;

function tinyName(name: string): string {
  return name.replace(/\.png$/i, '') + '-tiny.png';
}

function savingsPct(input: number, output: number): number {
  return input ? Math.round((100 * (input - output)) / input) : 0;
}

function imageToCanvas(img: HTMLImageElement): Promise<HTMLCanvasElement> {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return Promise.resolve(c);
}

export default function PngCompressorPage() {
  const [items, setItems] = React.useState<Item[]>([]);
  // Figma-style session name in the panel header; seeds the download ZIP filename. Auto-seeded
  // from the first PNG dropped, but never over a name the user already typed.
  const [sessionName, setSessionName] = React.useState('');
  const sessionSlug = sessionName.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  const [colors, setColors] = React.useState<number>(256);
  const [lossless, setLossless] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [progress, setProgress] = React.useState<{ pct: number; text: string } | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  const proc = useProcessing({ prefix: 'skuc_png', removeBg: true, tileFit: true, compress: false, busy: running });

  const patch = React.useCallback((id: string, delta: Partial<Item>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...delta } : it)));
  }, []);

  const addFiles = React.useCallback((files: FileList | File[]) => {
    const pngs = Array.from(files).filter(
      (f) => f.type === 'image/png' || /\.png$/i.test(f.name),
    );
    const skipped = Array.from(files).length - pngs.length;
    if (skipped > 0) toast.warning(`Skipped ${skipped} non-PNG file${skipped === 1 ? '' : 's'}`);
    if (!pngs.length) return;
    setSessionName((prev) => (prev.trim() ? prev : pngs[0].name.replace(/\.[^.]+$/, '')));
    setItems((prev) => [
      ...prev,
      ...pngs.map((file) => ({
        id: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
        status: 'queued' as const,
      })),
    ]);
  }, []);

  // Object URLs live for the page's lifetime; revoke them all on unmount.
  React.useEffect(() => () => {
    setItems((prev) => {
      for (const it of prev) {
        URL.revokeObjectURL(it.previewUrl);
        if (it.outputUrl) URL.revokeObjectURL(it.outputUrl);
      }
      return prev;
    });
  }, []);

  React.useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length) addFiles(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addFiles]);

  const compressOne = React.useCallback(
    async (item: Item, signal: AbortSignal) => {
      patch(item.id, { status: 'working', error: undefined });
      try {
        // The processing space runs first (pixels), then the shared compress step (bytes) —
        // the same order every product's export uses.
        let source: Blob = item.file;
        if (proc.stepsActive) {
          const img = await loadImageFromFile(item.file);
          const canvas = await proc.apply(await imageToCanvas(img));
          if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
          source = await canvasToPngBlob(canvas);
          releaseCanvas(canvas);
        }
        const bytes = await compressPng(source, { colors, lossless, signal });
        const output = new Blob([bytes as BlobPart], { type: 'image/png' });
        patch(item.id, { status: 'done', output, outputUrl: URL.createObjectURL(output) });
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          patch(item.id, { status: 'queued' });
        } else {
          patch(item.id, { status: 'error', error: (e as Error).message });
        }
      }
    },
    [colors, lossless, patch, proc],
  );

  const compressAll = React.useCallback(async () => {
    const pending = items.filter((it) => it.status === 'queued' || it.status === 'error');
    if (!pending.length) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    let finished = 0;
    setProgress({ pct: 0, text: `0 of ${pending.length} compressed…` });
    try {
      await mapWithLimit(pending, 3, async (item) => {
        await compressOne(item, controller.signal);
        finished++;
        setProgress({
          pct: (finished / pending.length) * 100,
          text: `${finished} of ${pending.length} compressed…`,
        });
      });
    } finally {
      setProgress(
        controller.signal.aborted
          ? { pct: 100, text: `Stopped — ${finished} of ${pending.length} compressed; the rest are untouched.` }
          : { pct: 100, text: `Done — ${finished} of ${pending.length} files compressed.` },
      );
      setRunning(false);
      abortRef.current = null;
    }
  }, [items, compressOne]);

  const downloadZip = React.useCallback(async () => {
    const done = items.filter((it) => it.status === 'done' && it.output);
    if (!done.length) return;
    // The outputs are already Blobs — hand them to the zip as-is instead of materializing
    // every compressed PNG into memory first.
    const entries: ZipStreamEntry[] = done.map((it) => ({
      name: tinyName(it.file.name),
      data: it.output!,
    }));
    const url = URL.createObjectURL(await buildZipStream(entries));
    const a = document.createElement('a');
    a.href = url;
    a.download = sessionSlug ? `${sessionSlug}-compressed.zip` : 'compressed-pngs.zip';
    a.click();
    URL.revokeObjectURL(url);
  }, [items, sessionSlug]);

  const doneCount = items.filter((it) => it.status === 'done').length;
  const pendingCount = items.filter(
    (it) => it.status === 'queued' || it.status === 'error',
  ).length;
  // One primary button doing two jobs: it runs the batch, and once nothing is left to compress
  // it becomes the export. Dropping more files raises pendingCount and flips it back, so the
  // button always offers the thing that is actually next rather than two rival CTAs.
  const exportMode = !running && pendingCount === 0 && doneCount > 0;
  const totalIn = items.reduce((s, it) => s + it.file.size, 0);
  const totalOut = items.reduce(
    (s, it) => s + (it.output ? it.output.size : it.file.size), 0,
  );

  const statusText = running
    ? progress?.text ?? 'Compressing…'
    : doneCount
      ? `${formatKb(totalIn)} → ${formatKb(totalOut)} · ${savingsPct(totalIn, totalOut)}% smaller`
      : items.length
        ? `${items.length} file${items.length === 1 ? '' : 's'} queued`
        : 'Drop PNGs to start';

  return (
    // No panes. Compress has no contents list to browse and no per-item properties to inspect,
    // so the two 320px columns framed an empty middle and spent the whole left one on four
    // controls. Those four ride over the canvas instead, Figma-style.
    <div className="relative flex h-dvh min-w-0 flex-col bg-muted/40">
      {/* pb-32 so the last queue row clears the bar rather than hiding under it. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-32">
        <div className="mx-auto flex max-w-4xl flex-col gap-4">
          {/* One surface, not two. An empty queue used to show a dropzone AND an illustration
              telling you to use it; now the empty state IS the target. Once files are in, the
              box shrinks back to a strip so more can still be added. */}
          {!items.length ? (
            <CanvasDropzone
              icon={<UploadCloudIcon />}
              title="Drop PNGs to start"
              description="Browse or paste works too. Every PNG becomes a queue row."
              accept="image/png"
              multiple
              onFiles={(files) => addFiles(files)}
            />
          ) : (
            <>
              <DropzoneShell accept="image/png" multiple onFiles={(files) => addFiles(files)}>
                <UploadCloudIcon className="size-6" />
                <span className="font-medium text-foreground">
                  Drop PNGs here, <span className="font-normal text-primary underline underline-offset-2">browse</span>, or paste
                </span>
                <span className="text-xs">
                  {items.length} file{items.length === 1 ? '' : 's'} in queue
                </span>
              </DropzoneShell>
              {/* Grid toolbar: count on the left, whole-queue reset on the right — the same
                  confirm-guarded idiom as Compose, Cleanup and Generate. */}
              <div className="-mb-2 flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  {items.length} file{items.length === 1 ? '' : 's'}
                  {doneCount ? ` · ${doneCount} compressed` : ''}
                </span>
                <ClearAllButton
                  title="Clear the queue?"
                  disabled={running}
                  onConfirm={() => setItems([])}
                  description={
                    <>
                      Removes all {items.length} file{items.length === 1 ? '' : 's'}, including
                      compressed results that haven&rsquo;t been exported. Your source files on
                      disk are untouched.
                    </>
                  }
                />
              </div>
            <ul className="flex flex-col gap-2">
              {items.map((it) => (
                <li
                  key={it.id}
                  className="flex items-center gap-3 rounded-lg border bg-card p-2 pr-3"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={it.outputUrl ?? it.previewUrl}
                    alt={it.file.name}
                    className="size-12 shrink-0 rounded border object-contain [background:repeating-conic-gradient(var(--muted)_0%_25%,transparent_0%_50%)_0_0/12px_12px]"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{it.file.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {it.status === 'done' && it.output
                        ? `${formatKb(it.file.size)} → ${formatKb(it.output.size)}`
                        : formatKb(it.file.size)}
                      {it.status === 'error' && (
                        <span className="text-destructive"> — {it.error}</span>
                      )}
                    </p>
                  </div>
                  {it.status === 'working' && <Spinner className="size-4" />}
                  {it.status === 'error' && (
                    <TriangleAlertIcon className="size-4 text-destructive" />
                  )}
                  {it.status === 'done' && it.output && (
                    <Badge
                      variant={it.output.size < it.file.size ? 'default' : 'secondary'}
                    >
                      −{savingsPct(it.file.size, it.output.size)}%
                    </Badge>
                  )}
                  {it.status === 'done' && it.outputUrl && (
                    // nativeButton={false}: the rendered element is an <a>, and Base UI
                    // logs a dev error if it still assumes a native <button>.
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      nativeButton={false}
                      render={<a href={it.outputUrl} download={tinyName(it.file.name)} />}
                    >
                      <DownloadIcon />
                    </Button>
                  )}
                  {it.status === 'error' && !running && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      onClick={() => patch(it.id, { status: 'queued', error: undefined })}
                    >
                      <RotateCcwIcon />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    disabled={it.status === 'working'}
                    onClick={() => setItems((prev) => prev.filter((p) => p.id !== it.id))}
                  >
                    <Trash2Icon />
                  </Button>
                </li>
              ))}
            </ul>
            </>
          )}
        </div>
      </div>

      {/* The floating bar. Frosted and lifted off the canvas rather than docked to an edge, so
          it reads as a layer over the work — the queue keeps scrolling underneath it. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-4">
        <div className="pointer-events-auto relative flex max-w-full items-center gap-1.5 overflow-hidden rounded-xl border bg-background/85 p-1.5 shadow-lg backdrop-blur-md">
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Batch settings"
                  title="Batch name, remove background, tile fit"
                />
              }
            >
              <SlidersHorizontalIcon />
            </PopoverTrigger>
            {/* side="top": the bar sits at the bottom, so the panel opens upward over the
                canvas instead of off the bottom of the screen. */}
            {/* max-h + scroll: Tile fit unfolds a whole safe-area editor in here, which is
                taller than the viewport once the bar has taken the bottom of it. */}
            <PopoverContent
              side="top"
              align="start"
              className="max-h-[75dvh] w-80 overflow-y-auto p-0"
            >
              <div className="divide-y">
                <section className="px-4 py-4">
                  <Field>
                    <FieldLabel htmlFor="png-batch-name">Batch name</FieldLabel>
                    <Input
                      id="png-batch-name"
                      value={sessionName}
                      onChange={(e) => setSessionName(e.target.value)}
                      placeholder="Untitled batch"
                    />
                    <FieldDescription>Names the exported ZIP.</FieldDescription>
                  </Field>
                </section>
                {/* Remove background and Tile fit — the pixel steps that run before the bytes
                    get squeezed. Tile fit alone opens a whole safe-area editor, which is why
                    these live behind the trigger rather than in the bar itself. */}
                {proc.panel}
              </div>
            </PopoverContent>
          </Popover>

          <Separator orientation="vertical" className="mx-0.5 h-6" />

          <Toggle
            size="sm"
            variant="outline"
            pressed={lossless}
            disabled={running}
            onPressedChange={setLossless}
            title="Skip quantization; oxipng squeeze only."
          >
            Lossless
          </Toggle>

          {/* Hidden, not greyed, while lossless — there is no palette left to choose. */}
          {!lossless && (
            <Select
              value={String(colors)}
              onValueChange={(v) => setColors(Number(v))}
              disabled={running}
            >
              <SelectTrigger
                size="sm"
                aria-label="Palette colors"
                title="Fewer colors → smaller files, more banding."
              >
                <SelectValue>{(v) => `${v} colors`}</SelectValue>
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false} side="top">
                {COLOR_CHOICES.map((c) => (
                  <SelectItem key={c} value={String(c)}>
                    {c} colors{c === 256 ? ' (best quality)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Separator orientation="vertical" className="mx-0.5 h-6" />

          <span className="px-1 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
            {statusText}
          </span>

          {running && (
            <Button variant="outline" size="sm" onClick={() => abortRef.current?.abort()}>
              <CircleStopIcon data-icon="inline-start" />
              Stop
            </Button>
          )}

          <Button
            size="sm"
            disabled={running || !items.length}
            onClick={exportMode ? downloadZip : compressAll}
          >
            {running ? (
              <Spinner data-icon="inline-start" />
            ) : exportMode ? (
              <DownloadIcon data-icon="inline-start" />
            ) : (
              <ShrinkIcon data-icon="inline-start" />
            )}
            {running ? 'Compressing…' : exportMode ? `Export ZIP (${doneCount})` : 'Compress all'}
          </Button>

          {/* Hairline along the bar's own bottom edge — the run's progress without spending a
              row on a track. */}
          {running && progress && (
            <Progress
              value={progress.pct}
              className="absolute inset-x-0 bottom-0 h-0.5 rounded-none"
            />
          )}
        </div>
      </div>
    </div>
  );
}
