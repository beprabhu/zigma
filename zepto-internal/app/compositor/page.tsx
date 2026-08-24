'use client';

import * as React from 'react';
import { toast } from 'sonner';
import {
  CircleStopIcon, DownloadIcon, FileSpreadsheetIcon, ImagesIcon, PlusIcon, RefreshCwIcon,
  SparklesIcon, WandSparklesIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/hint';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item';
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
import { BatchPromptDialog, resolvePromptSource, type PromptSource } from '@/components/regen-prompt';
import { ColumnPicker } from '@/components/column-picker';
import { joinNameColumns } from '@/lib/csv-name';
import { CsvFileTile } from '@/components/csv-dropzone';
import { CanvasDropzone, DropzoneShell, FolderInputButton } from '@/components/dropzone';
import { BandCard, RowSizeControls } from '@/components/grid-bands';
import { SessionHeader, type SessionChip } from '@/components/session-header';
import { TileGrid, TileGridSkeleton, TileDialog, tileOptsFor } from '@/components/tile-grid';
import { ClearAllButton, SelectionBar, useGridSelection } from '@/components/selection';
import { Canvas, CanvasToolbar, LeftPanel, PanelSection, RightPanel, StudioShell } from '@/components/pane-layout';
import { QueueSearch, matchesTerms, recordValues, searchTerms } from '@/components/queue-search';
import { useProcessing } from '@/components/process-panel';
import { BudgetControls } from '@/components/budget-controls';
import { MdFileIcon, MdFileTile } from '@/components/md-file-tile';

import { DEFAULT_TEMPLATE, EXPORT_SIZE, TileTemplate, renderTile, tileToPngBlob } from '@/lib/tile';
import {
  CUSTOM_PRESET_ID, DEFAULT_BAND_PRESET_ID, PRESET_TYPES, TILE_PRESETS as TEMPLATE_PRESETS,
  bandPreset, matchPreset, withTileColors,
} from '@/lib/tile-presets';
import { parseCSV, detectImageColumns, detectTitleColumn, detectOfferColumn, CsvRecord } from '@/lib/csv';
import { normalizeHeicFiles } from '@/lib/bg/heic';
import { filesFromDataTransfer } from '@/lib/drop';
import { buildZipStream, ZipStreamEntry } from '@/lib/zip';
import { createEta } from '@/lib/eta';
import { matchSkill, useSkills } from '@/lib/skills';
import { loadImageFromUrl, callAzure, mockComposite } from '@/lib/pipeline';
import {
  BG_MODELS, BG_MODEL_ORDER, DEFAULT_MODEL_ID, probeServerModel, removeBackground, type BgModelId,
} from '@/lib/bg/engine';
import {
  isAbortError, isCsvFile, isImageFile, mapWithLimit, pickSave, releaseCanvas, saveTo,
  stripExtension,
} from '@/lib/bg/batch';
import { readParallel } from '@/lib/rate';
import { describeBudget, fitToBudget, type BudgetResult } from '@/lib/bg/budget';
import { isPng8Supported } from '@/lib/bg/png8';
import { GridBand, QueueItem, DEFAULT_ENDPOINT, DEFAULT_PROMPT } from '@/lib/types';
import { usePersistedState } from '@/hooks/use-persisted-state';

const NONE = '__none__';
/** Figma's export scales. 1x fits the tile in an EXPORT_SIZE box; the template never changes. */
const EXPORT_SCALES = [1, 2, 3];
// Bounds how many tile canvases encode at once on export; TinyPNG stays narrower (rate limits).
const ENCODE_CONCURRENCY = 8;
const COMPRESS_CONCURRENCY = 4;

/** A Banner grid row, before it has a CSV. Four across is the shelf shape these grids ship in. */
function newBand(id = crypto.randomUUID()): GridBand {
  return {
    id,
    presetId: DEFAULT_BAND_PRESET_ID,
    count: 0,
    columns: 4,
    fileName: null,
    headers: [],
    records: [],
    imageCols: [],
    titleCols: [],
    offerCol: '',
  };
}

/**
 * The row grid mode opens on. Derived rather than seeded into state: grid mode is read from
 * localStorage after mount, so nothing can put a first band in the initial state, and writing
 * one from an effect would just be a cascading render. Stable identity — every mutation
 * replaces it — so it can stand in for state until the first edit materialises it.
 */
const SEED_BAND: GridBand = newBand('grid-row-1');

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
    // Geometry comes from the preset, colours stay with the batch. The other half of the same
    // rule matchPreset follows: if recolouring does not leave a preset, then changing ratio
    // must not silently undo the recolouring.
    if (preset) setTemplate((current) => withTileColors(structuredClone(preset.template), current));
  }
  // Banner grid is a wrapper, not a template, so it is the one type that has no preset to
  // apply — picking it switches the product into band mode and the bands carry the ratios.
  const [gridMode, setGridMode] = usePersistedState('skuc_coGridMode', false);
  // Type picks the family (first ratio applies); Ratio picks within it.
  function applyType(type: string) {
    if (type === 'grid') { setGridMode(true); return; }
    setGridMode(false);
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
  const [titleCols, setTitleCols] = React.useState<string[]>([]);
  const [offerCol, setOfferCol] = React.useState('');

  // Banner grid — the rows ("bands") of the grid. Each owns one CSV, one banner-tile preset and
  // how much of that sheet to draw; the tiles themselves live in the flat queue below, tagged
  // with their band, so every batch mechanism stays band-agnostic.
  const [bands, setBands] = React.useState<GridBand[]>([]);
  // A grid holds several sheets at once, so a row's sheet index can no longer be its queue id.
  const nextItemId = React.useRef(0);
  // Grid mode is never empty-handed: there is always a row on screen to drop a CSV into.
  const gridBands = bands.length ? bands : [SEED_BAND];
  /** Band writes go through the SAME list the UI reads, seed included. */
  function updateBands(fn: (prev: GridBand[]) => GridBand[]) {
    setBands((prev) => fn(prev.length ? prev : [SEED_BAND]));
  }

  // Queue / run state
  const [items, setItems] = React.useState<QueueItem[]>([]);
  /**
   * What this run is fed by, decided by whatever landed FIRST and held until Clear.
   *
   * The two sources are not mixable: a CSV row is a record with mapped columns behind it, an
   * image row is a file with nothing behind it but its name. Letting both into one queue would
   * mean a Columns panel that maps half the rows and an export that numbers them from two
   * different origins. So the first drop picks, and the other kind is refused out loud.
   */
  const [mode, setMode] = React.useState<'csv' | 'images' | null>(null);
  const [running, setRunning] = React.useState(false);
  const [progress, setProgress] = React.useState<{ pct: number; text: string } | null>(null);
  const [compressSummary, setCompressSummary] = React.useState('');

  // The dialog holds an id, not an item object: rows are replaced on every status patch, and
  // resolving the id at render time is what lets the open dialog update live mid-regenerate.
  const [openId, setOpenId] = React.useState<number | null>(null);
  const openItem = items.find((it) => it.id === openId) ?? null;

  /**
   * The queue the product is currently working on. Grid mode and single-template mode keep
   * their rows in the SAME array, told apart by bandId, so flipping the Preset dropdown parks
   * one and shows the other instead of throwing either away — and neither can ship tiles the
   * canvas is not showing.
   */
  const activeItems = React.useMemo(
    () => items.filter((it) => (gridMode ? !!it.bandId : !it.bandId)),
    [items, gridMode],
  );

  const imageItemCount = React.useMemo(
    () => activeItems.filter((it) => it.localSources?.length).length,
    [activeItems],
  );

  /**
   * Display only. `activeItems` above stays the authoritative queue — generating, exporting and
   * the counts all read it — so a search typed to check one tile can never shrink the run or the
   * ZIP. Only the grid and the selection that rides on it narrow.
   */
  const [search, setSearch] = React.useState('');
  const searchIn = React.useCallback(
    (rows: QueueItem[]) => {
      const terms = searchTerms(search);
      if (!terms.length) return rows;
      // The sheet's own cells are searched too: a row is far more often hunted for by its SKU code
      // or pack size than by the title that ends up drawn on the tile.
      return rows.filter((it) =>
        matchesTerms([it.title, it.offer, it.row, ...recordValues(it.record)], terms),
      );
    },
    [search],
  );
  const visibleItems = React.useMemo(() => searchIn(activeItems), [searchIn, activeItems]);

  // Selection follows what is on screen — select-all must never reach rows a search is hiding.
  const itemIds = React.useMemo(() => visibleItems.map((it) => it.id), [visibleItems]);
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
      // Detection guesses ONE header; a combination is only ever an explicit choice.
      const tCols = tCol ? [tCol] : [];
      setTitleCols(tCols);
      setOfferCol(oCol);
      setMode('csv');
      setItems(buildQueue(records, imgCols, tCols, oCol));
    };
    reader.readAsText(file);
  }

  // ---- Images ----

  /**
   * A run fed by files. Rows carry the file itself instead of a URL to fetch, and everything
   * a sheet would have supplied is absent: no record, no offer, and a title taken from the
   * file name — which is also what names the tile in the export ZIP.
   */
  function buildImageQueue(files: File[], rowStart: number): QueueItem[] {
    return files.map((file, i) => ({
      id: nextItemId.current++,
      row: rowStart + i,
      record: {},
      urls: [],
      localSources: [{ name: file.name, url: URL.createObjectURL(file) }],
      title: stripExtension(file.name),
      offer: '',
      status: 'ready' as const,
      resultImage: null,
      compressed: null,
    }));
  }

  /** The folder a dropped set came from, when it came from one — a nicer run name than a file. */
  function folderNameOf(files: File[]): string {
    const segments = files[0]?.webkitRelativePath?.split('/') ?? [];
    return segments.length > 1 ? segments[0] : '';
  }

  async function handleImageFiles(files: File[]) {
    const picked = files.filter(isImageFile);
    if (!picked.length) { toast.error('No images in that drop.'); return; }
    // HEIC cannot be decoded by canvas; convert before anything counts it as loaded, the same
    // way Cleanup's dropzone does.
    const usable = await normalizeHeicFiles(picked, (file, e) =>
      toast.error(`Could not convert ${file.name}: ${(e as Error).message}`));
    if (!usable.length) return;
    const folder = folderNameOf(usable);
    setSessionName((prev) => (prev.trim() ? prev : folder || 'Images'));
    setMode('images');
    setItems((prev) => {
      // Row numbers continue from what is already queued — a second folder appends, it does
      // not restart at 1 and collide with the first in the ZIP.
      const rowStart = prev.filter((it) => !it.bandId).length + 1;
      return [...prev, ...buildImageQueue(usable, rowStart)];
    });
  }

  /**
   * Every drop and browse in single-template mode. The FIRST usable file decides what this run
   * is; after that the other kind is refused rather than silently dropped, because "I dragged
   * images onto my CSV run and nothing happened" is indistinguishable from a broken dropzone.
   */
  function handleDrop(files: File[]) {
    const csv = files.find(isCsvFile) ?? null;
    const images = files.filter(isImageFile);
    if (!csv && !images.length) { toast.error('Drop a CSV or image files.'); return; }
    const kind = mode ?? (csv ? 'csv' : 'images');
    if (kind === 'csv') {
      if (!csv) {
        toast.error('This run is driven by a CSV. Remove it to start from images instead.');
        return;
      }
      if (images.length) {
        toast.info(`Loaded ${csv.name} — the ${images.length} dropped image${images.length === 1 ? ' was' : 's were'} ignored.`);
      }
      handleFile(csv);
      return;
    }
    if (csv) {
      toast.error('This run is driven by images. Clear it to start from a CSV instead.');
      return;
    }
    void handleImageFiles(images);
  }

  // handleDrop closes over `mode`, and re-binding a window listener on every render to keep up
  // is noise; the ref is read at drop time so the listener never goes stale.
  const handleDropRef = React.useRef(handleDrop);
  React.useEffect(() => { handleDropRef.current = handleDrop; });

  const [pageDrag, setPageDrag] = React.useState(false);

  /**
   * Drop anywhere on the page, not only on the empty canvas. Once the first tiles exist the
   * canvas dropzone is gone, and a file dropped on the page would be handled by the BROWSER —
   * which navigates away and takes the whole run with it. Cleanup binds drops the same way.
   *
   * Grid mode is excluded deliberately: there, a sheet belongs to one band, and a drop on the
   * page cannot say which row it was meant for. Those bands keep their own zones.
   */
  React.useEffect(() => {
    if (running || gridMode) return;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      // A dropzone under the pointer has already claimed this hover (it calls preventDefault),
      // and it draws its own highlight — two at once reads as two targets.
      if (e.defaultPrevented) { setPageDrag(false); return; }
      e.preventDefault();
      setPageDrag(true);
    };
    // relatedTarget is null only when the pointer leaves the WINDOW, not on every child cross.
    const onDragLeave = (e: DragEvent) => { if (e.relatedTarget === null) setPageDrag(false); };
    const onDrop = (e: DragEvent) => {
      // Cleared unconditionally, before any bail-out: the highlight must not survive a drop
      // that a zone handled.
      setPageDrag(false);
      if (!hasFiles(e) || !e.dataTransfer) return;
      if (e.defaultPrevented) return; // a zone already imported it
      e.preventDefault();
      void filesFromDataTransfer(e.dataTransfer).then((files) => {
        if (files.length) handleDropRef.current(files);
      });
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [running, gridMode]);

  /**
   * Frees the blob URLs a set of rows is holding. Every path that drops a row goes through
   * this: an object URL keeps its image alive until it is revoked, so a cleared run of 500
   * would otherwise sit in memory until the tab closes.
   */
  function releaseLocalSources(rows: QueueItem[]) {
    rows.forEach((it) => it.localSources?.forEach((src) => URL.revokeObjectURL(src.url)));
  }

  /** The row's images under a mapping: every picked column that actually holds an http(s) URL. */
  function rowUrls(record: CsvRecord, imageCols: string[]): string[] {
    return imageCols.map((c) => record[c]).filter((u) => /^https?:\/\//i.test(u || ''));
  }

  /**
   * `rowStart` is the 1-based sheet position of `records[0]` — raising a band's tile count
   * appends the NEXT slice of its sheet, and those tiles must keep the row numbers they have in
   * that file rather than restarting at 1.
   */
  function buildQueue(
    records: CsvRecord[],
    imageCols: string[],
    titleCols: readonly string[],
    offerCol: string,
    opts: { bandId?: string; rowStart?: number } = {},
  ): QueueItem[] {
    const rowStart = opts.rowStart ?? 1;
    return records.map((record, i) => {
      const urls = rowUrls(record, imageCols);
      return {
        id: nextItemId.current++,
        row: rowStart + i,
        ...(opts.bandId ? { bandId: opts.bandId } : null),
        record, urls,
        title: joinNameColumns(record, titleCols),
        offer: offerCol ? record[offerCol] ?? '' : '',
        status: urls.length ? 'ready' : 'no-images',
        resultImage: null,
        compressed: null,
      };
    });
  }

  // ---- Banner grid bands ----

  /** The band an item belongs to, or undefined outside grid mode. */
  function bandOf(item: QueueItem): GridBand | undefined {
    return item.bandId ? gridBands.find((b) => b.id === item.bandId) : undefined;
  }

  /**
   * The template a tile is drawn with: its band's preset in grid mode, the shared one outside.
   * A band chooses a ratio, never a palette — the Colours panel is the batch's, so every band
   * wears its colours. Reading the preset raw would leave recolouring a no-op in grid mode.
   */
  function templateFor(item: QueueItem): TileTemplate {
    const band = bandOf(item);
    return band ? withTileColors(bandPreset(band.presetId).template, template) : template;
  }

  /** The Azure size to request for a tile — same rule as presetSize, asked per band. */
  function sizeFor(item: QueueItem) {
    const band = bandOf(item);
    return band ? bandPreset(band.presetId).azureSize : presetSize;
  }

  /**
   * The text rules a tile renders by. Batch-wide fallbacks are shared, but "is an offer column
   * mapped" is a property of the SHEET, so in grid mode it comes from the item's own band.
   */
  function rulesFor(item: QueueItem) {
    const band = bandOf(item);
    return {
      fallbackTitle: tplTitle,
      fallbackOffer: tplOffer,
      offerToggle: offerVisible,
      hasOfferCol: band ? !!band.offerCol : !!offerCol,
    };
  }

  /**
   * Replaces one band's slice of the queue, keeping the flat array grouped in band order so the
   * grid, shift-select and the export all read the rows in the order the panel lists them.
   */
  function setBandItems(bandId: string, next: QueueItem[]) {
    setItems((prev) => {
      const mine = new Map<string, QueueItem[]>();
      for (const band of gridBands) {
        mine.set(band.id, band.id === bandId ? next : prev.filter((it) => it.bandId === band.id));
      }
      return gridBands.flatMap((band) => mine.get(band.id) ?? []);
    });
  }

  function patchBand(id: string, patch: Partial<GridBand>) {
    updateBands((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  }

  /**
   * One band patch, routed to whichever handler that field needs. Shared because a band is
   * now edited from two places — its panel card and its canvas row header — and a patch must
   * mean the same thing whichever control sent it.
   */
  function applyBandPatch(band: GridBand, patch: Partial<GridBand>) {
    if (patch.presetId !== undefined) setBandPreset(band, patch.presetId);
    else if (patch.count !== undefined) setBandCount(band, patch.count);
    else if (patch.fileName === null) clearBandFile(band.id);
    else if (patch.imageCols || patch.titleCols !== undefined || patch.offerCol !== undefined) remapBand(band, patch);
    else patchBand(band.id, patch);
  }

  function addBand() {
    updateBands((prev) => [...prev, newBand()]);
  }

  function removeBand(id: string) {
    updateBands((prev) => prev.filter((b) => b.id !== id));
    setItems((prev) => prev.filter((it) => it.bandId !== id));
    setOpenId((prev) => (prev !== null && itemsRef.current.find((it) => it.id === prev)?.bandId === id ? null : prev));
    setCompressSummary('');
  }

  /** A CSV dropped in one band's area on the canvas. Only that band is touched. */
  function handleBandFile(bandId: string, file: File) {
    // Bands are sheet-driven — count, columns and offer text all come from the CSV — so they
    // stay CSV-only, and an image run must be cleared before one can take a sheet.
    if (mode === 'images') {
      toast.error('This run is driven by images. Clear it to load a CSV into a grid row.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const { headers, records } = parseCSV(String(reader.result));
      if (!headers.length || !records.length) { toast.error('CSV appears empty.'); return; }
      const imgCols = detectImageColumns(headers, records);
      const tCol = detectTitleColumn(headers, imgCols);
      const tCols = tCol ? [tCol] : [];
      const oCol = detectOfferColumn(headers, imgCols);
      const band = gridBands.find((b) => b.id === bandId);
      // A fresh sheet fills the row it landed in: as many tiles as the band's grid holds
      // (two full rows of it), or the whole sheet where it is smaller.
      const count = Math.min(records.length, (band?.columns ?? 4) * 2);
      setSessionName((prev) => (prev.trim() ? prev : file.name.replace(/\.[^.]+$/, '')));
      patchBand(bandId, {
        fileName: file.name, headers, records,
        imageCols: imgCols, titleCols: tCols, offerCol: oCol, count,
      });
      setBandItems(bandId, buildQueue(records.slice(0, count), imgCols, tCols, oCol, { bandId }));
    };
    reader.readAsText(file);
  }

  /** Removing a band's CSV empties the row without removing the row itself. */
  function clearBandFile(bandId: string) {
    patchBand(bandId, {
      fileName: null, headers: [], records: [], imageCols: [], titleCols: [], offerCol: '', count: 0,
    });
    setBandItems(bandId, []);
  }

  /**
   * The tile count is a window onto the band's sheet: lowering it drops the tail, raising it
   * appends the next rows. Tiles that survive keep their object identity, so lowering and
   * raising the count again never costs a generated tile.
   */
  function setBandCount(band: GridBand, count: number) {
    const capped = Math.min(Math.max(0, count), band.records.length);
    patchBand(band.id, { count: capped });
    const mine = items.filter((it) => it.bandId === band.id);
    if (capped <= mine.length) {
      setBandItems(band.id, mine.slice(0, capped));
      return;
    }
    const extra = buildQueue(
      band.records.slice(mine.length, capped),
      band.imageCols, band.titleCols, band.offerCol,
      { bandId: band.id, rowStart: mine.length + 1 },
    );
    setBandItems(band.id, [...mine, ...extra]);
  }

  /** One band's column mapping, re-derived in place exactly the way updateMapping does. */
  function remapBand(band: GridBand, patch: Partial<GridBand>) {
    const next = { ...band, ...patch };
    patchBand(band.id, patch);
    if (next.titleCols !== band.titleCols || next.offerCol !== band.offerCol) setCompressSummary('');
    setItems((prev) =>
      prev.map((it) =>
        it.bandId === band.id
          ? remapItem(it, next.imageCols, next.titleCols, next.offerCol)
          : it,
      ),
    );
  }

  /**
   * A band whose preset changed draws different pixels, so its cached PNG bytes are stale for
   * the same reason a template edit makes the shared queue's stale.
   */
  function setBandPreset(band: GridBand, presetId: string) {
    patchBand(band.id, { presetId });
    setItems((prev) =>
      prev.map((it) => (it.bandId === band.id && it.compressed ? { ...it, compressed: null } : it)),
    );
    setCompressSummary('');
  }

  /**
   * Remapping columns re-derives what a row IS, never what it has already produced. The queue is
   * index-aligned to the sheet — a mapping change can neither add, remove nor reorder a row — so
   * every item is patched in place and generated tiles, undo slots and in-flight statuses all
   * survive it. Rebuilding the queue here is what used to throw a whole finished batch away the
   * moment someone corrected the title column. (Generate remaps names the same way.)
   */
  function updateMapping(next: { imageCols?: string[]; titleCols?: string[]; offerCol?: string }) {
    const ic = next.imageCols ?? imageCols;
    const tc = next.titleCols ?? titleCols;
    const oc = next.offerCol ?? offerCol;
    if (next.imageCols) setImageCols(ic);
    if (next.titleCols !== undefined) setTitleCols(tc);
    if (next.offerCol !== undefined) setOfferCol(oc);
    // The summary describes bytes that some rows no longer have; it is re-earned on next export.
    if (tc !== titleCols || oc !== offerCol) setCompressSummary('');
    setItems((prev) => prev.map((it) => remapItem(it, ic, tc, oc)));
  }

  /** One row under a new mapping — the rule updateMapping and remapBand share. */
  function remapItem(it: QueueItem, ic: string[], tc: readonly string[], oc: string): QueueItem {
    // An image row has no record to remap; running the rule over it would read '' out of an
    // empty record and flip a perfectly loaded tile to 'no-images'.
    if (it.localSources?.length) return it;
    const urls = rowUrls(it.record, ic);
    const title = joinNameColumns(it.record, tc);
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
  }

  // ---- Generation ----
  // Azure round trips overlap freely, but background removal runs on the main thread through a
  // single model instance — two inferences interleaved through one session is undefined
  // behaviour. This chain lets exactly one removal run at a time while the network stays busy.
  const bgLock = React.useRef<Promise<unknown>>(Promise.resolve());

  /** An <img> for a URL this page already owns. Never revokes: the row outlives the run. */
  function decodeSrc(url: string, name: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Could not decode ${name}`));
      img.src = url;
    });
  }

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
      const turn = bgLock.current.then(() =>
        removeBackground(image, { model: activeModel, refine: false }),
      );
      bgLock.current = turn.catch(() => {});
      const { canvas } = await turn;
      return await canvasToImage(canvas);
    } catch (e) {
      toast.warning(`Row ${item.row}: tile generated without background removal — ${(e as Error).message}`);
      return image;
    }
  }

  /** `promptOverride` is one row's edit from its dialog — it never touches the shared prompt. */
  async function generateItem(item: QueueItem, signal?: AbortSignal, promptOverride?: string) {
    patchItem(item.id, { status: 'fetching', errorMsg: undefined });
    const images: HTMLImageElement[] = [];
    for (const u of item.urls) images.push(await loadImageFromUrl(u, signal));
    // A local row's blob URL is already minted and owned by the row, so this decodes it rather
    // than creating a second one — and nothing here has to release anything.
    for (const src of item.localSources ?? []) images.push(await decodeSrc(src.url, src.name));
    patchItem(item.id, { status: 'generating' });
    const runPrompt = promptOverride?.trim() || prompt;
    let resultImage: HTMLImageElement;
    if (mock) {
      await new Promise((r) => setTimeout(r, 600));
      resultImage = await mockComposite(images);
    } else {
      resultImage = await callAzure(images, { endpoint, apiKey: azureKey, prompt: runPrompt, size: sizeFor(item), signal });
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
    await runTiles(activeItems.filter((it) => it.urls.length), 'generated');
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
        endpoint, apiKey: azureKey, prompt: runPrompt, size: sizeFor(item), signal,
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
  /** The same selection seen the other way: rows with photos, which can be built from scratch. */
  const regenTargets = items.filter((it) => sel.checked.has(it.id) && it.urls.length);

  async function handleAiEditSelected(promptOverride: string, from: PromptSource = 'latest') {
    if (!guards()) return;
    // 'original' widens the run: rows with photos but no tile yet are legitimate targets for a
    // recomposite, and excluding them would silently drop rows the toolbar counted as selected.
    const todo =
      from === 'original'
        ? items.filter((it) => sel.checked.has(it.id) && it.urls.length)
        : aiEditTargets;
    if (!todo.length) return;
    const verb = from === 'original' ? 'regenerated' : 'edited';
    await runTiles(todo, verb, (item, signal) =>
      // Per row, not per run: a selection can offer both while one row has only its photos.
      resolvePromptSource(from, sourceChoices(item)) === 'latest'
        ? aiEditItem(item, signal, promptOverride)
        : generateItem(item, signal, promptOverride),
    );
    offerUndo(todo, verb);
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
    setItems((prev) => {
      releaseLocalSources(prev.filter((it) => sel.checked.has(it.id)));
      return prev.filter((it) => !sel.checked.has(it.id));
    });
    setOpenId((prev) => (prev !== null && sel.checked.has(prev) ? null : prev));
    sel.clear();
  }

  /** Full reset back to the drop zone. Session name survives, like Generate's clear. */
  function clearAll() {
    setItems((prev) => {
      releaseLocalSources(prev);
      return [];
    });
    // Emptying the list is what puts grid mode back on its seed row, so a clear still leaves
    // a drop area on the canvas.
    setBands([]);
    sel.clear();
    setOpenId(null);
    setFileName(null);
    setHeaders([]);
    setRecords([]);
    setImageCols([]);
    setTitleCols([]);
    setOfferCol('');
    setMode(null);
    setProgress(null);
    setCompressSummary('');
  }

  /**
   * What the original/last-generated toggle may offer for one row. Compose's two candidates are
   * not two versions of one picture: the original is the row's SOURCE PHOTOS, which rebuild the
   * tile from scratch, and the latest is the tile itself, which the prompt edits in place.
   */
  function sourceChoices(item: QueueItem) {
    return { hasLatest: !!item.resultImage, hasOriginal: item.urls.length > 0 };
  }

  async function handleRegenerate(
    item: QueueItem,
    promptOverride?: string,
    from: PromptSource = 'latest',
  ) {
    if (running) return;
    const controller = new AbortController();
    genAbortRef.current = controller;
    setRunning(true);
    // 'latest' edits the tile that is on screen; 'original' throws it away and recomposites
    // from the row's photos. Resolved against what the row actually has, so a row with no tile
    // yet still runs — as a first composite — instead of failing an edit with no input.
    const editing = resolvePromptSource(from, sourceChoices(item)) === 'latest';
    setProgress({ pct: 50, text: `${editing ? 'Editing' : 'Regenerating'} row ${item.row}…` });
    try {
      if (editing) await aiEditItem(item, controller.signal, promptOverride);
      else await generateItem(item, controller.signal, promptOverride);
      setProgress({ pct: 100, text: `Row ${item.row} ${editing ? 'edited' : 'regenerated'}.` });
    } catch (e) {
      if (isAbortError(e)) {
        patchItem(item.id, { status: item.status, errorMsg: undefined });
        setProgress({ pct: 100, text: `Row ${item.row} — stopped.` });
      } else {
        patchItem(item.id, { status: 'error', errorMsg: (e as Error).message });
        setProgress({ pct: 100, text: `Row ${item.row} failed: ${(e as Error).message}` });
      }
    }
    genAbortRef.current = null;
    setRunning(false);
  }

  // ---- Export: budget → shared local compress → ZIP, one action ----
  async function handleExport() {
    // Anything generated, whether or not its cell is currently mounted — export rasterises its
    // own canvas now, so it no longer depends on the grid having one on screen.
    const done = activeItems.filter((it) => it.status === 'done' && it.resultImage);
    // The grid's rules, snapshotted for the whole export: the tile you looked at is the tile
    // that ships, and editing a field mid-encode must not give the ZIP two different answers.
    // Per item, not per batch — in Banner grid mode each band brings its own sheet, template
    // and offer mapping.
    const plan = new Map(done.map((it) => [
      it.id,
      { template: templateFor(it), rules: rulesFor(it) },
    ]));
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
        const sheet = plan.get(item.id)!;
        renderTile(
          canvas,
          { ...tileOptsFor(item, sheet.rules), image: item.resultImage },
          sheet.template,
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
          toast.error(`Row ${item.row}: ${(e as Error).message}`);
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
        const base = (item.title || `tile-${item.row}`).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || `tile-${item.row}`;
        // A banner grid ships as folders, one per row of the grid, so the ZIP has the same
        // shape on disk as the grid has on screen. Outside grid mode the prefix is empty and
        // the ZIP is flat, exactly as before.
        const bandIndex = item.bandId ? gridBands.findIndex((b) => b.id === item.bandId) : -1;
        const folder = bandIndex >= 0 ? `row-${bandIndex + 1}/` : '';
        let name: string;
        if (numberFiles) {
          name = `${folder}${String(item.row).padStart(2, '0')}-${base}.png`;
        } else {
          // Repeated titles get -2, -3 so nothing in the ZIP is silently overwritten. Counted
          // per folder: the same title in two rows of the grid is not a collision.
          const key = `${folder}${base}`;
          const seen = (used.get(key) ?? 0) + 1;
          used.set(key, seen);
          name = seen === 1 ? `${folder}${base}.png` : `${folder}${base}-${seen}.png`;
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
            .map(({ item, result }) => `${item.title || `row ${item.row}`} (${describeBudget(result)})`)
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

  const doneCount = activeItems.filter((it) => it.status === 'done').length;
  const canGenerate = activeItems.some((it) => it.urls.length);
  // Greyed out with a reason beats erroring on click — same gate as Cleanup's AI edit.
  const aiReady = mock || (endpoint.trim().length > 0 && azureKey.trim().length > 0);

  // The template preview answers "what will my tiles look like", so once a sheet is in it
  // renders the first row by exactly the rules the grid and the export use. With no sheet there
  // is nothing to render, so SAMPLE_* stands in — placeholder for a preview, never for a tile.
  // In grid mode there is no single frame to quote, so the hint speaks for row 1 — the rows
  // differ only in ratio, and the scale is what the control actually sets.
  const exportFrame = (gridMode ? bandPreset(gridBands[0].presetId).template : template).frame;
  // Same long-side rule renderTile uses, so the quoted size is the size that lands on disk.
  const exportBox = EXPORT_SIZE * exportScale;
  const exportLongSide = Math.max(exportFrame.width, exportFrame.height);
  const exportPx = {
    w: Math.round((exportBox * exportFrame.width) / exportLongSide),
    h: Math.round((exportBox * exportFrame.height) / exportLongSide),
  };

  const previewRow = activeItems[0];
  const previewTitle = previewRow?.title || tplTitle;
  const previewOffer = previewRow?.offer || tplOffer;
  const previewOfferVisible =
    offerVisible && (!previewRow || !!previewRow.offer.trim() || !offerCol);
  // Which columns the preview is reading, for the line under the two text fields. The offer is
  // named only where there is a bar to draw it in, so the line never credits a hidden layer.
  const mappedText = [
    titleCols.length && `title from ${titleCols.join(' + ')}`,
    template.offer.visible && offerCol && `offer from ${offerCol}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="flex min-h-dvh flex-col">
      {/* The only sign that a page-wide drop will be caught. Without it, dragging a folder over
          a canvas already full of tiles looks exactly like dragging it over a page that will
          refuse — pointer-events-none so it never eats the drop it is advertising. */}
      {pageDrag && (
        <div className="pointer-events-none fixed inset-0 z-50 rounded-lg ring-2 ring-primary ring-inset">
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-lg bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md">
            {mode === 'csv' ? 'Drop a CSV to replace this run' : 'Drop images or a folder'}
          </div>
        </div>
      )}

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
                  gridMode
                    ? { label: `${gridBands.length} grid row${gridBands.length === 1 ? '' : 's'}` }
                    : records.length > 0 && { label: `${records.length} row${records.length === 1 ? '' : 's'}` },
                  activeItems.length > 0 && { label: `${doneCount}/${activeItems.length} tiles` },
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
                    value={gridMode ? 'grid' : activePreset?.type ?? CUSTOM_PRESET_ID}
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
                      <SelectItem value={CUSTOM_PRESET_ID} disabled={gridMode || presetId !== CUSTOM_PRESET_ID}>
                        Custom
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                {/* One shared ratio is meaningless in grid mode — each band picks its own,
                    in its own row item below. */}
                {!gridMode && activePreset && (
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
              {!gridMode && (
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
              )}
            </PanelSection>

          {/* The banner grid itself: one row item per band, each pairing with its own drop area
              on the canvas. Changing a row's preset moves only that row's tiles. */}
          {gridMode && (
            <PanelSection
              title="Grid rows"
              hint="Each row is a band of banner tiles with its own CSV. The plus adds another; its drop area appears under the last one on the canvas."
              action={
                <Button variant="ghost" size="icon-sm" disabled={running} onClick={addBand} aria-label="Add row">
                  <PlusIcon />
                </Button>
              }
              className="space-y-3"
            >
              {gridBands.map((band, i) => (
                <BandCard
                  key={band.id}
                  band={band}
                  index={i}
                  total={gridBands.length}
                  tiles={items.filter((it) => it.bandId === band.id).length}
                  disabled={running}
                  onReplaceCsv={(file) => handleBandFile(band.id, file)}
                  onRemove={() => removeBand(band.id)}
                  onChange={(patch) => applyBandPatch(band, patch)}
                />
              ))}
              <Button variant="outline" className="w-full" disabled={running} onClick={addBand}>
                <PlusIcon data-icon="inline-start" />
                Add row
              </Button>
            </PanelSection>
          )}
          {!gridMode && mode === 'csv' && fileName && (
            <PanelSection title="CSV file">
              {/* Only once there IS a file. The drop target lives in the canvas now, so an
                  empty slot here would offer a second route to the same act. */}
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
                      Clears all {activeItems.length} row{activeItems.length === 1 ? '' : 's'}
                      {doneCount > 0 && <> and the {doneCount} generated tile{doneCount === 1 ? '' : 's'} (not exported anywhere yet)</>}
                      . Your CSV file on disk is untouched — drop it again to rebuild the queue.
                    </>
                  ),
                }}
              />
            </PanelSection>
          )}

          {!gridMode && mode === 'images' && (
            <PanelSection
              title="Images"
              hint="One tile per image. There are no columns to map — each tile is titled by its file name, which is also what names it in the export."
            >
              <Item variant="outline" className="gap-3">
                <ItemMedia variant="icon">
                  <ImagesIcon />
                </ItemMedia>
                <ItemContent className="min-w-0 gap-0.5">
                  <ItemTitle>
                    {imageItemCount.toLocaleString()} image{imageItemCount === 1 ? '' : 's'}
                  </ItemTitle>
                  <ItemDescription className="truncate">
                    Drop more anywhere on the page to add to the run.
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <ClearAllButton
                    disabled={running}
                    onConfirm={clearAll}
                    title="Clear the images?"
                    description={
                      <>
                        Removes all {activeItems.length} tile{activeItems.length === 1 ? '' : 's'}
                        {doneCount > 0 && <> and the {doneCount} generated tile{doneCount === 1 ? '' : 's'} (not exported anywhere yet)</>}
                        . Your files on disk are untouched — drop them again to rebuild the queue.
                      </>
                    }
                  />
                </ItemActions>
              </Item>
            </PanelSection>
          )}

          {/* The tile above carries the file name; repeating it in this title just made two
              rows disagree about truncation. */}
          {!gridMode && headers.length > 0 && (
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
                    <FieldLabel htmlFor="title-col">Title columns</FieldLabel>
                    <ColumnPicker
                      id="title-col"
                      columns={headers}
                      selected={titleCols}
                      onChange={(next) => updateMapping({ titleCols: next })}
                      disabled={running}
                      placeholder="None — no title drawn"
                    />
                    <FieldDescription>
                      Several columns are joined with a dash, in the sheet&rsquo;s column order.
                    </FieldDescription>
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

            {gridMode ? (
              /* One block per band, stacked in panel order: the row item on the left and its
                 own drop area here are the two halves of the same thing, so a CSV can only ever
                 land in the row it was dropped on. */
              <div className="flex flex-col gap-6">
                {gridBands.map((band, i) => {
                  const bandItems = items.filter((it) => it.bandId === band.id);
                  // What this band DRAWS. bandItems stays whole above so the band's own counts and
                  // its row-count control keep describing the band rather than the search.
                  const bandVisible = searchIn(bandItems);
                  const preset = bandPreset(band.presetId);
                  const bandDone = bandItems.filter((it) => it.status === 'done').length;
                  return (
                    <section key={band.id} aria-label={`Row ${i + 1}`} className="flex flex-col gap-2">
                      {/* Identity on the left, size on the right: the header says which row this
                          is and what feeds it, then hands you the two numbers that reshape the
                          grid directly beneath it. min-h-7 so a row with no tile field (no CSV
                          yet) sits at the same height as one with. */}
                      <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1">
                        <h2 className="text-sm font-semibold">Row {i + 1}</h2>
                        <span className="text-xs text-muted-foreground">
                          {preset.ratio}
                          {band.fileName ? ` · ${band.fileName}` : ''}
                          {bandDone ? ` · ${bandDone} generated` : ''}
                        </span>
                        <RowSizeControls
                          band={band}
                          disabled={running}
                          onChange={(patch) => applyBandPatch(band, patch)}
                          className="ml-auto"
                        />
                      </div>
                      {bandItems.length ? (
                        <TileGrid
                          items={bandVisible}
                          template={preset.template}
                          columns={band.columns}
                          fallbackTitle={tplTitle}
                          fallbackOffer={tplOffer}
                          offerToggle={offerVisible}
                          hasOfferCol={!!band.offerCol}
                          running={running}
                          selected={sel.checked}
                          onOpen={(item) => setOpenId(item.id)}
                          onRemove={(item) => {
                            setBandItems(band.id, bandItems.filter((it) => it.id !== item.id));
                            setOpenId((prev) => (prev === item.id ? null : prev));
                          }}
                          onToggleSelect={sel.toggle}
                        />
                      ) : (
                        <DropzoneShell
                          accept=".csv,text/csv"
                          disabled={running}
                          onFiles={(files) => handleBandFile(band.id, files[0])}
                          className="min-h-32 justify-center"
                        >
                          {/* The row's own shape, at its own ratio and count — an empty dashed
                              box could not say what picking a ratio had just decided. */}
                          {/* `count` is 0 until a sheet lands, so an empty band shows the two
                              full rows it would draw — the same promise the old copy made in
                              words, made in the tiles themselves instead. */}
                          <TileGridSkeleton
                            template={preset.template}
                            columns={band.columns}
                            count={band.count || band.columns * 2}
                            className="mb-1"
                          />
                          {/* Preflight makes bare <svg> display:block, so the icon needs its own
                              flex row to sit beside the copy instead of stacking above it. */}
                          <span className="flex items-center gap-1.5 font-medium text-foreground">
                            <FileSpreadsheetIcon className="size-4 shrink-0 text-muted-foreground" />
                            <span>
                              Drop row {i + 1}&rsquo;s CSV here, or{' '}
                              <span className="font-normal text-primary underline underline-offset-2">browse</span>
                            </span>
                          </span>
                        </DropzoneShell>
                      )}
                    </section>
                  );
                })}
                <Button variant="outline" className="self-start" disabled={running} onClick={addBand}>
                  <PlusIcon data-icon="inline-start" />
                  Add row
                </Button>
                {sel.active && (
                  <SelectionBar
                    count={sel.checked.size}
                    total={activeItems.length}
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
                    deleteTitle={`Delete ${sel.checked.size} tile${sel.checked.size === 1 ? '' : 's'}?`}
                    deleteDescription="Removes them from the grid, along with anything they generated. Raising a row's tile count brings its rows back from the CSV."
                    onDelete={deleteSelected}
                    onSelectAll={sel.selectAll}
                    onClear={sel.clear}
                  />
                )}
              </div>
            ) : activeItems.length === 0 ? (
              <CanvasDropzone
                icon={<FileSpreadsheetIcon />}
                title="Drop a CSV or images to start"
                description="A CSV makes one tile per row, from columns you map in the panel. Images make one tile each — drop a folder and everything inside it comes in."
                accept=".csv,text/csv,image/*"
                multiple
                disabled={running}
                onFiles={handleDrop}
              >
                {/* Dropping a folder already works; browsing to one needs its own control,
                    because a file input is either a file picker or a folder picker. */}
                <FolderInputButton onFiles={handleDrop} disabled={running} className="mt-1" />
              </CanvasDropzone>
            ) : (
              <>
                  {/* Grid toolbar: count on the left, whole-run reset on the right. */}
                <CanvasToolbar className="justify-between">
                  <span className="text-xs text-muted-foreground">
                    {sel.active
                      ? `${sel.checked.size} of ${visibleItems.length} selected`
                      : search
                        ? `${visibleItems.length} of ${activeItems.length} row${activeItems.length === 1 ? '' : 's'}`
                        : `${activeItems.length} row${activeItems.length === 1 ? '' : 's'}${doneCount ? ` · ${doneCount} generated` : ''}`}
                  </span>
                  <div className="flex items-center gap-2">
                    <QueueSearch value={search} onChange={setSearch} placeholder="Search tiles" />
                  <ClearAllButton
                    title="Clear this run?"
                    disabled={running}
                    onConfirm={clearAll}
                    description={
                      <>
                        Removes all {activeItems.length} row{activeItems.length === 1 ? '' : 's'}
                        {doneCount > 0 && <> and the {doneCount} generated tile{doneCount === 1 ? '' : 's'} (not exported anywhere yet)</>}
                        . Your CSV file on disk is untouched — drop it again to rebuild the
                        queue.
                      </>
                    }
                  />
                  </div>
                </CanvasToolbar>
                {search && visibleItems.length === 0 ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
                    <p className="text-sm text-muted-foreground">
                      No rows match &ldquo;{search}&rdquo;.
                    </p>
                    <Button variant="outline" size="sm" onClick={() => setSearch('')}>
                      Show all {activeItems.length} row{activeItems.length === 1 ? '' : 's'}
                    </Button>
                  </div>
                ) : (
                <TileGrid
                  items={visibleItems}
                  template={template}
                  fallbackTitle={tplTitle}
                  fallbackOffer={tplOffer}
                  offerToggle={offerVisible}
                  hasOfferCol={!!offerCol}
                  running={running}
                  selected={sel.checked}
                  onOpen={(item) => setOpenId(item.id)}
                  onRemove={(item) => {
                    releaseLocalSources([item]);
                    setItems((prev) => prev.filter((it) => it.id !== item.id));
                    setOpenId((prev) => (prev === item.id ? null : prev));
                  }}
                  onToggleSelect={sel.toggle}
                />
                )}
                {sel.active && (
                  <SelectionBar
                    count={sel.checked.size}
                    total={visibleItems.length}
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
                        {gridMode
                          ? `Row 1's tiles export at ${exportPx.w.toLocaleString()} × ${exportPx.h.toLocaleString()} px; other rows follow their own ratio.`
                          : `PNGs export at ${exportPx.w.toLocaleString()} × ${exportPx.h.toLocaleString()} px.`}
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
                      <Switch
                        id="co-number-files"
                        checked={numberFiles}
                        disabled={running}
                        onCheckedChange={(checked) => setNumberFiles(checked === true)}
                      />
                    </Field>

                  </FieldGroup>
          </PanelSection>
        </RightPanel>
      </StudioShell>

      <BatchPromptDialog
        open={aiBatchOpen}
        onOpenChange={setAiBatchOpen}
        defaultPrompt={prompt}
        count={(from) => (from === 'original' ? regenTargets : aiEditTargets).length}
        noun="tile"
        busy={running}
        excludedNote={(from) => {
          const reached = (from === 'original' ? regenTargets : aiEditTargets).length;
          const skipped = sel.checked.size - reached;
          if (skipped <= 0) return undefined;
          const missing = from === 'original' ? 'no image URLs' : 'no finished tile yet';
          return `${skipped} selected row${skipped === 1 ? ' has' : 's have'} ${missing} and ${skipped === 1 ? 'is' : 'are'} left out.`;
        }}
        source={{
          latestLabel: 'Generated tile',
          originalLabel: 'Source images',
          hasLatest: aiEditTargets.length > 0,
          hasOriginal: regenTargets.length > 0,
          note: 'The tile edits what is already there; the source images rebuild it from scratch.',
        }}
        onRun={(p, from) => void handleAiEditSelected(p, from)}
      />

      {/* Prompt editor — same .md-tile-opens-modal pattern as Cleanup's AI-edit prompt. */}
      <Dialog open={promptEditorOpen} onOpenChange={setPromptEditorOpen}>
        <DialogContent className="sm:max-w-3xl">
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
        template={openItem ? templateFor(openItem) : template}
        fallbackTitle={tplTitle}
        fallbackOffer={tplOffer}
        offerToggle={offerVisible}
        hasOfferCol={openItem ? rulesFor(openItem).hasOfferCol : !!offerCol}
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


