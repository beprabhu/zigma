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
import {
  releasePngItem, restingPngStatus, revivePngUrls, savingsPct, tinyName, type PngItem,
} from '@/lib/png-queue';
import { readSession, saveSession, sessionKey } from '@/lib/session-store';
import { resolveOpen } from '@/lib/files/open';
import { useNewFileGeneration } from '@/components/new-file-boundary';
import { useFileStore, type LoadedFile } from '@/lib/files/use-file-store';
import { EMPTY_PNG_DOC, pngCodec, type PngDoc } from '@/lib/files/codecs/png';
import { daysUntilExpiry } from '@/lib/files/sweep';
import { QueueSearch, matchesTerms, searchTerms } from '@/components/queue-search';

const COLOR_CHOICES = [256, 128, 64, 32, 16] as const;

/**
 * What survives a hop to another product. Not persistence — the file store handles that — but the
 * live rows, including the dropped Files themselves, which disk deliberately never holds.
 */
interface PngSession {
  fileId: string;
  items: PngItem[];
  sessionName: string;
  colors: number;
  lossless: boolean;
}

const PNG_SESSION = sessionKey<PngSession>('png-compressor');

function imageToCanvas(img: HTMLImageElement): Promise<HTMLCanvasElement> {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return Promise.resolve(c);
}

/**
 * Thin shell around the file itself. The key is what makes "New png-compressor file" work: a bump
 * remounts everything below and the fresh mount resolves to a new file id, rather than every
 * piece of page state needing its own reset.
 */
export default function PngCompressorPage() {
  const generation = useNewFileGeneration('png-compressor');
  return <PngCompressorFile key={generation} />;
}

