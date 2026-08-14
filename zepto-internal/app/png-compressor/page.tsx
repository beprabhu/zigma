'use client';

// PNG Compressor — batch-shrink PNGs via /api/compress-local (pngquant + oxipng on this
// machine; nothing leaves localhost). Drop files, tweak colors/lossless, download singly
// or as a ZIP.

import * as React from 'react';
import { toast } from 'sonner';
import {
  CircleStopIcon, DownloadIcon, ImagesIcon, RotateCcwIcon, ShrinkIcon, Trash2Icon,
  TriangleAlertIcon, UploadCloudIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/hint';
import {
  Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle,
} from '@/components/ui/empty';
import {
  Field, FieldContent, FieldGroup, FieldLabel,
} from '@/components/ui/field';
import { Progress } from '@/components/ui/progress';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';

import { Canvas, PanelSection, RightPanel, StudioShell } from '@/components/pane-layout';
import { ClearAllButton } from '@/components/selection';
import { DropzoneShell } from '@/components/dropzone';
import { SessionHeader, type SessionChip } from '@/components/session-header';
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
  const totalIn = items.reduce((s, it) => s + it.file.size, 0);
  const totalOut = items.reduce(
    (s, it) => s + (it.output ? it.output.size : it.file.size), 0,
  );

  return (
    <div className="flex min-h-dvh flex-col">
      <StudioShell>
        <Canvas>
          <div className="mx-auto flex max-w-4xl flex-col gap-4">
          <DropzoneShell accept="image/png" multiple onFiles={(files) => addFiles(files)}>
            <UploadCloudIcon className="size-6" />
            <span className="font-medium text-foreground">
              Drop PNGs here, <span className="font-normal text-primary underline underline-offset-2">browse</span>, or paste
            </span>
            <span className="text-xs">
              {items.length ? `${items.length} file${items.length === 1 ? '' : 's'} in queue` : 'PNG files only'}
            </span>
          </DropzoneShell>

          {!items.length ? (
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ImagesIcon />
                </EmptyMedia>
                <EmptyTitle>No PNGs yet</EmptyTitle>
                <EmptyDescription>
                  Add files above — every PNG becomes a queue row.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
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
        </Canvas>

        <RightPanel
          title="Process & compress"
          header={
            <SessionHeader
              name={sessionName}
              onNameChange={setSessionName}
              placeholder="Untitled batch"
              product="Compress"
              chips={
                [
                  items.length > 0 && { label: `${items.length} file${items.length === 1 ? '' : 's'}` },
                  doneCount > 0 && { label: `${doneCount} compressed` },
                  doneCount > 0 && { label: `${savingsPct(totalIn, totalOut)}% smaller` },
                ].filter(Boolean) as SessionChip[]
              }
            />
          }
          footer={
            <div className="flex flex-col gap-2">
              {/* No children: the Progress root renders its own track+indicator. */}
              {progress && <Progress value={progress.pct} />}
              <p className="text-xs break-words text-muted-foreground">
                {progress?.text || 'Compressed PNGs export as a ZIP.'}
              </p>
              <Button onClick={compressAll} disabled={running || !items.length}>
                {running ? <Spinner data-icon="inline-start" /> : <ShrinkIcon data-icon="inline-start" />}
                {running ? 'Compressing…' : 'Compress all'}
              </Button>
              {running && (
                <Button variant="outline" onClick={() => abortRef.current?.abort()}>
                  <CircleStopIcon data-icon="inline-start" />
                  Stop
                </Button>
              )}
              {/* Secondary, not primary: unlike the other products this footer also holds the
                  run button, and two stacked primaries would fight for the eye. Label and icon
                  match the suite's Export ZIP everywhere else. */}
              <Button variant="secondary" onClick={downloadZip} disabled={!doneCount}>
                <DownloadIcon data-icon="inline-start" />
                Export ZIP{doneCount ? ` (${doneCount})` : ''}
              </Button>
            </div>
          }
        >
          {proc.panel}
          <PanelSection title="Compression" hint="Applied to the next compression run.">
              <FieldGroup>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel htmlFor="lossless"><Hint hint="Skip quantization; oxipng squeeze only.">Lossless only</Hint></FieldLabel>
                  </FieldContent>
                  <Switch id="lossless" checked={lossless} disabled={running} onCheckedChange={setLossless} />
                </Field>
                {/* Hidden, not greyed, while lossless — matching the shared Compress PNGs step. */}
                {!lossless && (
                  <Field>
                    <FieldLabel htmlFor="colors"><Hint hint="Fewer colors → smaller files, more banding.">Palette colors</Hint></FieldLabel>
                    <Select
                      value={String(colors)}
                      onValueChange={(v) => setColors(Number(v))}
                      disabled={running}
                    >
                      <SelectTrigger id="colors" className="w-full">
                        <SelectValue>{(v) => `${v} colors`}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {COLOR_CHOICES.map((c) => (
                          <SelectItem key={c} value={String(c)}>
                            {c} colors{c === 256 ? ' (best quality)' : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              </FieldGroup>
            </PanelSection>

          {doneCount > 0 && (
            <PanelSection className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total</span>
                  <span>
                    {formatKb(totalIn)} → {formatKb(totalOut)}
                  </span>
                </div>
                <Progress value={savingsPct(totalIn, totalOut)} />
                <p className="text-xs text-muted-foreground">
                  {savingsPct(totalIn, totalOut)}% smaller overall
                </p>
              </PanelSection>
          )}
        </RightPanel>
      </StudioShell>
    </div>
  );
}
