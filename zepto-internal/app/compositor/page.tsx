'use client';

import * as React from 'react';
import { toast } from 'sonner';
import {
  CircleStopIcon, DownloadIcon, ImageIcon, RefreshCwIcon, SparklesIcon, WandSparklesIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/hint';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
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
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

import { TemplateEditor } from '@/components/template-editor';
import { BatchPromptDialog } from '@/components/regen-prompt';
import { ColumnPicker } from '@/components/column-picker';
import { CsvDropzone, CsvFileTile } from '@/components/csv-dropzone';
import { SessionHeader, type SessionChip } from '@/components/session-header';
import { TileGrid, TileDialog, tileOptsFor } from '@/components/tile-grid';
import { ClearAllButton, SelectionBar, useGridSelection } from '@/components/selection';
import { Canvas, CanvasToolbar, LeftPanel, PanelSection, RightPanel, StudioShell } from '@/components/pane-layout';
import { useProcessing } from '@/components/process-panel';
import { BudgetControls } from '@/components/budget-controls';
import { MdFileIcon, MdFileTile } from '@/components/md-file-tile';

import { DEFAULT_TEMPLATE, EXPORT_WIDTH, TileTemplate, renderTile, tileToPngBlob } from '@/lib/tile';
import {
  CUSTOM_PRESET_ID, PRESET_TYPES, TILE_PRESETS as TEMPLATE_PRESETS, matchPreset,
} from '@/lib/tile-presets';
import { parseCSV, detectImageColumns, detectTitleColumn, detectOfferColumn, CsvRecord } from '@/lib/csv';
import { buildZipStream, ZipStreamEntry } from '@/lib/zip';
import { createEta } from '@/lib/eta';
import { matchSkill, useSkills } from '@/lib/skills';
import { loadImageFromUrl, callAzure, mockComposite } from '@/lib/pipeline';
import {
  BG_MODELS, BG_MODEL_ORDER, DEFAULT_MODEL_ID, probeServerModel, removeBackground, type BgModelId,
} from '@/lib/bg/engine';
import { isAbortError, mapWithLimit, pickSave, releaseCanvas, saveTo } from '@/lib/bg/batch';
import { readParallel } from '@/lib/rate';
import { describeBudget, fitToBudget, type BudgetResult } from '@/lib/bg/budget';
import { isPng8Supported } from '@/lib/bg/png8';
import { QueueItem, DEFAULT_ENDPOINT, DEFAULT_PROMPT } from '@/lib/types';
import { usePersistedState } from '@/hooks/use-persisted-state';

const NONE = '__none__';
/** Figma's export scales. 1x is EXPORT_WIDTH across; the template itself never changes. */
const EXPORT_SCALES = [1, 2, 3];
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
  // Derived, never stored: the dropdown shows whichever preset the template currently equals,
  // and flips to "Custom" the moment an edit diverges from all of them.
  const presetId = React.useMemo(() => matchPreset(template), [template]);
  const activePreset = TEMPLATE_PRESETS.find((p) => p.id === presetId);
  // Ratio presets pin the Azure size so the returned image fills the container 1:1; anything
  // else keeps 'auto' (the edits endpoint follows the input's aspect, cover-fit crops the rest).
  const presetSize = activePreset?.azureSize;
  function applyPreset(id: string) {
    const preset = TEMPLATE_PRESETS.find((p) => p.id === id);
    if (preset) setTemplate(structuredClone(preset.template));
  }
  // Type picks the family (first ratio applies); Ratio picks within it.
  function applyType(type: string) {
    const first = TEMPLATE_PRESETS.find((p) => p.type === type);
    if (first) applyPreset(first.id);
  }
  // The 1:1 preset's geometry is settled, so it offers colours and nothing else. Every other
  // preset — including the two ratios still being worked out — keeps the full editor.
  const colorsOnly = presetId === 'banner-square';
  const [tplTitle, setTplTitle] = React.useState('Tile name');
  const [tplOffer, setTplOffer] = React.useState('20% OFF');
  const [offerVisible, setOfferVisible] = React.useState(true);

  // Keys / prompt
  const [endpoint] = usePersistedState('skuc_azureEndpoint', DEFAULT_ENDPOINT);
  const [azureKey] = usePersistedState('skuc_azureKey', '');
  // The CDN ceiling is one rule for the whole suite, so these keys are the BG remover's own.
  const [budgetOn, setBudgetOn] = usePersistedState('skuc_bgBudgetOn', false);
  const [budgetKb, setBudgetKb] = usePersistedState('skuc_bgBudgetKb', 150);
  const [budgetShrink, setBudgetShrink] = usePersistedState('skuc_bgBudgetShrink', true);
  const [numberFiles, setNumberFiles] = usePersistedState('skuc_coNumberFiles', true);
  const [exportScale, setExportScale] = usePersistedState('skuc_coExportScale', 1);
  const [prompt, setPrompt] = usePersistedState('skuc_prompt', DEFAULT_PROMPT);
  const [promptEditorOpen, setPromptEditorOpen] = React.useState(false);
  // The wand asks before it spends: pressing it opens the batch prompt rather than firing.
  const [aiBatchOpen, setAiBatchOpen] = React.useState(false);
  // Prompt is skill-driven, preset-style: the dropdown derives which skill the current text
  // equals; editing the text flips it to Custom without losing anything.
  const { skills } = useSkills();
  const skillId = matchSkill(prompt, skills);
  const activeSkill = skills.find((sk) => sk.id === skillId);

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

  const itemIds = React.useMemo(() => items.map((it) => it.id), [items]);
  const sel = useGridSelection(itemIds, openId !== null);

  // Post-await reads (undo eligibility, toast actions) need the LIVE queue, not the closure.
  const itemsRef = React.useRef<QueueItem[]>(items);
  React.useEffect(() => { itemsRef.current = items; }, [items]);

  // Stop button: one controller per run; aborting skips rows not yet started and cancels the
  // in-flight fetches (the proxy forwards the abort to Azure).
  const genAbortRef = React.useRef<AbortController | null>(null);

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

  /** The row's images under a mapping: every picked column that actually holds an http(s) URL. */
  function rowUrls(record: CsvRecord, imageCols: string[]): string[] {
    return imageCols.map((c) => record[c]).filter((u) => /^https?:\/\//i.test(u || ''));
  }

  function buildQueue(records: CsvRecord[], imageCols: string[], titleCol: string, offerCol: string): QueueItem[] {
    return records.map((record, i) => {
      const urls = rowUrls(record, imageCols);
      return {
        id: i, record, urls,
        title: titleCol ? record[titleCol] ?? '' : '',
        offer: offerCol ? record[offerCol] ?? '' : '',
        status: urls.length ? 'ready' : 'no-images',
        resultImage: null,
        compressed: null,
      };
    });
  }

  /**
   * Remapping columns re-derives what a row IS, never what it has already produced. The queue is
   * index-aligned to the sheet — a mapping change can neither add, remove nor reorder a row — so
   * every item is patched in place and generated tiles, undo slots and in-flight statuses all
   * survive it. Rebuilding the queue here is what used to throw a whole finished batch away the
   * moment someone corrected the title column. (Generate remaps names the same way.)
   */
  function updateMapping(next: { imageCols?: string[]; titleCol?: string; offerCol?: string }) {
    const ic = next.imageCols ?? imageCols;
    const tc = next.titleCol ?? titleCol;
    const oc = next.offerCol ?? offerCol;
    if (next.imageCols) setImageCols(ic);
    if (next.titleCol !== undefined) setTitleCol(tc);
    if (next.offerCol !== undefined) setOfferCol(oc);
    // The summary describes bytes that some rows no longer have; it is re-earned on next export.
    if (tc !== titleCol || oc !== offerCol) setCompressSummary('');
    setItems((prev) =>
      prev.map((it) => {
        const urls = rowUrls(it.record, ic);
        const title = tc ? it.record[tc] ?? '' : '';
        const offer = oc ? it.record[oc] ?? '' : '';
        const sameUrls = urls.length === it.urls.length && urls.every((u, n) => u === it.urls[n]);
        const sameText = title === it.title && offer === it.offer;
        // Untouched rows keep their object identity, so their canvases do not repaint.
        if (sameUrls && sameText) return it;
        return {
          ...it,
          urls,
          title,
          offer,
          // Only the two statuses the mapping itself decides are re-derived. A row that has
          // generated, failed, or is in flight keeps the state it earned.
          status:
            it.status === 'ready' || it.status === 'no-images'
              ? urls.length ? 'ready' : 'no-images'
              : it.status,
          // Title and offer are drawn at render time, so changing them invalidates the cached
          // PNG bytes exactly the way a template edit does.
          compressed: sameText ? it.compressed : null,
        };
      }),
    );
  }

  // ---- Generation ----
  // Azure round trips overlap freely, but background removal runs on the main thread through a
  // single model instance — two inferences interleaved through one session is undefined
  // behaviour. This chain lets exactly one removal run at a time while the network stays busy.
  const bgLock = React.useRef<Promise<unknown>>(Promise.resolve());

  function patchItem(id: number, patch: Partial<QueueItem>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  /**
   * The optional background pass, shared by BOTH Azure round trips. Whatever comes back from
   * Azure is a fresh picture with a fresh background of its own, so the wand's AI edit needs
   * this every bit as much as a first composite does — it used to skip it, which is how a tile
   * got its background back with the toggle still switched on.
   *
   * Returns the image untouched when the toggle is off, or when the model cannot run: a missing
   * model or a downed sidecar must cost us the cutout, never the composite.
   */
  async function stripBackground(image: HTMLImageElement, item: QueueItem): Promise<HTMLImageElement> {
    if (!removeBg) return image;
    patchItem(item.id, { status: 'removing-bg' });
    // Yield once so the badge paints before inference blocks the main thread.
    await new Promise((r) => setTimeout(r, 0));
    try {
      // zoomPass runs a whole second inference to sharpen edges at ~2x resolution. Tiles
      // export at 600px wide, where that detail is invisible, so it is not worth doubling
      // the wall-clock of every row in a CSV.
      const turn = bgLock.current.then(() =>
        removeBackground(image, { model: activeModel, refine: false, zoomPass: false }),
      );
      bgLock.current = turn.catch(() => {});
      const { canvas } = await turn;
      return await canvasToImage(canvas);
    } catch (e) {
      toast.warning(`Row ${item.id + 1}: tile generated without background removal — ${(e as Error).message}`);
      return image;
    }
  }

  /** `promptOverride` is one row's edit from its dialog — it never touches the shared prompt. */
  async function generateItem(item: QueueItem, signal?: AbortSignal, promptOverride?: string) {
    patchItem(item.id, { status: 'fetching', errorMsg: undefined });
    const images: HTMLImageElement[] = [];
    for (const u of item.urls) images.push(await loadImageFromUrl(u, signal));
    patchItem(item.id, { status: 'generating' });
    const runPrompt = promptOverride?.trim() || prompt;
    let resultImage: HTMLImageElement;
    if (mock) {
      await new Promise((r) => setTimeout(r, 600));
      resultImage = await mockComposite(images);
    } else {
      resultImage = await callAzure(images, { endpoint, apiKey: azureKey, prompt: runPrompt, size: presetSize, signal });
    }
    resultImage = await stripBackground(resultImage, item);
    patchItem(item.id, {
      status: 'done',
      resultImage,
      compressed: null,
      // `item` is the pre-run snapshot: if it had a tile, that tile becomes the undo slot.
      ...(item.resultImage ? { prev: { resultImage: item.resultImage } } : null),
    });
  }

  function guards(): boolean {
    if (running) return false;
    if (!mock && (!endpoint.trim() || !azureKey.trim())) {
      toast.error('Set the Azure endpoint and API key in Settings (gear at the bottom of the rail), or use ?mock=1.');
      return false;
    }
    return true;
  }

  async function handleGenerateAll() {
    if (!guards()) return;
    await runTiles(items.filter((it) => it.urls.length), 'generated');
  }

  /**
   * A second Azure pass over a tile that already exists — Cleanup's AI edit, on the composite
   * instead of a cutout. The tile IS the input here, not the row's source photos. It runs on the
   * product's one prompt; a single tile's dialog is where that prompt can be reworded for that
   * tile alone. The tile it replaces becomes the undo slot, exactly as a regenerate's does.
   */
  async function aiEditItem(item: QueueItem, signal?: AbortSignal, promptOverride?: string) {
    const source = item.resultImage;
    if (!source) return;
    patchItem(item.id, { status: 'generating', errorMsg: undefined });
    const runPrompt = promptOverride?.trim() || prompt;
    let edited: HTMLImageElement;
    if (mock) {
      await new Promise((r) => setTimeout(r, 600));
      edited = await mockComposite([source]);
    } else {
      edited = await callAzure([source], {
        endpoint, apiKey: azureKey, prompt: runPrompt, size: presetSize, signal,
      });
    }
    edited = await stripBackground(edited, item);
    patchItem(item.id, {
      status: 'done',
      resultImage: edited,
      compressed: null,
      prev: { resultImage: source },
    });
  }

  /**
   * One run over `todo`. Generate-all, Regenerate-selected and AI-edit-selected share the whole
   * batch machinery — concurrency, ETA, stop, per-row error isolation — and differ only in the
   * verb and in what each row is actually put through.
   */
  async function runTiles(
    todo: QueueItem[],
    verb: string,
    run: (item: QueueItem, signal: AbortSignal) => Promise<void> = generateItem,
  ) {
    if (!todo.length) return;
    const controller = new AbortController();
    genAbortRef.current = controller;
    setRunning(true);
    // Requests in flight at once: the Azure round trip dominates a tile's wall-clock, so
    // overlapping the waits is where a batch gets its speed. Suite-wide, from Settings →
    // Image model (lib/rate.ts); read at run start, so it holds for the whole batch.
    const limit = readParallel();
    let done = 0;
    let finished = 0;
    const eta = createEta();
    setProgress({ pct: 0, text: `0 of ${todo.length} tiles — ${limit} at a time with ${mock ? 'mock' : 'azure'}…` });
    await mapWithLimit(todo, limit, async (item) => {
      // Stop skips everything not yet started; rows already in flight abort via the signal.
      if (controller.signal.aborted) {
        finished++;
        return;
      }
      try {
        await run(item, controller.signal);
        done++;
      } catch (e) {
        if (isAbortError(e)) {
          // Stopped, not failed: the row goes back exactly where it was before this run.
          patchItem(item.id, { status: item.status, errorMsg: undefined });
        } else {
          patchItem(item.id, { status: 'error', errorMsg: (e as Error).message });
        }
      }
      finished++;
      const left = eta.remaining(finished, todo.length);
      setProgress({
        pct: (finished / todo.length) * 100,
        text: `${finished} of ${todo.length} tiles — ${limit} at a time with ${mock ? 'mock' : 'azure'}…${left ? ` · ${left}` : ''}`,
      });
    });
    setProgress(
      controller.signal.aborted
        ? { pct: 100, text: `Stopped — ${done} of ${todo.length} tiles ${verb}; the rest are untouched.` }
        : { pct: 100, text: `Done — ${done} of ${todo.length} tiles ${verb}.` },
    );
    genAbortRef.current = null;
    setRunning(false);
  }

  /** Restores the tile the last regenerate replaced. */
  function undoItem(id: number) {
    const item = itemsRef.current.find((it) => it.id === id);
    if (!item?.prev) return;
    patchItem(id, {
      status: 'done',
      resultImage: item.prev.resultImage,
      compressed: null,
      errorMsg: undefined,
      prev: undefined,
    });
  }

  async function handleRegenerateSelected() {
    if (!guards()) return;
    // Rows without image URLs can't generate; quietly skip them like Generate-all does.
    const todo = items.filter((it) => sel.checked.has(it.id) && it.urls.length);
    await runTiles(todo, 'regenerated');
    offerUndo(todo, 'regenerated');
  }

  /** The wand's targets: only rows that HAVE a tile — the tile itself is the input. */
  const aiEditTargets = items.filter((it) => sel.checked.has(it.id) && it.resultImage);

  async function handleAiEditSelected(promptOverride: string) {
    if (!guards()) return;
    const todo = aiEditTargets;
    if (!todo.length) return;
    await runTiles(todo, 'edited', (item, signal) => aiEditItem(item, signal, promptOverride));
    offerUndo(todo, 'edited');
  }

  /** Post-run toast whose Undo restores every tile the run replaced. */
  function offerUndo(todo: QueueItem[], verb: string) {
    const undoable = todo
      .map((it) => it.id)
      .filter((id) => itemsRef.current.find((it) => it.id === id)?.prev);
    if (!undoable.length) return;
    toast.success(`${undoable.length} ${verb}`, {
      action: { label: 'Undo', onClick: () => undoable.forEach(undoItem) },
    });
  }

  function deleteSelected() {
    setItems((prev) => prev.filter((it) => !sel.checked.has(it.id)));
    setOpenId((prev) => (prev !== null && sel.checked.has(prev) ? null : prev));
    sel.clear();
  }

  /** Full reset back to the drop zone. Session name survives, like Generate's clear. */
  function clearAll() {
    setItems([]);
    sel.clear();
    setOpenId(null);
    setFileName(null);
    setHeaders([]);
    setRecords([]);
    setImageCols([]);
    setTitleCol('');
    setOfferCol('');
    setProgress(null);
    setCompressSummary('');
  }

  async function handleRegenerate(item: QueueItem, promptOverride?: string) {
    if (running) return;
    const controller = new AbortController();
    genAbortRef.current = controller;
    setRunning(true);
    setProgress({ pct: 50, text: `Regenerating row ${item.id + 1}…` });
    try {
      await generateItem(item, controller.signal, promptOverride);
      setProgress({ pct: 100, text: `Row ${item.id + 1} regenerated.` });
    } catch (e) {
      if (isAbortError(e)) {
        patchItem(item.id, { status: item.status, errorMsg: undefined });
        setProgress({ pct: 100, text: `Row ${item.id + 1} — stopped.` });
      } else {
        patchItem(item.id, { status: 'error', errorMsg: (e as Error).message });
        setProgress({ pct: 100, text: `Row ${item.id + 1} failed: ${(e as Error).message}` });
      }
    }
    genAbortRef.current = null;
    setRunning(false);
  }

  // ---- Export: budget → shared local compress → ZIP, one action ----
  async function handleExport() {
    // Anything generated, whether or not its cell is currently mounted — export rasterises its
    // own canvas now, so it no longer depends on the grid having one on screen.
    const done = items.filter((it) => it.status === 'done' && it.resultImage);
    // The grid's rules, snapshotted for the whole export: the tile you looked at is the tile
    // that ships, and editing a field mid-encode must not give the ZIP two different answers.
    const textRules = {
      fallbackTitle: tplTitle,
      fallbackOffer: tplOffer,
      offerToggle: offerVisible,
      hasOfferCol: !!offerCol,
    };
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
    const files: ZipStreamEntry[] = [];
    let inTotal = 0, outTotal = 0, failed = 0;
    let budgetSummary = '';
    // Encoding and zipping can throw (toBlob returning null, an allocation failure on a big
    // batch); without the finally, `running` would stay true and wedge both buttons.
    try {
      // canvas.toBlob's latency is per-call and overlaps across calls, so encoding tiles one at
      // a time made a big batch wait many times over for work that costs the same done at once.
      // The limit bounds how many tile canvases are encoding simultaneously.
      let encoded = 0;
      // Per-phase clocks: encode and compress throughputs differ wildly, so one shared
      // tracker would carry the first phase's pace into the second.
      const encodeEta = createEta();
      const outcomes = new Array<BudgetResult | null>(done.length).fill(null);
      const raw = await mapWithLimit(done, ENCODE_CONCURRENCY, async (item, n) => {
        // The cached TinyPNG bytes were negotiated under no budget, so a budgeted run encodes
        // fresh from the canvas instead of trusting them.
        if (!budget && item.compressed) return item.compressed.data;
        // Rasterised here rather than lifted off the grid: the cell on screen is sized for
        // looking at, and export resolution is a separate decision. Same template, same row
        // text (tileOptsFor is the one rule), just more pixels.
        const canvas = document.createElement('canvas');
        renderTile(
          canvas,
          { ...tileOptsFor(item, textRules), image: item.resultImage },
          template,
          exportScale,
        );
        let data: Uint8Array;
        try {
          if (budget) {
            const result = await fitToBudget(canvas, budget);
            outcomes[n] = result;
            data = result.bytes;
          } else {
            const blob = await tileToPngBlob(canvas);
            data = new Uint8Array(await blob.arrayBuffer());
          }
        } finally {
          // A 3x tile is ~13MB of canvas; eight in flight is worth handing back promptly
          // rather than waiting on GC part-way through a thousand-row sheet.
          releaseCanvas(canvas);
        }
        encoded++;
        const left = encodeEta.remaining(encoded, done.length);
        setProgress({
          pct: (encoded / done.length) * 50,
          text: `Encoding tile ${encoded} of ${done.length}…${left ? ` · ${left}` : ''}`,
        });
        return data;
      });

      // The processing space's shared compress step (pngquant + oxipng, local). A failure
      // keeps the uncompressed PNG for that tile rather than sinking the export.
      let sent = 0;
      const compressEta = createEta();
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
          const left = compressEta.remaining(sent, done.length);
          setProgress({
            pct: 50 + (sent / done.length) * 50,
            text: `Compressing tile ${sent} of ${done.length}…${left ? ` · ${left}` : ''}`,
          });
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

      const zip = await buildZipStream(files);
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
  // Greyed out with a reason beats erroring on click — same gate as Cleanup's AI edit.
  const aiReady = mock || (endpoint.trim().length > 0 && azureKey.trim().length > 0);

  // The template preview answers "what will my tiles look like", so once a sheet is in it
  // renders the first row by exactly the rules the grid and the export use. With no sheet there
  // is nothing to render, so SAMPLE_* stands in — placeholder for a preview, never for a tile.
  const exportPx = {
    w: Math.round(EXPORT_WIDTH * exportScale),
    h: Math.round((EXPORT_WIDTH * exportScale * template.frame.height) / template.frame.width),
  };

  const previewRow = items[0];
  const previewTitle = previewRow?.title || tplTitle;
  const previewOffer = previewRow?.offer || tplOffer;
  const previewOfferVisible =
    offerVisible && (!previewRow || !!previewRow.offer.trim() || !offerCol);
  // Which columns the preview is reading, for the line under the two text fields. The offer is
  // named only where there is a bar to draw it in, so the line never credits a hidden layer.
  const mappedText = [
    titleCol && `title from ${titleCol}`,
    template.offer.visible && offerCol && `offer from ${offerCol}`,
  ]
    .filter(Boolean)
    .join(' · ');

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
              product="Compose"
              chips={
                [
                  records.length > 0 && { label: `${records.length} row${records.length === 1 ? '' : 's'}` },
                  items.length > 0 && { label: `${doneCount}/${items.length} tiles` },
                ].filter(Boolean) as SessionChip[]
              }
            />
          }
          footer={
            <div className="flex gap-2">
              <Button className="flex-1" disabled={!canGenerate || running} onClick={handleGenerateAll}>
                {running ? <Spinner data-icon="inline-start" /> : <SparklesIcon data-icon="inline-start" />}
                Generate &amp; Populate
              </Button>
              {running && (
                <Button variant="outline" onClick={() => genAbortRef.current?.abort()}>
                  <CircleStopIcon data-icon="inline-start" />
                  Stop
                </Button>
              )}
            </div>
          }
        >
          <PanelSection title="Template" hint="Pick a ratio; the layout comes with it. Colours are the part that varies per batch." className="space-y-4">
              <FieldGroup className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="tpl-preset-type">Preset</FieldLabel>
                  <Select
                    value={activePreset?.type ?? CUSTOM_PRESET_ID}
                    onValueChange={(v) => applyType(String(v ?? ''))}
                  >
                    <SelectTrigger id="tpl-preset-type">
                      <SelectValue>
                        {(v) =>
                          PRESET_TYPES.find((t) => t.id === v)?.label ??
                          (v === CUSTOM_PRESET_ID ? 'Custom' : 'Type')
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false} sideOffset={4}>
                      {PRESET_TYPES.map((t) => (
                        <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>
                      ))}
                      {/* Indicator, not an action: it becomes selected by editing, not by picking. */}
                      <SelectItem value={CUSTOM_PRESET_ID} disabled={presetId !== CUSTOM_PRESET_ID}>
                        Custom
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                {activePreset && (
                  <Field>
                    <FieldLabel htmlFor="tpl-preset-ratio">Ratio</FieldLabel>
                    <Select value={presetId} onValueChange={(v) => applyPreset(String(v ?? ''))}>
                      <SelectTrigger id="tpl-preset-ratio">
                        <SelectValue>
                          {(v) => TEMPLATE_PRESETS.find((p) => p.id === v)?.ratio ?? 'Ratio'}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent alignItemWithTrigger={false} sideOffset={4}>
                        {TEMPLATE_PRESETS.filter((p) => p.type === activePreset.type).map((p) => (
                          <SelectItem key={p.id} value={p.id}>{p.ratio}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              </FieldGroup>
              <TemplateEditor
                template={template}
                onChange={handleTemplateChange}
                previewTitle={previewTitle}
                previewOffer={previewOffer}
                previewOfferVisible={previewOfferVisible}
                minimal={presetSize !== undefined}
                colorsOnly={colorsOnly}
              >
                {presetSize !== undefined || colorsOnly ? null : (
                <FieldGroup className="gap-2">
                  <div className="grid grid-cols-2 gap-3">
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
                  </div>
                  {/* Says what the preview above is reading, so sheet text appearing in these
                      fields' place reads as the mapping working, not as them being ignored. */}
                  <FieldDescription>
                    {mappedText
                      ? `Preview shows row 1 — ${mappedText}. This text fills a blank title; a row with a blank offer renders without the bar.`
                      : records.length
                        ? 'No title or offer column mapped below, so every tile renders exactly this text.'
                        : 'Sample text for the preview — map a title or offer column once a CSV is in to preview real rows.'}
                  </FieldDescription>
                </FieldGroup>
                )}
              </TemplateEditor>
            </PanelSection>
          <PanelSection title="CSV file">
              {/* Same slot convention as prompts: empty invites a drop, loaded shows the file
                  card (click to replace, ✕ to remove). Removing IS clearing the run — every
                  queue row came from this sheet — so it goes through clearAll's confirm copy. */}
              {fileName ? (
                <CsvFileTile
                  name={fileName}
                  description={headers.join(', ')}
                  badge={`${records.length.toLocaleString()} row${records.length === 1 ? '' : 's'}`}
                  onReplace={handleFile}
                  onRemove={clearAll}
                  disabled={running}
                  removeConfirm={{
                    title: 'Remove the CSV?',
                    description: (
                      <>
                        Clears all {items.length} row{items.length === 1 ? '' : 's'}
                        {doneCount > 0 && <> and the {doneCount} generated tile{doneCount === 1 ? '' : 's'} (not exported anywhere yet)</>}
                        . Your CSV file on disk is untouched — drop it again to rebuild the queue.
                      </>
                    ),
                  }}
                />
              ) : (
                <CsvDropzone fileName={null} rowCount={0} onFile={handleFile} />
              )}
            </PanelSection>

          {/* The tile above carries the file name; repeating it in this title just made two
              rows disagree about truncation. */}
          {headers.length > 0 && (
            <PanelSection title="Columns">
                <FieldGroup className="gap-4">
                  <Field>
                    <FieldLabel htmlFor="co-img-cols">Image URL columns</FieldLabel>
                    {/* Same combobox as Cleanup's and Generate's column pickers — a checkbox
                        per header pushed every control below it off a wide sheet's panel. */}
                    <ColumnPicker
                      id="co-img-cols"
                      columns={headers}
                      selected={imageCols}
                      onChange={(next) => updateMapping({ imageCols: next })}
                      disabled={running}
                      placeholder="None — no row can generate"
                    />
                    <FieldDescription>
                      Auto-detected on drop; each picked column contributes one product image
                      per row.
                    </FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="title-col">Title column</FieldLabel>
                    <Select
                      value={titleCol || NONE}
                      disabled={running}
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
                  {/* Only where there is an offer bar to fill. The Image presets are an image
                      container and nothing else, so mapping a column to a layer they do not
                      draw is a control that cannot do anything. The stored choice is kept, not
                      cleared, so switching back to a banner tile brings the mapping back with
                      it. Title stays either way — it names the cell and the exported file. */}
                  {template.offer.visible && (
                  <Field>
                    <FieldLabel htmlFor="offer-col">Offer / discount column</FieldLabel>
                    <Select
                      value={offerCol || NONE}
                      disabled={running}
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
                  )}
                </FieldGroup>
              </PanelSection>
          )}

          {/* One prompt for the product, exactly as Cleanup has one. Both the composite and the
              wand's second pass start from it; a tile's own dialog is where it becomes editable
              for that tile alone. */}
          <PanelSection title="Prompt" hint="What the model is told to do, for composites and for the wand's AI edit. Skills are managed in Settings.">
              <FieldGroup className="gap-4">
                {/* The tile carries the skill switcher (the caret menu) — same control on
                    Cleanup's AI-edit prompt and Generate's brief. No `badge`: the tile shows
                    the active skill's own tag, or "Edited" when the text matches no skill at
                    all. A chip reading "Skill" only repeated the section it sits in. */}
                <MdFileTile
                  name={activeSkill?.name ?? 'custom-prompt.md'}
                  text={prompt}
                  onClick={() => setPromptEditorOpen(true)}
                  disabled={running}
                  skills={{ list: skills, activeId: skillId, onSelect: (sk) => setPrompt(sk.content) }}
                />
              </FieldGroup>
            </PanelSection>

          {/* Background removal moved to the right pane, with the other processing steps. */}

          {/* Parallel requests moved to Settings → Image model — suite-wide (lib/rate.ts). */}

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
              <>
                  {/* Grid toolbar: count on the left, whole-run reset on the right. */}
                <CanvasToolbar className="justify-between">
                  <span className="text-xs text-muted-foreground">
                    {sel.active
                      ? `${sel.checked.size} of ${items.length} selected`
                      : `${items.length} row${items.length === 1 ? '' : 's'}${doneCount ? ` · ${doneCount} generated` : ''}`}
                  </span>
                  <ClearAllButton
                    title="Clear this run?"
                    disabled={running}
                    onConfirm={clearAll}
                    description={
                      <>
                        Removes all {items.length} row{items.length === 1 ? '' : 's'}
                        {doneCount > 0 && <> and the {doneCount} generated tile{doneCount === 1 ? '' : 's'} (not exported anywhere yet)</>}
                        . Your CSV file on disk is untouched — drop it again to rebuild the
                        queue.
                      </>
                    }
                  />
                </CanvasToolbar>
                <TileGrid
                  items={items}
                  template={template}
                  fallbackTitle={tplTitle}
                  fallbackOffer={tplOffer}
                  offerToggle={offerVisible}
                  hasOfferCol={!!offerCol}
                  running={running}
                  selected={sel.checked}
                  onOpen={(item) => setOpenId(item.id)}
                  onRemove={(item) => {
                    setItems((prev) => prev.filter((it) => it.id !== item.id));
                    setOpenId((prev) => (prev === item.id ? null : prev));
                  }}
                  onToggleSelect={sel.toggle}
                />
                {sel.active && (
                  <SelectionBar
                    count={sel.checked.size}
                    total={items.length}
                    allSelected={sel.allSelected}
                    busy={running}
                    actions={[
                      {
                        key: 'ai-edit',
                        label: aiReady
                          ? 'AI edit selected — sends each finished tile back to Azure with the AI edit prompt'
                          : 'AI edit needs the Azure endpoint + key (Settings, gear in the rail)',
                        icon: WandSparklesIcon,
                        accent: true,
                        disabled: !aiReady || !aiEditTargets.length,
                        onRun: () => setAiBatchOpen(true),
                      },
                      {
                        key: 'regenerate',
                        label: 'Regenerate selected — composes each tile again from its source images',
                        icon: RefreshCwIcon,
                        onRun: () => void handleRegenerateSelected(),
                      },
                    ]}
                    deleteTitle={`Delete ${sel.checked.size} row${sel.checked.size === 1 ? '' : 's'}?`}
                    deleteDescription="Removes them from this run, along with any tiles they generated. Rows still in the CSV file come back if you drop it again."
                    onDelete={deleteSelected}
                    onSelectAll={sel.selectAll}
                    onClear={sel.clear}
                  />
                )}
              </>
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
          <PanelSection
            title="Remove background"
            hint="Runs Cleanup's model on each tile right after Azure returns it. Weights download once and are shared with that product."
            action={
              <Switch
                aria-label="Remove background"
                checked={removeBg}
                disabled={running}
                onCheckedChange={(checked) => setRemoveBg(checked === true)}
              />
            }
          >
            {removeBg ? (
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
                  <SelectTrigger id="bg-model" className="w-full" disabled={running}>
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
            ) : undefined}
          </PanelSection>
          {proc.panel}
          <PanelSection>
          <FieldGroup className="gap-4">
                    <Field>
                      <FieldLabel>
                        <Hint hint="Figma's export scale. The template is unchanged — only the pixels it is rasterised into. 1x is 600px on the tile's long-ish edge; 3x is 1800.">Export scale</Hint>
                      </FieldLabel>
                      {/* Replaces the old Tile size group, which wrote frame width and height
                          straight into the template and so knocked whichever preset was active
                          into "Custom". Geometry belongs to the preset now; resolution is the
                          thing that actually varies per batch. */}
                      <ToggleGroup
                        size="sm"
                        variant="outline"
                        className="flex-wrap justify-start"
                        value={[String(exportScale)]}
                        onValueChange={(next) => {
                          const n = Number(next[0]);
                          if (EXPORT_SCALES.includes(n) && !running) setExportScale(n);
                        }}
                      >
                        {EXPORT_SCALES.map((n) => (
                          <ToggleGroupItem key={n} value={String(n)} disabled={running}>
                            {n}x
                          </ToggleGroupItem>
                        ))}
                      </ToggleGroup>
                      <FieldDescription>
                        PNGs export at {exportPx.w.toLocaleString()} × {exportPx.h.toLocaleString()} px.
                      </FieldDescription>
                    </Field>

                    <BudgetControls
                      idPrefix="co"
                      on={budgetOn}
                      onOnChange={setBudgetOn}
                      kb={budgetKb}
                      onKbChange={setBudgetKb}
                      kbSafe={budgetKbSafe}
                      shrink={budgetShrink}
                      onShrinkChange={setBudgetShrink}
                      disabled={running}
                      available={png8Ready}
                      limitHintSuffix="Shared setting with Cleanup."
                    />

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

      <BatchPromptDialog
        open={aiBatchOpen}
        onOpenChange={setAiBatchOpen}
        defaultPrompt={prompt}
        count={aiEditTargets.length}
        noun="tile"
        busy={running}
        excludedNote={(() => {
          const skipped = sel.checked.size - aiEditTargets.length;
          return skipped > 0
            ? `${skipped} selected row${skipped === 1 ? ' has' : 's have'} no finished tile yet and ${skipped === 1 ? 'is' : 'are'} left out.`
            : undefined;
        })()}
        onRun={(p) => void handleAiEditSelected(p)}
      />

      {/* Prompt editor — same .md-tile-opens-modal pattern as Cleanup's AI-edit prompt. */}
      <Dialog open={promptEditorOpen} onOpenChange={setPromptEditorOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MdFileIcon className="size-4 text-muted-foreground" />
              {activeSkill?.name ?? 'custom-prompt.md'}
            </DialogTitle>
            <DialogDescription>
              The instruction sent with every composite, and what the wand&rsquo;s AI edit starts
              from. Editing detaches it from the selected skill; save reusable versions from
              Settings → Skills.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={16}
            disabled={running}
            aria-label="Composite prompt"
            className="max-h-[55dvh] min-h-40 overflow-y-auto text-xs"
          />
          <DialogFooter>
            {prompt.trim() !== DEFAULT_PROMPT.trim() && (
              <Button variant="ghost" disabled={running} onClick={() => setPrompt(DEFAULT_PROMPT)}>
                Reset to default
              </Button>
            )}
            <Button onClick={() => setPromptEditorOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TileDialog
        item={openItem}
        template={template}
        fallbackTitle={tplTitle}
        fallbackOffer={tplOffer}
        offerToggle={offerVisible}
        hasOfferCol={!!offerCol}
        running={running}
        prompt={prompt}
        exportScale={exportScale}
        onClose={() => setOpenId(null)}
        onRegenerate={handleRegenerate}
        onUndo={(item) => undoItem(item.id)}
      />
    </div>
  );
}