function PngCompressorFile() {
  /**
   * Which file this mount is editing, and whether the tab's live snapshot belongs to it. A request
   * from the homepage outranks the snapshot; when they disagree the snapshot is dropped, because
   * its rows belong to a different file.
   */
  const [opened] = React.useState(() => resolveOpen('png-compressor', readSession(PNG_SESSION)));
  const [items, setItems] = React.useState<PngItem[]>(() =>
    revivePngUrls(opened.snapshot?.items ?? []),
  );
  // Figma-style session name in the panel header; seeds the download ZIP filename. Auto-seeded
  // from the first PNG dropped, but never over a name the user already typed.
  const [sessionName, setSessionName] = React.useState(() => opened.snapshot?.sessionName ?? '');
  const sessionSlug = sessionName.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  const [colors, setColors] = React.useState<number>(
    () => opened.snapshot?.colors ?? EMPTY_PNG_DOC.colors,
  );
  const [lossless, setLossless] = React.useState(
    () => opened.snapshot?.lossless ?? EMPTY_PNG_DOC.lossless,
  );
  const [running, setRunning] = React.useState(false);
  const [progress, setProgress] = React.useState<{ pct: number; text: string } | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  const proc = useProcessing({ prefix: 'skuc_png', removeBg: true, tileFit: true, compress: false, busy: running });

  const patch = React.useCallback((id: string, delta: Partial<PngItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...delta } : it)));
  }, []);

  // ---- The file ----
  const fileDoc = React.useMemo<PngDoc>(
    () => ({ sessionName, colors, lossless }),
    [sessionName, colors, lossless],
  );

  /** Seeds the page from disk. Called once, before the store starts mirroring. */
  const handleLoadedFile = React.useCallback((loaded: LoadedFile<PngItem, PngDoc>) => {
    if (loaded.doc) {
      if (loaded.doc.sessionName) {
        setSessionName((prev) => (prev.trim() ? prev : loaded.doc!.sessionName));
      }
      setColors(loaded.doc.colors);
      setLossless(loaded.doc.lossless);
    }
    if (loaded.items.length) {
      setItems((prev) => (prev.length ? [...prev, ...loaded.items] : loaded.items));
    }
  }, []);

  const {
    fileId,
    phase: filePhase,
    record: fileRecord,
    setKept: setFileKept,
    failing: fileFailing,
  } = useFileStore<PngItem, PngDoc>({
    codec: pngCodec,
    items,
    doc: fileDoc,
    fileId: opened.fileId,
    // A queue carried across a product switch is not a file being opened: its rows are
    // already on screen AND already on disk.
    adopted: !!opened.snapshot,
    onLoad: handleLoadedFile,
  });
  const fileLoading = filePhase !== 'active';
  // Mirrored for addFiles, whose closure is deliberately frozen (deps []) — reading the flag
  // directly there would read the first render's value forever.
  const fileLoadingRef = React.useRef(fileLoading);
  React.useEffect(() => { fileLoadingRef.current = fileLoading; });
  const expiryLabel = React.useMemo(() => {
    if (!fileRecord || fileRecord.keptAt !== null) return '';
    const days = daysUntilExpiry(fileRecord);
    return days === null ? '' : `Deletes in ${days} day${days === 1 ? '' : 's'}.`;
  }, [fileRecord]);

  /**
   * Display only. Compressing, the totals and the ZIP all read `items`, so a search typed to find
   * one file can never shrink the batch that runs or the archive that downloads.
   */
  const [search, setSearch] = React.useState('');
  const visibleItems = React.useMemo(() => {
    const terms = searchTerms(search);
    return terms.length ? items.filter((it) => matchesTerms([it.name], terms)) : items;
  }, [items, search]);

  const addFiles = React.useCallback((files: FileList | File[]) => {
    // Closed while the file loads, like every add-a-row path in the suite. Compress ids are
    // uuids so a mid-load drop cannot collide, but rows appearing inside a half-restored queue
    // is still a merge the user never asked for — and paste reaches here with no dropzone
    // between it and the queue. Read through a ref: this callback is deliberately stable.
    if (fileLoadingRef.current) return;
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
        name: file.name,
        inputSize: file.size,
        file,
        previewUrl: URL.createObjectURL(file),
        status: 'queued' as const,
      })),
    ]);
  }, []);

  // The unmount cleanup runs once, so its closure is the FIRST render's. Everything it needs is
  // mirrored here on every commit instead.
  const sessionRef = React.useRef<PngSession>({
    fileId: '',
    items,
    sessionName,
    colors,
    lossless,
  });
  React.useEffect(() => {
    sessionRef.current = { fileId, items, sessionName, colors, lossless };
  });

  // Leaving the product stops the run and hands back every object URL — a client-side route change
  // keeps the document alive, so nothing else would ever revoke them.
  React.useEffect(() => () => {
    abortRef.current?.abort();
    // Snapshot BEFORE revoking, and with BOTH urls stripped from every row — then revoke every
    // row. Carrying a url across would revive a queue pointing at revoked blob: URLs, the exact
    // trap lib/session-store.ts:60-69 documents, and it is the download link as much as the
    // thumbnail: an outputUrl kept while its object was revoked gives a button that saves nothing.
    // The File and the output Blob are what actually survive, so the mount below re-mints from
    // those.
    const snapshot = sessionRef.current;
    saveSession(PNG_SESSION, {
      ...snapshot,
      items: snapshot.items.map((it) => ({
        ...it,
        previewUrl: '',
        outputUrl: undefined,
        status: restingPngStatus(it),
      })),
    });
    snapshot.items.forEach(releasePngItem);
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
    async (item: PngItem, signal: AbortSignal) => {
      // A row restored from disk carries its result but not its source — inputs are never
      // persisted (see PngItem.file). Nothing routes such a row here today, because restored rows
      // arrive 'done' and only queued/errored ones are run; this says so out loud rather than
      // letting a future caller find out through a null dereference.
      if (!item.file) {
        patch(item.id, {
          status: 'error',
          error: 'Original not saved — drop the file again to re-compress it.',
        });
        return;
      }
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
      name: tinyName(it.name),
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
  const totalIn = items.reduce((s, it) => s + it.inputSize, 0);
  const totalOut = items.reduce(
    (s, it) => s + (it.output ? it.output.size : it.inputSize), 0,
  );

  const statusText = running
    ? progress?.text ?? 'Compressing…'
    : // A failing store is worth saying out loud even mid-batch: writes retry on their own, but
      // the user is entitled to know the results on screen are not safely on disk yet.
      fileFailing
      ? 'Autosave failing — retrying'
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
              disabled={fileLoading}
              onFiles={(files) => addFiles(files)}
            />
          ) : (
            <>
              <DropzoneShell accept="image/png" multiple disabled={fileLoading} onFiles={(files) => addFiles(files)}>
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
                  {search
                    ? `${visibleItems.length} of ${items.length} file${items.length === 1 ? '' : 's'}`
                    : `${items.length} file${items.length === 1 ? '' : 's'}${doneCount ? ` · ${doneCount} compressed` : ''}`}
                </span>
                <div className="flex items-center gap-2">
                  <QueueSearch value={search} onChange={setSearch} placeholder="Search files" />
                <ClearAllButton
                  title="Clear the queue?"
                  disabled={running || fileLoading}
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
              </div>
            {search && visibleItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                <p className="text-sm text-muted-foreground">
                  No files match &ldquo;{search}&rdquo;.
                </p>
                <Button variant="outline" size="sm" onClick={() => setSearch('')}>
                  Show all {items.length} file{items.length === 1 ? '' : 's'}
                </Button>
              </div>
            ) : (
            <ul className="flex flex-col gap-2">
              {visibleItems.map((it) => (
                <li
                  key={it.id}
                  className="flex items-center gap-3 rounded-lg border bg-card p-2 pr-3"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={it.outputUrl ?? it.previewUrl}
                    alt={it.name}
                    className="size-12 shrink-0 rounded border object-contain [background:repeating-conic-gradient(var(--muted)_0%_25%,transparent_0%_50%)_0_0/12px_12px]"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{it.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {it.status === 'done' && it.output
                        ? `${formatKb(it.inputSize)} → ${formatKb(it.output.size)}`
                        : formatKb(it.inputSize)}
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
                      variant={it.output.size < it.inputSize ? 'default' : 'secondary'}
                    >
                      −{savingsPct(it.inputSize, it.output.size)}%
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
                      render={<a href={it.outputUrl} download={tinyName(it.name)} />}
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
            )}
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
                    <FieldDescription>
                      Names the exported ZIP, and titles this batch on the Zigma home screen.
                    </FieldDescription>
                  </Field>
                  {/* The expiry rule has to be reachable from inside the tool. Compress has no
                      session header to hang a chip on, so it rides here, next to the name — the
                      one place this product already talks about the batch as a document. */}
                  {fileRecord && (
                    <Field className="mt-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">
                          {fileRecord.keptAt !== null
                            ? 'Kept — this batch will not be deleted.'
                            : expiryLabel}
                        </span>
                        <Toggle
                          size="sm"
                          variant="outline"
                          pressed={fileRecord.keptAt !== null}
                          onPressedChange={setFileKept}
                          title="Unkept batches are removed 7 days after their last change."
                        >
                          Keep
                        </Toggle>
                      </div>
                    </Field>
                  )}
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
