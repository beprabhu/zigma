'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { ChevronDownIcon, DownloadIcon, ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/hint';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

import { TemplateEditor } from '@/components/template-editor';
import { CsvDropzone } from '@/components/csv-dropzone';
import { SessionHeader, type SessionChip } from '@/components/session-header';
import { TileGrid, TileDialog } from '@/components/tile-grid';
import { Canvas, LeftPanel, PanelSection, RightPanel, StudioShell } from '@/components/pane-layout';
import { useProcessing } from '@/components/process-panel';

import { DEFAULT_TEMPLATE, TileTemplate, tileToPngBlob } from '@/lib/tile';
import { parseCSV, detectImageColumns, detectTitleColumn, detectOfferColumn, CsvRecord } from '@/lib/csv';
import { buildZip, ZipFileEntry } from '@/lib/zip';
import { loadImageFromUrl, callAzure, mockComposite } from '@/lib/pipeline';
import {
  BG_MODELS, BG_MODEL_ORDER, DEFAULT_MODEL_ID, probeServerModel, removeBackground, type BgModelId,
} from '@/lib/bg/engine';
import { mapWithLimit, pickSave, saveTo } from '@/lib/bg/batch';
import { describeBudget, fitToBudget, type BudgetResult } from '@/lib/bg/budget';
import { isPng8Supported } from '@/lib/bg/png8';
import { TILE_PRESETS } from '@/lib/bg/safe-area';
import { QueueItem, DEFAULT_ENDPOINT, DEFAULT_PROMPT } from '@/lib/types';
import { usePersistedState } from '@/hooks/use-persisted-state';

const NONE = '__none__';
// Bounds how many tile canvases encode at once on export; TinyPNG stays narrower (rate limits).
const ENCODE_CONCURRENCY = 8;
const COMPRESS_CONCURRENCY = 4;

// The tile renderer draws an HTMLImageElement, so a cutout canvas has to be re-encoded.
// The load must be awaited: drawing an undecoded image paints nothing.
function canvasToImage(canvas: HTMLCanvasElement): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Cutout decode failed'));
    img.src = canvas.toDataURL('image/png');
  });
}

