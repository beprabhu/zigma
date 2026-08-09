'use client';

// Image Generator — one generated image per CSV row, from a Markdown brief plus the row's own
// fields. Text-to-image, so it uses Azure's generations endpoint (via /api/generate's
// `mode: 'generations'`) rather than the edits endpoint the other two products drive.
//
// The prompt rule lives in lib/gen.ts and is surfaced verbatim in every cell and dialog: the
// product's whole value is "these columns, under this brief", so hiding the assembled string
// would make a bad result impossible to diagnose.

import * as React from 'react';
import { toast } from 'sonner';
import {
  DownloadIcon, ImagePlusIcon, SparklesIcon, UploadCloudIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { MdFileIcon, MdFileTile } from '@/components/md-file-tile';
import { SessionHeader, type SessionChip } from '@/components/session-header';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';

import { Canvas, LeftPanel, PanelSection, RightPanel, StudioShell } from '@/components/pane-layout';
import { GenDialog, GenGrid } from '@/components/image-generator/gen-grid';

import { detectTitleColumn, parseCSV, type CsvRecord } from '@/lib/csv';
import {
  PROMPT_WARN_CHARS, buildRowPrompt, createGenItems, genFileStem, isPromptEmpty,
  type GenItem,
} from '@/lib/gen';
import { callAzureGenerate, mockGenerate } from '@/lib/pipeline';
import { canvasToPngBlob, mapWithLimit, pickSave, releaseCanvas, saveTo } from '@/lib/bg/batch';
import { processImage } from '@/lib/process';
import { useProcessing } from '@/components/process-panel';
import { buildZip, type ZipFileEntry } from '@/lib/zip';
import { cn } from '@/lib/utils';
import { usePersistedState } from '@/hooks/use-persisted-state';

const NONE = '__none__';
const SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'] as const;
const QUALITIES = ['low', 'medium', 'high'] as const;
type GenSize = (typeof SIZES)[number];
type GenQuality = (typeof QUALITIES)[number];

export default function ImageGenerator() {
  // Azure credentials are the suite's shared pair — set them once in any product.
  const [endpoint] = usePersistedState('skuc_azureEndpoint', '');
  const [azureKey] = usePersistedState('skuc_azureKey', '');
  const [size, setSize] = usePersistedState<GenSize>('skuc_genSize', '1024x1024');
  const [quality, setQuality] = usePersistedState<GenQuality>('skuc_genQuality', 'low');
  const [parallel, setParallel] = usePersistedState('skuc_genParallel', 3);
  const [numberFiles, setNumberFiles] = usePersistedState('skuc_genNumberFiles', true);

  // Brief: session-only on purpose. It is document-sized and specific to one batch, so
  // persisting it would silently apply an old brief to a new CSV.
  const [brief, setBrief] = React.useState('');
  const [briefName, setBriefName] = React.useState<string | null>(null);
  // The brief renders as an .md tile in the panel; this opens its editor modal.
  const [briefEditorOpen, setBriefEditorOpen] = React.useState(false);

  const [csvName, setCsvName] = React.useState<string | null>(null);
  // Figma-style session name in the panel header; seeds the export ZIP filename. Auto-seeded
  // from the dropped CSV, but never over a name the user already typed.
  const [sessionName, setSessionName] = React.useState('');
  const sessionSlug = sessionName.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  const seedSessionName = React.useCallback((fileName: string) => {
    setSessionName((prev) => (prev.trim() ? prev : fileName.replace(/\.[^.]+$/, '')));
  }, []);
  const [headers, setHeaders] = React.useState<string[]>([]);
  const [records, setRecords] = React.useState<CsvRecord[]>([]);
  const [nameCol, setNameCol] = React.useState('');
  const [excluded, setExcluded] = React.useState<string[]>([]);

  const [items, setItems] = React.useState<GenItem[]>([]);
  const [running, setRunning] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [progress, setProgress] = React.useState<{ pct: number; text: string } | null>(null);
  const [openId, setOpenId] = React.useState<number | null>(null);
  const [drag, setDrag] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const resultScrollRef = React.useRef<HTMLDivElement>(null);

  const itemsRef = React.useRef<GenItem[]>(items);
  React.useEffect(() => { itemsRef.current = items; }, [items]);

  const mock = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('mock');
  const busy = running || exporting;
  const excludedSet = React.useMemo(() => new Set(excluded), [excluded]);

  const promptFor = React.useCallback(
    (item: GenItem) => buildRowPrompt(brief, headers, item.record, excludedSet),
    [brief, headers, excludedSet],
  );

  const proc = useProcessing({ prefix: 'skuc_gen', removeBg: true, tileFit: true, busy });

  const openItem = items.find((it) => it.id === openId) ?? null;
  const doneCount = items.filter((it) => it.status === 'done' && it.image).length;

  // Sampled from the first row: the brief dominates the length, so one row is representative
  // and this stays cheap no matter how long the CSV is.
  const sampleLength = items.length ? promptFor(items[0]).length : brief.trim().length;

  function patchItem(id: number, patch: Partial<GenItem>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  // ---- Input -------------------------------------------------------------

  function handleFiles(files: File[]) {
    for (const file of files) {
      const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv';
      const isDoc = /\.(md|markdown|txt)$/i.test(file.name);
      if (!isCsv && !isDoc) {
        toast.error(`${file.name}: drop a .md brief or a .csv of rows.`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result);
        if (isCsv) {
          const parsed = parseCSV(text);
          if (!parsed.headers.length || !parsed.records.length) {
            toast.error(`${file.name} appears empty.`);
            return;
          }
          // detectTitleColumn only matches title/name/product headers; a brief-driven CSV is
          // as likely to key on `sku` or `id`, so fall back to the first column rather than
          // leaving every row named "Row 1" and every export file numbered but anonymous.
          const detected = detectTitleColumn(parsed.headers, []) || parsed.headers[0] || '';
          setCsvName(file.name);
          seedSessionName(file.name);
          setHeaders(parsed.headers);
          setRecords(parsed.records);
          setNameCol(detected);
          setExcluded([]);
          setItems(createGenItems(parsed.records, detected, 0));
          setOpenId(null);
        } else {
          setBrief(text);
          setBriefName(file.name);
        }
      };
      reader.onerror = () => toast.error(`Could not read ${file.name}.`);
      reader.readAsText(file);
    }
  }

  /** Re-mapping the name column renames rows in place — generated images are never thrown away. */
  function remapNames(next: string) {
    setNameCol(next);
    setItems((prev) =>
      prev.map((it, i) => ({
        ...it,
        name: (next ? it.record[next] : '')?.trim() || `Row ${i + 1}`,
      })),
    );
  }

  function toggleColumn(header: string, include: boolean) {
    setExcluded((prev) => (include ? prev.filter((h) => h !== header) : [...prev, header]));
  }

  // ---- Generation --------------------------------------------------------

  function guards(): boolean {
    if (!items.length) return false;
    if (!mock && (!endpoint.trim() || !azureKey.trim())) {
      toast.error('Set the Azure endpoint and API key in Settings (gear at the bottom of the rail), or use ?mock=1.');
      return false;
    }
    return true;
  }

  async function generateOne(item: GenItem): Promise<boolean> {
    const prompt = buildRowPrompt(brief, headers, item.record, excludedSet);
    if (isPromptEmpty(prompt)) {
      patchItem(item.id, { status: 'error', errorMsg: 'Nothing to send — no brief and no included columns' });
      return false;
    }
    patchItem(item.id, { status: 'generating', errorMsg: undefined });
    const started = performance.now();
    try {
      const image = mock
        ? await mockGenerate(prompt)
        : await callAzureGenerate(prompt, { endpoint, apiKey: azureKey, size, quality });
      patchItem(item.id, {
        status: 'done',
        image,
        sentPrompt: prompt,
        durationMs: performance.now() - started,
        errorMsg: undefined,
      });
      return true;
    } catch (e) {
      patchItem(item.id, { status: 'error', errorMsg: (e as Error).message });
      return false;
    }
  }

  async function handleGenerateAll() {
    if (busy || !guards()) return;
    const todo = itemsRef.current;
    setRunning(true);
    // Groups of `parallel` in flight: the Azure round trip dominates each row's wall-clock, so
    // overlapping the waits is where a batch gets its speed. The ceiling is the deployment's
    // rate limit, which is what the setting expresses.
    const limit = Math.max(1, Math.min(8, parallel));
    let finished = 0;
    let ok = 0;
    setProgress({ pct: 0, text: `0 of ${todo.length} — ${limit} at a time with ${mock ? 'mock' : 'azure'}…` });
    await mapWithLimit(todo, limit, async (item) => {
      if (await generateOne(item)) ok++;
      finished++;
      setProgress({
        pct: (finished / todo.length) * 100,
        text: `${finished} of ${todo.length} — ${limit} at a time with ${mock ? 'mock' : 'azure'}…`,
      });
    });
    setProgress({ pct: 100, text: `Done — ${ok} of ${todo.length} images generated.` });
    setRunning(false);
  }

  async function handleRegenerate(id: number) {
    if (busy || !guards()) return;
    const item = itemsRef.current.find((it) => it.id === id);
    if (!item) return;
    setRunning(true);
    setProgress({ pct: 50, text: `Regenerating ${item.name}…` });
    const ok = await generateOne(item);
    setProgress({ pct: 100, text: ok ? `${item.name} regenerated.` : `${item.name} failed.` });
    setRunning(false);
  }

  function handleRemove(id: number) {
    setItems((prev) => prev.filter((it) => it.id !== id));
    setOpenId((prev) => (prev === id ? null : prev));
  }

  // ---- Export ------------------------------------------------------------

  async function handleExport() {
    const ready = itemsRef.current.filter((it) => it.status === 'done' && it.image);
    if (!ready.length || busy) return;
    const zipName = sessionSlug ? `${sessionSlug}-generated.zip` : 'generated-images.zip';
    const dest = await pickSave(zipName);
    if (dest === 'cancelled') return;

    setExporting(true);
    try {
      const files: ZipFileEntry[] = [];
      const used = new Map<string, number>();
      let n = 0;
      for (const item of ready) {
        const stem = genFileStem(item.name, `row-${item.id + 1}`);
        let fileName: string;
        if (numberFiles) {
          fileName = `${String(n + 1).padStart(2, '0')}-${stem}.png`;
        } else {
          const seen = (used.get(stem) ?? 0) + 1;
          used.set(stem, seen);
          fileName = seen === 1 ? `${stem}.png` : `${stem}-${seen}.png`;
        }
        const canvas = await processImage(item.image!, proc.steps);
        const blob = await canvasToPngBlob(canvas);
        releaseCanvas(canvas);
        const data = await proc.compressBytes(new Uint8Array(await blob.arrayBuffer()));
        files.push({ name: fileName, data });
        n++;
        setProgress({ pct: (n / ready.length) * 100, text: `Packing ${n} of ${ready.length}…` });
      }
      await saveTo(dest, buildZip(files), zipName);
      setProgress({ pct: 100, text: `Exported ${files.length} image${files.length > 1 ? 's' : ''}.` });
    } catch (e) {
      toast.error(`Export failed: ${(e as Error).message}`);
    } finally {
      setExporting(false);
    }
  }

  // ---- Render ------------------------------------------------------------

  const dropzone = (
    <div
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); handleFiles([...(e.dataTransfer.files ?? [])]); }}
      className={cn(
        'flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
        drag && 'border-primary bg-accent',
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".md,.markdown,.txt,.csv,text/csv,text/markdown"
        multiple
        hidden
        onChange={(e) => handleFiles([...(e.target.files ?? [])])}
      />
      <UploadCloudIcon className="size-6" />
      <span>Drop the brief (.md) and the rows (.csv), or click to browse</span>
      <span className="flex flex-wrap justify-center gap-2 text-xs">
        <span className={cn('rounded-md border px-2 py-0.5', briefName && 'border-primary text-foreground')}>
          <MdFileIcon className="mr-1 inline size-3" />
          {briefName ?? 'no brief'}
        </span>
        <span className={cn('rounded-md border px-2 py-0.5', csvName && 'border-primary text-foreground')}>
          {csvName ? `${csvName} — ${records.length} rows` : 'no CSV'}
        </span>
      </span>
    </div>
  );

  const runFooter = (
    <Button className="w-full" disabled={busy || !items.length} onClick={handleGenerateAll}>
      {running ? <Spinner data-icon="inline-start" /> : <SparklesIcon data-icon="inline-start" />}
      {items.length ? `Generate ${items.length} image${items.length > 1 ? 's' : ''}` : 'Generate'}
    </Button>
  );

  const exportFooter = (
    <div className="space-y-2">
      {progress && <Progress value={progress.pct} />}
      <p className="text-xs text-muted-foreground">
        {progress?.text || 'Generated images export as PNGs in a ZIP.'}
      </p>
      <Button className="w-full" disabled={busy || !doneCount} onClick={handleExport}>
        {exporting ? <Spinner data-icon="inline-start" /> : <DownloadIcon data-icon="inline-start" />}
        Export ZIP
      </Button>
    </div>
  );

  return (
    <div className="flex min-h-dvh flex-col">
      <StudioShell>
        <LeftPanel
          title="Setup"
          footer={runFooter}
          header={
            <SessionHeader
              name={sessionName}
              onNameChange={setSessionName}
              placeholder="Untitled run"
              product="Generate"
              chips={
                [
                  items.length > 0 && { label: `${items.length} row${items.length === 1 ? '' : 's'}` },
                  doneCount > 0 && { label: `${doneCount} generated` },
                  briefName !== null && {
                    label: brief.trim() ? 'brief loaded' : 'brief empty',
                    tone: (brief.trim() ? 'default' : 'warn') as SessionChip['tone'],
                  },
                ].filter(Boolean) as SessionChip[]
              }
            />
          }
        >
          <PanelSection title="Input" description={<>One image per CSV row. Each prompt is the brief followed by that row&rsquo;s
                fields, labelled with their column names.</>}>{dropzone}</PanelSection>

          {briefName !== null && (
            <PanelSection title="Brief">
              {/* Same .md tile as the BG Remover's prompt: the brief is configuration, so the
                  panel shows the file card and editing happens in the modal below. */}
              <MdFileTile
                name={briefName}
                text={brief}
                badge={brief.trim() ? `${brief.trim().length.toLocaleString()} chars` : 'empty'}
                onClick={() => setBriefEditorOpen(true)}
                disabled={busy}
              />
            </PanelSection>
          )}

          {headers.length > 0 && (
            <PanelSection title={<>Columns — {csvName}</>} description={<>Ticked columns are sent, each labelled with its header.</>}>
                <FieldGroup className="gap-4">
                  <Field>
                    <FieldLabel htmlFor="gen-name-col">Name column</FieldLabel>
                    <Select
                      value={nameCol || NONE}
                      onValueChange={(v) => remapNames(String(v ?? '') === NONE ? '' : String(v ?? ''))}
                      disabled={busy}
                    >
                      <SelectTrigger id="gen-name-col">
                        <SelectValue>
                          {(value) => (value === NONE || !value ? '(Row number)' : String(value))}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>(Row number)</SelectItem>
                        {headers.map((h) => (
                          <SelectItem key={h} value={h}>{h}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      Names the cells and the exported files. Safe to change any time — rows are
                      renamed in place and generated images are kept.
                    </FieldDescription>
                  </Field>

                  <Field>
                    <FieldLabel>Send in the prompt</FieldLabel>
                    <div className="flex flex-col gap-2">
                      {headers.map((h) => (
                        <label key={h} className="flex cursor-pointer items-center gap-2 text-sm">
                          <Checkbox
                            checked={!excludedSet.has(h)}
                            disabled={busy}
                            onCheckedChange={(checked) => toggleColumn(h, checked === true)}
                          />
                          <span className="truncate">{h}</span>
                        </label>
                      ))}
                    </div>
                    <FieldDescription>
                      Untick anything the model should not see — internal IDs, statuses, links.
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              </PanelSection>
          )}

          <PanelSection title="Model" description={<>Calls Azure GPT-Image&rsquo;s generations endpoint. Credentials live in
                Settings — the gear at the bottom of the rail.</>}>
              <FieldGroup className="gap-4">
                <Field>
                  <FieldLabel htmlFor="gen-size">Size</FieldLabel>
                  <Select value={size} onValueChange={(v) => setSize(String(v ?? '1024x1024') as GenSize)} disabled={busy}>
                    <SelectTrigger id="gen-size">
                      <SelectValue>{(v) => String(v ?? '1024x1024')}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {SIZES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    With no input image to follow, &ldquo;auto&rdquo; lets the model choose the
                    shape — pick a size for a consistent set.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="gen-quality">Quality</FieldLabel>
                  <Select value={quality} onValueChange={(v) => setQuality(String(v ?? 'low') as GenQuality)} disabled={busy}>
                    <SelectTrigger id="gen-quality">
                      <SelectValue>{(v) => String(v ?? 'low')}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {QUALITIES.map((q) => <SelectItem key={q} value={q}>{q}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="gen-parallel">Parallel requests</FieldLabel>
                  <Input
                    id="gen-parallel"
                    type="number"
                    min={1}
                    max={8}
                    className="w-24"
                    value={parallel}
                    disabled={busy}
                    onChange={(e) => setParallel(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
                  />
                  <FieldDescription>
                    Rows generated at once. Raise it until the deployment&rsquo;s rate limit
                    pushes back (429s), then step down one.
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </PanelSection>
        </LeftPanel>

        <Canvas scrollRef={resultScrollRef}>
          {sampleLength > PROMPT_WARN_CHARS && (
            <p className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              A row&rsquo;s prompt is about {sampleLength.toLocaleString()} characters — Azure
              rejects very long prompts. Shorten the brief or untick a column.
            </p>
          )}
          {items.length === 0 ? (
            <Empty className="h-full min-h-60">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ImagePlusIcon />
                </EmptyMedia>
                <EmptyTitle>No rows yet</EmptyTitle>
                <EmptyDescription>
                  Drop a Markdown brief and a CSV. Every row becomes one image, prompted with the
                  brief plus that row&rsquo;s own columns.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <GenGrid
              items={items}
              promptFor={promptFor}
              running={busy}
              onOpen={setOpenId}
              onRemove={handleRemove}
            />
          )}
        </Canvas>

        <RightPanel
          title="Process & export"
          footer={exportFooter}
        >
          {proc.panel}
          <PanelSection>
          <FieldGroup className="gap-4">
                <Field orientation="horizontal">
                  <Checkbox
                    id="gen-number-files"
                    checked={numberFiles}
                    disabled={busy}
                    onCheckedChange={(checked) => setNumberFiles(checked === true)}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="gen-number-files" className="font-normal">
                      Number exported files
                    </FieldLabel>
                    <FieldDescription>
                      {numberFiles
                        ? 'Files are named 01-name.png.'
                        : 'Files use the name alone; repeats get -2, -3 so nothing is overwritten.'}
                    </FieldDescription>
                  </FieldContent>
                </Field>
          </FieldGroup>
          </PanelSection>
        </RightPanel>
      </StudioShell>

      <GenDialog
        item={openItem}
        previewPrompt={openItem ? promptFor(openItem) : ''}
        running={busy}
        onClose={() => setOpenId(null)}
        onRegenerate={handleRegenerate}
      />

      {/* Brief editor — the .md tile in the Input card opens this. */}
      <Dialog open={briefEditorOpen} onOpenChange={setBriefEditorOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MdFileIcon className="size-4 text-muted-foreground" />
              {briefName ?? 'Brief'}
            </DialogTitle>
            <DialogDescription>
              The brief leads every row&rsquo;s prompt. Edits apply to the next run — rows
              already generated keep the prompt they were built from.
            </DialogDescription>
          </DialogHeader>
          {/* Capped: the textarea auto-grows with content (field-sizing-content), so a long
              brief would otherwise push the dialog past the viewport. */}
          <Textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={16}
            disabled={busy}
            aria-label="Markdown brief"
            className="max-h-[55dvh] min-h-40 overflow-y-auto text-xs"
          />
          <DialogFooter>
            <Button onClick={() => setBriefEditorOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