export default function Compositor() {
  // Template + defaults
  const [template, setTemplate] = usePersistedState<TileTemplate>('skuc_template', DEFAULT_TEMPLATE);
  const [tplTitle, setTplTitle] = React.useState('Tile name');
  const [tplOffer, setTplOffer] = React.useState('20% OFF');
  const [offerVisible, setOfferVisible] = React.useState(true);

  // Keys / prompt
  const [endpoint] = usePersistedState('skuc_azureEndpoint', DEFAULT_ENDPOINT);
  const [azureKey] = usePersistedState('skuc_azureKey', '');
  const [parallel, setParallel] = usePersistedState('skuc_azureParallel', 3);
  // The CDN ceiling is one rule for the whole suite, so these keys are the BG remover's own.
  const [budgetOn, setBudgetOn] = usePersistedState('skuc_bgBudgetOn', false);
  const [budgetKb, setBudgetKb] = usePersistedState('skuc_bgBudgetKb', 150);
  const [budgetShrink, setBudgetShrink] = usePersistedState('skuc_bgBudgetShrink', true);
  const [numberFiles, setNumberFiles] = usePersistedState('skuc_coNumberFiles', true);
  const [prompt, setPrompt] = usePersistedState('skuc_prompt', DEFAULT_PROMPT);
  const [promptOpen, setPromptOpen] = React.useState(false);

  // Background removal
  const [removeBg, setRemoveBg] = usePersistedState('skuc_removeBg', false);
  const [bgModel, setBgModel] = usePersistedState<BgModelId>('skuc_bgModel', DEFAULT_MODEL_ID);
  // null until the probe answers, so nothing claims "offline" before we know.
  const [bgServerUp, setBgServerUp] = React.useState<boolean | null>(null);

  // RMBG-2.0 runs on the optional Python sidecar — probe once so the picker can
  // grey it out instead of failing mid-run.
  React.useEffect(() => {
    const ac = new AbortController();
    probeServerModel(ac.signal).then(setBgServerUp, () => setBgServerUp(false));
    return () => ac.abort();
  }, []);

  // skuc_bgModel is shared with the bg-remover and hydrated straight from localStorage, so the
  // id can be stale (a model that no longer exists) or momentarily unusable (rmbg2 while the
  // sidecar is down). Both are resolved here rather than written back, so the stored choice
  // returns by itself the moment the sidecar answers again.
  const knownModel = BG_MODELS[bgModel] ? bgModel : DEFAULT_MODEL_ID;
  const serverBlocked = bgServerUp === false && BG_MODELS[knownModel].server === true;
  const activeModel = serverBlocked ? DEFAULT_MODEL_ID : knownModel;

  // CSV
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [headers, setHeaders] = React.useState<string[]>([]);
  const [records, setRecords] = React.useState<CsvRecord[]>([]);
  // Figma-style session name in the panel header; seeds the export ZIP filename. Auto-seeded
  // from the dropped CSV, but never over a name the user already typed.
  const [sessionName, setSessionName] = React.useState('');
  const sessionSlug = sessionName.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  const [imageCols, setImageCols] = React.useState<string[]>([]);
  const [titleCol, setTitleCol] = React.useState('');
  const [offerCol, setOfferCol] = React.useState('');

  // Queue / run state
  const [items, setItems] = React.useState<QueueItem[]>([]);
  const [running, setRunning] = React.useState(false);
  const [progress, setProgress] = React.useState<{ pct: number; text: string } | null>(null);
  const [compressSummary, setCompressSummary] = React.useState('');

  // The dialog holds an id, not an item object: rows are replaced on every status patch, and
  // resolving the id at render time is what lets the open dialog update live mid-regenerate.
  const [openId, setOpenId] = React.useState<number | null>(null);
  const openItem = items.find((it) => it.id === openId) ?? null;

  const canvases = React.useRef(new Map<number, HTMLCanvasElement>());
  const registerCanvas = React.useCallback((id: number, canvas: HTMLCanvasElement | null) => {
    if (canvas) canvases.current.set(id, canvas);
    else canvases.current.delete(id);
  }, []);

  const proc = useProcessing({ prefix: 'skuc_co', busy: running });

  const mock = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('mock');
  // The proxy keeps only this field's origin; showing the result keeps that from being silent.

  // isPng8Supported() reads a browser global, so it must not decide the server-rendered markup.
  const png8Ready = React.useSyncExternalStore(
    React.useCallback(() => () => {}, []),
    isPng8Supported,
    () => false,
  );
  const budgetActive = budgetOn && png8Ready;
  const budgetKbSafe = Number.isFinite(budgetKb) ? Math.max(50, Math.round(budgetKb)) : 150;

  // ---- CSV ----
  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const { headers, records } = parseCSV(String(reader.result));
      if (!headers.length || !records.length) { toast.error('CSV appears empty.'); return; }
      const imgCols = detectImageColumns(headers, records);
      const tCol = detectTitleColumn(headers, imgCols);
      const oCol = detectOfferColumn(headers, imgCols);
      setFileName(file.name);
      setSessionName((prev) => (prev.trim() ? prev : file.name.replace(/\.[^.]+$/, '')));
      setHeaders(headers);
      setRecords(records);
      setImageCols(imgCols);
      setTitleCol(tCol);
      setOfferCol(oCol);
      setItems(buildQueue(records, imgCols, tCol, oCol));
    };
    reader.readAsText(file);
  }

  function buildQueue(records: CsvRecord[], imageCols: string[], titleCol: string, offerCol: string): QueueItem[] {
    return records.map((record, i) => {
      const urls = imageCols.map((c) => record[c]).filter((u) => /^https?:\/\//i.test(u || ''));
      return {
        id: i, record, urls,
        title: titleCol ? record[titleCol] : '',
        offer: offerCol ? record[offerCol] : '',
        status: urls.length ? 'ready' : 'no-images',
        resultImage: null,
        compressed: null,
      };
    });
  }

  function updateMapping(next: { imageCols?: string[]; titleCol?: string; offerCol?: string }) {
    const ic = next.imageCols ?? imageCols;
    const tc = next.titleCol ?? titleCol;
    const oc = next.offerCol ?? offerCol;
    if (next.imageCols) setImageCols(ic);
    if (next.titleCol !== undefined) setTitleCol(tc);
    if (next.offerCol !== undefined) setOfferCol(oc);
    setItems(buildQueue(records, ic, tc, oc));
  }

  // ---- Generation ----
  // Azure round trips overlap freely, but background removal runs on the main thread through a
  // single model instance — two inferences interleaved through one session is undefined
  // behaviour. This chain lets exactly one removal run at a time while the network stays busy.
  const bgLock = React.useRef<Promise<unknown>>(Promise.resolve());

  function patchItem(id: number, patch: Partial<QueueItem>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  async function generateItem(item: QueueItem) {
    patchItem(item.id, { status: 'fetching', errorMsg: undefined });
    const images: HTMLImageElement[] = [];
    for (const u of item.urls) images.push(await loadImageFromUrl(u));
    patchItem(item.id, { status: 'generating' });
    let resultImage: HTMLImageElement;
    if (mock) {
      await new Promise((r) => setTimeout(r, 600));
      resultImage = await mockComposite(images);
    } else {
      resultImage = await callAzure(images, { endpoint, apiKey: azureKey, prompt });
    }
    if (removeBg) {
      patchItem(item.id, { status: 'removing-bg' });
      // Yield once so the badge paints before inference blocks the main thread.
      await new Promise((r) => setTimeout(r, 0));
      try {
        // zoomPass runs a whole second inference to sharpen edges at ~2x resolution. Tiles
        // export at 600px wide, where that detail is invisible, so it is not worth doubling
        // the wall-clock of every row in a CSV.
        const turn = bgLock.current.then(() =>
          removeBackground(resultImage, {
            model: activeModel,
            refine: false,
            zoomPass: false,
          }),
        );
        bgLock.current = turn.catch(() => {});
        const { canvas } = await turn;
        resultImage = await canvasToImage(canvas);
      } catch (e) {
        // A missing model or a downed sidecar must not cost us the composite.
        toast.warning(`Row ${item.id + 1}: tile generated without background removal — ${(e as Error).message}`);
      }
    }
    patchItem(item.id, { status: 'done', resultImage, compressed: null });
  }

  async function handleGenerateAll() {
    if (running) return;
    if (!mock && (!endpoint.trim() || !azureKey.trim())) {
      toast.error('Set the Azure endpoint and API key in Settings (gear at the bottom of the rail), or use ?mock=1.');
      return;
    }
    const todo = items.filter((it) => it.urls.length);
    if (!todo.length) return;

    setRunning(true);
    // Groups of `parallel` requests in flight at once: the Azure round trip dominates a tile's
    // wall-clock, so overlapping the waits is where a batch gets its speed. The ceiling is the
    // deployment's rate limit, which is exactly what the setting expresses.
    const limit = Math.max(1, Math.min(8, parallel));
    let done = 0;
    let finished = 0;
    setProgress({ pct: 0, text: `0 of ${todo.length} tiles — ${limit} at a time with ${mock ? 'mock' : 'azure'}…` });
    await mapWithLimit(todo, limit, async (item) => {
      try {
        await generateItem(item);
        done++;
      } catch (e) {
        patchItem(item.id, { status: 'error', errorMsg: (e as Error).message });
      }
      finished++;
      setProgress({
        pct: (finished / todo.length) * 100,
        text: `${finished} of ${todo.length} tiles — ${limit} at a time with ${mock ? 'mock' : 'azure'}…`,
      });
    });
    setProgress({ pct: 100, text: `Done — ${done} of ${todo.length} tiles generated.` });
    setRunning(false);
  }

  async function handleRegenerate(item: QueueItem) {
    if (running) return;
    setRunning(true);
    setProgress({ pct: 50, text: `Regenerating row ${item.id + 1}…` });
    try {
      await generateItem(item);
      setProgress({ pct: 100, text: `Row ${item.id + 1} regenerated.` });
    } catch (e) {
      patchItem(item.id, { status: 'error', errorMsg: (e as Error).message });
      setProgress({ pct: 100, text: `Row ${item.id + 1} failed: ${(e as Error).message}` });
    }
    setRunning(false);
  }

  // ---- Export: budget → shared local compress → ZIP, one action ----
  async function handleExport() {
    const done = items.filter((it) => it.status === 'done' && canvases.current.has(it.id));
    if (!done.length) return;
    // Save dialog first, while the click still counts as user activation — TinyPNG passes can
    // take minutes, after which Chrome would refuse to open it. Cancelling cancels the export.
    const zipName = sessionSlug ? `${sessionSlug}-tiles.zip` : 'sku-tiles.zip';
    const dest = await pickSave(zipName);
    if (dest === 'cancelled') return;

    setRunning(true);
    // Snapshotted once: editing the ceiling mid-export must not give the ZIP two different rules.
    const budget = budgetActive
      ? { maxBytes: budgetKbSafe * 1024, allowDownscale: budgetShrink, dither: false }
      : null;
    const files: ZipFileEntry[] = [];
    let inTotal = 0, outTotal = 0, failed = 0;
    let budgetSummary = '';
    // Encoding and zipping can throw (toBlob returning null, an allocation failure on a big
    // batch); without the finally, `running` would stay true and wedge both buttons.
    try {
      // canvas.toBlob's latency is per-call and overlaps across calls, so encoding tiles one at
      // a time made a big batch wait many times over for work that costs the same done at once.
      // The limit bounds how many tile canvases are encoding simultaneously.
      let encoded = 0;
      const outcomes = new Array<BudgetResult | null>(done.length).fill(null);
      const raw = await mapWithLimit(done, ENCODE_CONCURRENCY, async (item, n) => {
        // The cached TinyPNG bytes were negotiated under no budget, so a budgeted run encodes
        // fresh from the canvas instead of trusting them.
        if (!budget && item.compressed) return item.compressed.data;
        const canvas = canvases.current.get(item.id)!;
        let data: Uint8Array;
        if (budget) {
          const result = await fitToBudget(canvas, budget);
          outcomes[n] = result;
          data = result.bytes;
        } else {
          const blob = await tileToPngBlob(canvas);
          data = new Uint8Array(await blob.arrayBuffer());
        }
        encoded++;
        setProgress({ pct: (encoded / done.length) * 50, text: `Encoding tile ${encoded} of ${done.length}…` });
        return data;
      });

      // The processing space's shared compress step (pngquant + oxipng, local). A failure
      // keeps the uncompressed PNG for that tile rather than sinking the export.
      let sent = 0;
      const finalBytes = await mapWithLimit(raw, COMPRESS_CONCURRENCY, async (data, n) => {
        const item = done[n];
        if (!proc.compressOn || (!budget && item.compressed)) return data;
        try {
          const out = await proc.compressBytes(data);
          patchItem(item.id, { compressed: { data: out, inputSize: data.length } });
          inTotal += data.length;
          outTotal += out.length;
          return out;
        } catch (e) {
          failed++;
          toast.error(`Row ${item.id + 1}: ${(e as Error).message}`);
          // fall back to the uncompressed PNG for this tile
          return data;
        } finally {
          sent++;
          setProgress({ pct: 50 + (sent / done.length) * 50, text: `Compressing tile ${sent} of ${done.length}…` });
        }
      });

      const used = new Map<string, number>();
      done.forEach((item, n) => {
        const base = (item.title || `tile-${item.id + 1}`).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || `tile-${item.id + 1}`;
        let name: string;
        if (numberFiles) {
          name = `${String(item.id + 1).padStart(2, '0')}-${base}.png`;
        } else {
          // Repeated titles get -2, -3 so nothing in the ZIP is silently overwritten.
          const seen = (used.get(base) ?? 0) + 1;
          used.set(base, seen);
          name = seen === 1 ? `${base}.png` : `${base}-${seen}.png`;
        }
        files.push({ name, data: finalBytes[n] });
      });

      // Degradation is never silent: a shrunk tile must not be a CDN surprise.
      if (budget) {
        let quantised = 0;
        const shrunk: { item: QueueItem; result: BudgetResult }[] = [];
        const over: { item: QueueItem; result: BudgetResult }[] = [];
        outcomes.forEach((result, n) => {
          if (!result) return;
          if (result.colors !== null && result.scale === 1) quantised++;
          if (result.scale < 1) shrunk.push({ item: done[n], result });
          if (!result.withinBudget) over.push({ item: done[n], result });
        });
        const parts = [`budget ${budgetKbSafe} KB`];
        if (quantised) parts.push(`${quantised} quantised`);
        if (shrunk.length) parts.push(`${shrunk.length} downscaled`);
        if (over.length) parts.push(`${over.length} over budget`);
        budgetSummary = parts.join(' · ');
        setCompressSummary(budgetSummary);
        const flagged = over.length ? over : shrunk;
        if (flagged.length) {
          const names = flagged
            .slice(0, 3)
            .map(({ item, result }) => `${item.title || `row ${item.id + 1}`} (${describeBudget(result)})`)
            .join(', ');
          toast.warning(
            over.length
              ? `${over.length} tile${over.length === 1 ? '' : 's'} still over budget: ${names}`
              : `${shrunk.length} tile${shrunk.length === 1 ? '' : 's'} downscaled to fit: ${names}`,
          );
        }
      }

      if (outTotal) {
        setCompressSummary(`Compressed: ${(inTotal / 1024).toFixed(1)} KB → ${(outTotal / 1024).toFixed(1)} KB (saved ${Math.round((1 - outTotal / inTotal) * 100)}%)`);
      }
      // The budget verdict rides on the final line — the footer shows progress text first, so
      // a separate summary would be invisible behind it.
      setProgress({
        pct: 100,
        text:
          (failed
            ? `Exported with ${failed} compression failure${failed > 1 ? 's' : ''} (those tiles are uncompressed).`
            : `Exported ${files.length} tile${files.length > 1 ? 's' : ''}.`) +
          (budgetSummary ? ` · ${budgetSummary}` : ''),
      });

      const zip = buildZip(files);
      await saveTo(dest, zip, zipName);
    } catch (e) {
      toast.error(`Export failed: ${(e as Error).message}`);
      setProgress({ pct: 100, text: `Export failed: ${(e as Error).message}` });
    } finally {
      setRunning(false);
    }
  }

  // Template edits invalidate compressed outputs.
  function handleTemplateChange(tpl: TileTemplate) {
    setTemplate(tpl);
    setItems((prev) => prev.map((it) => (it.compressed ? { ...it, compressed: null } : it)));
    setCompressSummary('');
  }

  const doneCount = items.filter((it) => it.status === 'done').length;
  const canGenerate = items.some((it) => it.urls.length);

  return (
    <div className="flex min-h-dvh flex-col">

      <StudioShell>
        <LeftPanel
          title="Design & Generate"
          header={
            <SessionHeader
              name={sessionName}
              onNameChange={setSessionName}
              placeholder="Untitled batch"
              product="Banners"
              chips={
                [
                  records.length > 0 && { label: `${records.length} row${records.length === 1 ? '' : 's'}` },
                  items.length > 0 && { label: `${doneCount}/${items.length} tiles` },
                ].filter(Boolean) as SessionChip[]
              }
            />
          }
          footer={
            <Button className="w-full" disabled={!canGenerate || running} onClick={handleGenerateAll}>
              {running && <Spinner data-icon="inline-start" />}
              Generate &amp; Populate
            </Button>
          }
        >
          <PanelSection title="Template" hint="Click a layer in the preview to edit it." className="space-y-4">
              <TemplateEditor
                template={template}
                onChange={handleTemplateChange}
                onReset={() => handleTemplateChange(structuredClone(DEFAULT_TEMPLATE))}
                previewTitle={tplTitle}
                previewOffer={tplOffer}
                previewOfferVisible={offerVisible}
              >
                <FieldGroup className="grid grid-cols-2 gap-3">
                  <Field>
                    <FieldLabel htmlFor="tpl-title">Tile name</FieldLabel>
                    <Input id="tpl-title" value={tplTitle} onChange={(e) => setTplTitle(e.target.value)} />
                  </Field>
                  <Field>
                    {/* The show/hide toggle lives on the offer label — it controls this text. */}
                    <div className="flex items-center justify-between">
                      <FieldLabel htmlFor="tpl-offer">Offer text</FieldLabel>
                      <FieldLabel htmlFor="offer-visible" className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
                        <Checkbox
                          id="offer-visible"
                          checked={offerVisible}
                          onCheckedChange={(c) => setOfferVisible(c === true)}
                        />
                        Show
                      </FieldLabel>
                    </div>
                    <Input
                      id="tpl-offer"
                      value={tplOffer}
                      disabled={!offerVisible}
                      onChange={(e) => setTplOffer(e.target.value)}
                    />
                  </Field>
                </FieldGroup>
              </TemplateEditor>
            </PanelSection>
          <PanelSection title="CSV file">
              <CsvDropzone fileName={fileName} rowCount={records.length} onFile={handleFile} />
            </PanelSection>

          {headers.length > 0 && (
            <PanelSection title="Settings">
                <Tabs defaultValue="auto">
                  <TabsList>
                    <TabsTrigger value="auto">Auto</TabsTrigger>
                    <TabsTrigger value="custom">Custom</TabsTrigger>
                  </TabsList>
                  <TabsContent value="auto" className="text-xs text-muted-foreground">
                    Image columns: <strong className="text-foreground">{imageCols.join(', ') || 'none detected'}</strong>
                    <br />
                    Title column: <strong className="text-foreground">{titleCol || 'none'}</strong>
                    {' · '}
                    Offer column: <strong className="text-foreground">{offerCol || 'none'}</strong>
                  </TabsContent>
                  <TabsContent value="custom">
                    <FieldGroup className="gap-4">
                      <Field>
                        <FieldLabel>Image URL columns</FieldLabel>
                        {headers.map((h) => (
                          <Field key={h} orientation="horizontal">
                            <Checkbox
                              id={`col-${h}`}
                              checked={imageCols.includes(h)}
                              onCheckedChange={(c) => updateMapping({
                                imageCols: c === true
                                  ? [...imageCols, h]
                                  : imageCols.filter((x) => x !== h),
                              })}
                            />
                            <FieldLabel htmlFor={`col-${h}`} className="font-normal">{h}</FieldLabel>
                          </Field>
                        ))}
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="title-col">Title column</FieldLabel>
                        <Select
                          value={titleCol || NONE}
                          onValueChange={(v) => updateMapping({ titleCol: v === NONE ? '' : String(v ?? '') })}
                        >
                          {/* Select.Value renders the raw value, so the sentinel needs a label. */}
                          <SelectTrigger id="title-col" className="w-full">
                            <SelectValue>{(v) => (v && v !== NONE ? String(v) : '(none)')}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>(none)</SelectItem>
                            {headers.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="offer-col">Offer / discount column</FieldLabel>
                        <Select
                          value={offerCol || NONE}
                          onValueChange={(v) => updateMapping({ offerCol: v === NONE ? '' : String(v ?? '') })}
                        >
                          <SelectTrigger id="offer-col" className="w-full">
                            <SelectValue>{(v) => (v && v !== NONE ? String(v) : '(none)')}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>(none)</SelectItem>
                            {headers.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </Field>
                    </FieldGroup>
                  </TabsContent>
                </Tabs>
              </PanelSection>
          )}

          {/* Prompt is tuned rarely — collapsed by default. */}
          <PanelSection>
              <Collapsible open={promptOpen} onOpenChange={setPromptOpen}>
                <CollapsibleTrigger className="group flex w-full items-center justify-between text-left">
                  <span className="text-sm font-medium">Prompt</span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {promptOpen ? 'Hide' : 'Edit'}
                    <ChevronDownIcon className="size-4 transition-transform group-aria-expanded:rotate-180" />
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <Textarea
                    className="mt-3"
                    rows={7}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                  />
                </CollapsibleContent>
              </Collapsible>
            </PanelSection>

          <PanelSection title="Background">
              <FieldGroup className="gap-4">
                <Field orientation="horizontal">
                  <Checkbox
                    id="remove-bg"
                    checked={removeBg}
                    onCheckedChange={(c) => setRemoveBg(c === true)}
                  />
                  <FieldLabel htmlFor="remove-bg" className="font-normal">
                    Remove background from generated tiles
                  </FieldLabel>
                </Field>
                <Field>
                  <FieldLabel htmlFor="bg-model">Model</FieldLabel>
                  <Select
                    value={activeModel}
                    onValueChange={(v) => {
                      const id = String(v ?? '') as BgModelId;
                      if (BG_MODELS[id]) setBgModel(id);
                    }}
                  >
                    {/* Select.Value renders the raw value unless it is told how to label it. */}
                    <SelectTrigger id="bg-model" className="w-full" disabled={!removeBg}>
                      <SelectValue>
                        {(value) => BG_MODELS[value as BgModelId]?.label ?? 'Choose a model'}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {BG_MODEL_ORDER.map((id) => {
                        const offline = BG_MODELS[id].server === true && bgServerUp !== true;
                        return (
                          <SelectItem key={id} value={id} disabled={offline}>
                            {BG_MODELS[id].label}{offline ? ' — server offline' : ''}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    {serverBlocked
                      ? `${BG_MODELS[knownModel].label} needs its local sidecar — using ${BG_MODELS[activeModel].label} until it answers.`
                      : BG_MODELS[activeModel].description}
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </PanelSection>

          <PanelSection title="Requests" hint="Azure credentials moved to Settings — the gear at the bottom of the rail.">
              <FieldGroup className="gap-4">
                <Field>
                  <FieldLabel htmlFor="azure-parallel">
                    <Hint hint="Tiles generated at once. Raise it until the deployment’s rate limit pushes back (429s), then step down one.">Parallel requests</Hint>
                  </FieldLabel>
                  <Input
                    id="azure-parallel"
                    type="number"
                    min={1}
                    max={8}
                    className="w-24"
                    value={parallel}
                    onChange={(e) => setParallel(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
                  />
                </Field>
              </FieldGroup>
            </PanelSection>

        </LeftPanel>

        <Canvas>

            {items.length === 0 ? (
              <Empty className="h-full min-h-40">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <ImageIcon />
                  </EmptyMedia>
                  <EmptyTitle>No tiles yet</EmptyTitle>
                  <EmptyDescription>
                    Upload a CSV and select Generate &amp; Populate to fill this pane.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <TileGrid
                items={items}
                template={template}
                fallbackTitle={tplTitle}
                fallbackOffer={tplOffer}
                offerToggle={offerVisible}
                hasOfferCol={!!offerCol}
                running={running}
                registerCanvas={registerCanvas}
                onOpen={(item) => setOpenId(item.id)}
                onRemove={(item) => {
                  setItems((prev) => prev.filter((it) => it.id !== item.id));
                  setOpenId((prev) => (prev === item.id ? null : prev));
                }}
              />
            )}
        </Canvas>

        <RightPanel
          title="Export"
          footer={
            <div className="space-y-2">
              {/* No children: the Progress root renders its own track+indicator;
                  passing another track duplicates the bar. */}
              {progress && <Progress value={progress.pct} />}
              <p className="text-xs break-words text-muted-foreground">
                {progress?.text
                  || compressSummary
                  || (proc.compressOn ? 'Tiles are compressed locally on export.' : 'Turn on Compress PNGs to shrink the ZIP.')}
              </p>
              <Button className="w-full" disabled={running || !doneCount} onClick={handleExport}>
                {running ? <Spinner data-icon="inline-start" /> : <DownloadIcon data-icon="inline-start" />}
                Export ZIP
              </Button>
            </div>
          }
        >
          {proc.panel}
          <PanelSection>
          <FieldGroup className="gap-4">
                    <Field>
                      <FieldLabel>
                        <Hint hint="Sets the template frame — fine-tune width, height and corners in the Design pane. Layers keep their positions, so check the preview after a big jump.">Tile size</Hint>
                      </FieldLabel>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {TILE_PRESETS.map((preset) => (
                          <Button
                            key={preset.id}
                            size="sm"
                            variant={
                              template.frame.width === preset.width && template.frame.height === preset.height
                                ? 'default'
                                : 'outline'
                            }
                            disabled={running}
                            onClick={() =>
                              setTemplate((t) => ({
                                ...t,
                                frame: { ...t.frame, width: preset.width, height: preset.height },
                              }))
                            }
                          >
                            {preset.width}×{preset.height}
                          </Button>
                        ))}
                      </div>
                    </Field>

                    <Field orientation="horizontal">
                      <Switch
                        id="co-budget-on"
                        checked={budgetOn}
                        disabled={running || !png8Ready}
                        onCheckedChange={(checked) => setBudgetOn(checked === true)}
                        className="mt-0.5"
                      />
                      <FieldContent>
                        <FieldLabel htmlFor="co-budget-on" className="font-normal">
                          <Hint hint="Colours go first — full colour, then a 256 · 128 · 64 · 32 palette — and the export stops at the first step that fits. Shared setting with Cleanup.">Limit file size</Hint>
                        </FieldLabel>
                        {!png8Ready && (
                          <FieldDescription>
                            Not available: this browser lacks CompressionStream.
                          </FieldDescription>
                        )}
                      </FieldContent>
                    </Field>
                    {budgetActive && (
                      <>
                        <Field>
                          <FieldLabel htmlFor="co-budget-kb">Max KB per file</FieldLabel>
                          <Input
                            id="co-budget-kb"
                            type="number"
                            min={50}
                            step={50}
                            className="w-28"
                            value={budgetKb}
                            disabled={running}
                            onChange={(e) => setBudgetKb(Number(e.target.value))}
                            onBlur={() => setBudgetKb(budgetKbSafe)}
                          />
                        </Field>
                        <Field orientation="horizontal">
                          <Checkbox
                            id="co-budget-shrink"
                            checked={budgetShrink}
                            disabled={running}
                            onCheckedChange={(checked) => setBudgetShrink(checked === true)}
                          />
                          <FieldContent>
                            <FieldLabel htmlFor="co-budget-shrink" className="font-normal">
                              <Hint hint="Last resort, only when no palette fits — the export report names every tile this touches.">Shrink dimensions if needed</Hint>
                            </FieldLabel>
                          </FieldContent>
                        </Field>
                      </>
                    )}

                    <Field orientation="horizontal">
                      <Checkbox
                        id="co-number-files"
                        checked={numberFiles}
                        disabled={running}
                        onCheckedChange={(checked) => setNumberFiles(checked === true)}
                      />
                      <FieldContent>
                        <FieldLabel htmlFor="co-number-files" className="font-normal">
                          Number exported files
                        </FieldLabel>
                        <FieldDescription>
                          {numberFiles
                            ? 'Files are named 01-title.png.'
                            : 'Files use the title alone; repeats get -2, -3 so nothing is overwritten.'}
                        </FieldDescription>
                      </FieldContent>
                    </Field>

                  </FieldGroup>
          </PanelSection>
        </RightPanel>
      </StudioShell>

      <TileDialog
        item={openItem}
        template={template}
        fallbackTitle={tplTitle}
        fallbackOffer={tplOffer}
        offerToggle={offerVisible}
        hasOfferCol={!!offerCol}
        running={running}
        onClose={() => setOpenId(null)}
        onRegenerate={handleRegenerate}
      />
    </div>
  );
}


