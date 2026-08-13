'use client';

import * as React from 'react';
import { toast } from 'sonner';
import {
  CircleAlertIcon,
  CircleStopIcon,
  CloudDownloadIcon,
  DownloadIcon,
  FrameIcon,
  ImagesIcon,
  RefreshCwIcon,
  SaveIcon,
  TriangleAlertIcon,
  WandSparklesIcon,
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { MdFileIcon, MdFileTile } from '@/components/md-file-tile';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { SessionHeader, type SessionChip } from '@/components/session-header';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/hint';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle,
} from '@/components/ui/empty';
import {
  Field, FieldContent, FieldDescription, FieldGroup, FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

import { ResultCell } from '@/components/result-cell';
import { BUDGET_KB_MIN, BudgetControls } from '@/components/budget-controls';
import { ClearAllButton, SelectionBar, useGridSelection } from '@/components/selection';
import { Canvas, LeftPanel, PanelSection, RightPanel, StudioShell } from '@/components/pane-layout';
import { useProcessing } from '@/components/process-panel';
import {
  CompareDialog, CutoutImage, SourceImage, backdropStyle, statusLine,
} from '@/components/bg-remover/bg-queue-list';
import { ImageDropzone, type CsvPayload } from '@/components/bg-remover/image-dropzone';
import { SafeAreaControls } from '@/components/bg-remover/safe-area-controls';
import { TilePreview } from '@/components/bg-remover/tile-preview';
import { VirtualGrid } from '@/components/bg-remover/virtual-grid';

import {
  BG_MODELS, BG_MODEL_ORDER, DEFAULT_MODEL_ID, getModelBackend, isModelLoaded,
  probeServerModel, removeBackground, warmModel,
  type BgModelId, type LoadProgress, type RemoveResult, type RemoveStage,
} from '@/lib/bg/engine';
import {
  DEFAULT_SAFE_AREA, TRANSPARENT, renderTile, scaleBounds, subjectBounds,
  type SafeAreaConfig,
} from '@/lib/bg/safe-area';
import {
  SETUP_HINT, canRetry, canvasToPngBlob, canvasToPngBytes, createItems, csvCellKey, describeDownload, draftsFromCsv, errorMessage,
  exportFileNames, flattenOnBackground, formatKb, isAbortError,
  decodeCutout, loadImageFromFile, looksLikeMissingWeights, mapWithLimit, needsCutout,
  nextItemId, pickSave, previewScale, releaseCanvas, releaseItem, releaseOriginal, sameCsvOrigin, saveTo, withCutout,
  type BgItem, type BgItemDraft, type BgItemSource, type BgItemStatus,
} from '@/lib/bg/batch';
import { useAutosave, type AutosaveRecord } from '@/lib/bg/autosave';
import { measureFaintResidue } from '@/lib/bg/regions';
import { describeBudget, fitToBudget, type BudgetResult } from '@/lib/bg/budget';
import { isPng8Supported } from '@/lib/bg/png8';
import {
  disposePool, getPoolBackend, isPoolSupported, poolRemoveBackground, warmPool,
  type PoolCutout,
} from '@/lib/bg/pool';
import { PROJECT_EXTENSION, loadProject, saveProject } from '@/lib/bg/project';
import { assessQuality, countFlagged, sortByQuality } from '@/lib/bg/quality';
import { readParallel } from '@/lib/rate';
import { createEta } from '@/lib/eta';
import { DEFAULT_AI_PROMPT, matchSkill, useSkills } from '@/lib/skills';
import { clearPreviews, dropPreview, usePreview } from '@/lib/bg/preview-store';
import { STORE_TYPE } from '@/lib/bg/constants';
import { callAzure, loadImageFromUrl, mockComposite } from '@/lib/pipeline';
import { buildZipStream, type ZipStreamEntry } from '@/lib/zip';
import { cn } from '@/lib/utils';
import { usePersistedState } from '@/hooks/use-persisted-state';

const WHITE = '#ffffff';
const DEFAULT_CUSTOM_BG = '#f4f4f5';
// Select sentinel for "no name column" — Base UI Select values must be non-empty strings.
const NONE = '__none__';
// Two pooled workers plus two images decoding ahead of them.
const POOL_CONCURRENCY = 4;
// Bounds how many full-size canvases are encoding at once during export.
const ENCODE_CONCURRENCY = 8;
// TinyPNG rate-limits; stay well under the encode fan-out.
const COMPRESS_CONCURRENCY = 4;
// PNG size budget. The ceiling is tuned in 50 KB steps because that is the granularity the CDN
// conversation happens at; MIN is a floor the export re-applies, since a number input does not
// enforce `min` on a typed value.
const BUDGET_KB_DEFAULT = 150;

// Names listed in a budget toast before it collapses into "+N more".
const BUDGET_TOAST_NAMES = 3;
// Decode edges for the two tile previews. Both go through the shared preview cache.
const TILE_PREVIEW_EDGE = 512;
// Result-grid geometry. Rows must be uniform for windowing, so these are fixed rather than
// breakpoint-driven; the column count is measured from the pane width instead.
const GRID_MIN_CELL = 150;
const GRID_GAP = 14;
// Two text lines now: the name and the status line the old queue rows carried.
const GRID_LABEL_HEIGHT = 40;
/** Settings a single redo may override without touching the global ones. */
interface RunOverrides {
  model?: BgModelId;
  refine?: boolean;
}

// Ships as the AI-edit prompt so the flow works out of the box. The reference image carries the
// product's identity, so one generic prompt covers every SKU; fidelity comes first and loudest
// because label drift (garbled pack text) is the model's main failure mode on catalogue work.
// DEFAULT_AI_PROMPT moved to lib/skills.ts — it's a shared built-in skill now.

// Parallel Azure requests during "AI-fix flagged": suite-wide, from Settings → Image model
// (lib/rate.ts) — this was a local constant (6) before the knob moved there.

/** Padding around the hero region's bbox when focus-cropping the AI-edit reference. */
const HERO_CROP_PAD = 0.08;
/** Skip the crop when the hero already covers this much of the frame — nothing to gain. */
const HERO_CROP_MAX_COVERAGE = 0.9;

/**
 * Crop the AI-edit reference down to the hero region before it goes to Azure.
 *
 * The images/edits endpoint anchors hard to the reference's composition: four prompt versions
 * all failed to talk it out of reproducing a bowl of pieces sitting next to the product. The
 * reliable fix is to never show it the props — crop to the largest region the matte kept (the
 * product cluster) and the model cannot draw what it never saw. Falls back to the whole-subject
 * bbox when product-only analysis didn't run, and to the uncropped source when there is no
 * cutout data or the crop would keep ~the whole frame anyway. Known limit: pieces that touch
 * the product merge into one region, and a crop cannot split those apart.
 */
async function cropToHero(item: BgItem, source: HTMLImageElement): Promise<HTMLImageElement> {
  const cutout = item.cutout;
  if (!cutout || !cutout.width || !cutout.height) return source;
  const kept = item.regionReport?.filter((r) => !r.removed) ?? [];
  const hero = kept.length
    ? kept.reduce((m, r) => (r.area > m.area ? r : m)).bounds
    : cutout.bounds;
  if (!hero) return source;

  // Region bounds live in cutout (post-cap) space; the reference is the original source image.
  const sx = source.naturalWidth / cutout.width;
  const sy = source.naturalHeight / cutout.height;
  const padX = hero.w * HERO_CROP_PAD;
  const padY = hero.h * HERO_CROP_PAD;
  const x0 = Math.max(0, Math.floor((hero.x - padX) * sx));
  const y0 = Math.max(0, Math.floor((hero.y - padY) * sy));
  const x1 = Math.min(source.naturalWidth, Math.ceil((hero.x + hero.w + padX) * sx));
  const y1 = Math.min(source.naturalHeight, Math.ceil((hero.y + hero.h + padY) * sy));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 2 || h < 2) return source;
  if ((w * h) / (source.naturalWidth * source.naturalHeight) >= HERO_CROP_MAX_COVERAGE) {
    return source;
  }

  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.drawImage(source, x0, y0, w, h, 0, 0, w, h);
  const url = c.toDataURL('image/png');
  releaseCanvas(c);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Hero crop decode failed'));
    img.src = url;
  });
}


// Rebuilds a queue item from a crash-recovery record — the same shape project restore uses.
// URL sources come back as URLs (redo works); AI-regenerated files come back as files (their
// bytes were saved because they cost an Azure call); everything else is provenance-only.
function itemFromAutosave(record: AutosaveRecord, id: number): BgItem {
  const source: BgItemSource = record.sourceUrl
    ? { kind: 'url', url: record.sourceUrl }
    : record.sourceFile
      ? {
          kind: 'file',
          file: new File([record.sourceFile], record.sourceFileName || `${record.name}.png`, {
            type: record.sourceFile.type || 'image/png',
          }),
          regenerated: true,
        }
      : { kind: 'archived', label: record.origin };
  return {
    id,
    name: record.name,
    source,
    original: null,
    cutout: record.cutout
      ? { blob: record.cutout, bounds: record.bounds, width: record.width, height: record.height }
      : null,
    // A record without a cutout is an AI-regenerated source that crashed before re-removal —
    // it comes back queued, one "Remove backgrounds" away from where it left off.
    status: record.cutout ? 'done' : 'ready',
  };
}

export default function BgRemover() {
  // Tile fit is a processing switch on the right pane now, not a mode of its own.
  const [tileFitOn, setTileFitOn] = usePersistedState('skuc_bgTileFit', false);
  // The global toggle is only the DEFAULT — items can pin themselves on/off from the selection
  // bar. Every render/export decision goes through this, never through tileFitOn directly.
  const effectiveTileFit = React.useCallback(
    (item: BgItem) => item.tileFit ?? tileFitOn,
    [tileFitOn],
  );

  // ---- Settings (persisted) ----
  const [storedModel, setModelId] = usePersistedState<BgModelId>('skuc_bgModel', DEFAULT_MODEL_ID);
  const [refine, setRefine] = usePersistedState('skuc_bgRefine', false);
  // Second inference on a tight subject crop for sharper edges. Off by default: it doubles the
  // per-image cost, which is the wrong trade for a batch.
  const [highDetail, setHighDetail] = usePersistedState('skuc_bgHighDetail', false);
  // Drops flat graphic panels (colour strips, badges) the matte kept as foreground. Off by
  // default: it is a heuristic, so it only ever runs where it was asked for.
  const [productOnly, setProductOnly] = usePersistedState('skuc_bgProductOnly', false);
  // Continuously sends newly flagged cutouts through the AI edit, no button press per wave.
  // Off by default: every send spends Azure money, so the standing order has to be explicit.
  const [autoAiFix, setAutoAiFix] = usePersistedState('skuc_bgAutoAiFix', false);
  const [outputBg, setOutputBg] = usePersistedState('skuc_bgOutput', TRANSPARENT);
  // Save-project scope: embedding dropped files makes a .zesku self-contained (v2); off keeps
  // only cutouts + URLs for huge batches.
  // Toggled from Settings (the user moved the checkbox there); read-only here.
  const [saveOriginals] = usePersistedState('skuc_bgSaveOriginals', true);
  const [safeArea, setSafeArea] = usePersistedState<SafeAreaConfig>('skuc_bgSafeArea', DEFAULT_SAFE_AREA);
  // Azure credentials are the compositor's own keys, read from the same storage so the two
  // products never hold different values; only the default prompt is this product's.
  const [azureEndpoint] = usePersistedState('skuc_azureEndpoint', '');
  const [azureKey] = usePersistedState('skuc_azureKey', '');
  // Crop the AI-edit reference to the hero region so the model never sees scene props. On by
  // default — it is the only lever that has actually beaten the edit endpoint's layout anchor.
  const [aiFocusCrop, setAiFocusCrop] = usePersistedState('skuc_bgAiFocusCrop', true);
  const [storedAiPrompt, setAiPrompt] = usePersistedState('skuc_bgAiPrompt', DEFAULT_AI_PROMPT);
  // A blank stored prompt (saved before the default existed, or cleared) falls back to the
  // default — with a bulk AI-fix button on the page, "no prompt" must never be a reachable state.
  const aiPrompt = storedAiPrompt.trim() ? storedAiPrompt : DEFAULT_AI_PROMPT;
  const promptCustomised = aiPrompt.trim() !== DEFAULT_AI_PROMPT.trim();
  // Skill-driven, preset-style like Compose: the tile's caret menu derives which skill the
  // current text equals; editing the text flips it to Custom without losing anything.
  const { skills } = useSkills();
  const aiSkillId = matchSkill(aiPrompt, skills);
  const activeAiSkill = skills.find((sk) => sk.id === aiSkillId);
  // The AI-edit card shows the prompt as a compact .md tile; this opens its editor modal.
  const [promptEditorOpen, setPromptEditorOpen] = React.useState(false);
  // PNG file-size ceiling. Off by default: on, an export can lose colours or pixels, and that
  // has to be something the user asked for rather than something they discover on the CDN.
  const [budgetOn, setBudgetOn] = usePersistedState('skuc_bgBudgetOn', false);
  const [budgetKb, setBudgetKb] = usePersistedState('skuc_bgBudgetKb', BUDGET_KB_DEFAULT);
  const [budgetShrink, setBudgetShrink] = usePersistedState('skuc_bgBudgetShrink', true);
  // Zero-padded position in front of each exported filename. On by default: one CSV row can
  // yield several images sharing a title, and without it they collide inside the ZIP.
  const [numberFiles, setNumberFiles] = usePersistedState('skuc_bgNumberFiles', true);

  // isPng8Supported() reads a browser global, so it must not decide the server-rendered markup.
  // Same mount-gate trick as components/theme-toggle.tsx.
  const png8Ready = React.useSyncExternalStore(
    React.useCallback(() => () => {}, []),
    isPng8Supported,
    () => false,
  );
  // A stored `true` must not arm the budget on a runtime that cannot quantise: without PNG-8 the
  // ladder has no rungs, so the export would silently be today's export under a different label.
  const budgetActive = budgetOn && png8Ready;
  // `min` on a number input constrains the spinner, not what can be typed — and localStorage can
  // hold anything at all — so the value the export actually uses is resolved here, not at edit
  // time, where re-clamping on every keystroke would fight the user mid-type.
  const budgetKbSafe = Number.isFinite(budgetKb)
    ? Math.max(BUDGET_KB_MIN, Math.round(budgetKb))
    : BUDGET_KB_DEFAULT;

  // ---- Queue ----
  const [items, setItems] = React.useState<BgItem[]>([]);
  // Crash recovery: mirrors finished work into IndexedDB and offers the previous session back
  // after a crash. Declared against `items` so every mutation path syncs through one place.
  const {
    pending: autosavePending,
    restore: restoreAutosave,
    discard: discardAutosave,
    lastSavedAt: autosavedAt,
    failing: autosaveFailing,
  } = useAutosave(items);

  // Figma-style "file name" for the session, shown in the panel header. Working state, not
  // decoration: it seeds the .zesku and export ZIP filenames. Auto-seeded from the first
  // CSV/project file dropped, but never over a name the user already typed.
  const [sessionName, setSessionName] = React.useState('');
  const sessionSlug = sessionName.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  const seedSessionName = React.useCallback((fileName: string) => {
    setSessionName((prev) => (prev.trim() ? prev : fileName.replace(/\.[^.]+$/, '')));
  }, []);

  // Restore/discard is asked in a BLOCKING dialog, not a toast. The old corner toast was
  // ignorable, and while the decision is pending, autosave holds ALL writes — an ignored
  // toast meant entire sessions ran with crash protection silently off. The dialog closes
  // only through one of its two buttons.
  const handleRestoreAutosave = React.useCallback(() => {
    void restoreAutosave().then((records) => {
      if (!records.length) return; // second click of a double-click — nothing left to restore
      setItems((prev) => {
        const base = nextItemId(prev);
        return [...prev, ...records.map((r, i) => itemFromAutosave(r, base + i))];
      });
      toast.success(`Restored ${records.length} image${records.length === 1 ? '' : 's'}.`);
    });
  }, [restoreAutosave]);
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  // Display-only reordering for the results grid — never touches `items`, so export naming and
  // retry-by-id are unaffected. Worst-first; ties keep queue order (Array#sort is stable).
  const [qualitySort, setQualitySort] = React.useState(false);
  const flaggedCount = React.useMemo(() => countFlagged(items), [items]);
  // What "AI-fix flagged" operates on. Archived items are excluded — they have no original
  // image left to send to the model.
  const flaggedItems = React.useMemo(
    () => items.filter((item) => canRetry(item) && assessQuality(item).level !== 'ok'),
    [items],
  );
  const displayItems = React.useMemo(
    () => (qualitySort ? sortByQuality(items) : items),
    [items, qualitySort],
  );

  // ---- Run state ----
  const [running, setRunning] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [warming, setWarming] = React.useState(false);
  /** True while "AI-fix flagged" is mid-flight through Azure (before the re-removal batch). */
  const [aiFixing, setAiFixing] = React.useState(false);
  /** The removal run's line. Owned by runBatchInner alone — see exportProgress. */
  const [progress, setProgress] = React.useState<{ pct: number; text: string } | null>(null);
  /** The Azure phase's own progress line — it may run concurrently with a removal batch. */
  const [aiProgress, setAiProgress] = React.useState<{ pct: number; text: string } | null>(null);
  /**
   * The export's own line. Separate from `progress` because the two phases can be live at the
   * same time once a finished batch is downloadable while a later one still runs: sharing one
   * bar meant the encode counter and the run's ETA overwrote each other every tick.
   */
  const [exportProgress, setExportProgress] = React.useState<{ pct: number; text: string } | null>(
    null,
  );
  const [download, setDownload] = React.useState<LoadProgress | null>(null);
  const [stage, setStage] = React.useState<RemoveStage | null>(null);
  const [setupError, setSetupError] = React.useState<string | null>(null);
  const [compressSummary, setCompressSummary] = React.useState('');

  // ---- Model availability ----
  const [serverUp, setServerUp] = React.useState<boolean | null>(null);
  // isModelLoaded() reads a module cache that React cannot subscribe to; this list is what
  // re-renders the "ready" affordance after a download finishes.
  const [loadedModels, setLoadedModels] = React.useState<BgModelId[]>([]);

  // Each tab has its own results pane element; the grids window against whichever is mounted.
  const removeScrollRef = React.useRef<HTMLDivElement>(null);

  const abortRef = React.useRef<AbortController | null>(null);
  // Separate from abortRef (removal batches): Cancel during an AI-edit Azure phase aborts the
  // in-flight generation requests; already-regenerated rows keep their (paid-for) results.
  const aiAbortRef = React.useRef<AbortController | null>(null);
  // Mirrors `running` for code that decides across awaits. The AI-edit phase may overlap a
  // removal batch, so its closures' `busy`/`running` are stale by the time Azure answers —
  // the ref is what prevents a second concurrent batch from starting.
  const runningRef = React.useRef(false);
  // Regenerated images that finished their Azure phase while a removal batch was running.
  // They need re-removal, which wants the same GPU workers the batch is saturating — so they
  // wait here and the batch drains them before it releases the lock.
  const deferredReRemovalRef = React.useRef<BgItem[]>([]);
  // Every id that has been through an AI edit once, manual or auto. The auto-fix watcher never
  // resends one: an image that comes back still flagged after its regeneration would otherwise
  // cycle through Azure forever, spending money on an image the model cannot fix.
  const aiAttemptedRef = React.useRef<Set<number>>(new Set());
  // The run loop reads the queue across awaits, so it needs the committed value, not a closure.
  const itemsRef = React.useRef<BgItem[]>(items);
  React.useEffect(() => { itemsRef.current = items; }, [items]);

  // Leaving the product must stop inference (the models hold the main thread otherwise) and hand
  // back every object URL the decoded originals are holding — a client-side route change keeps
  // the document alive, so nothing else ever revokes them.
  React.useEffect(
    () => () => {
      abortRef.current?.abort();
      // The AI phase can outlive the page too — without this, in-flight Azure requests keep
      // running (and spending) after navigation, then respawn the disposed worker pool.
      aiAbortRef.current?.abort();
      itemsRef.current.forEach(releaseItem);
      // Decoded previews are cache-owned; nothing else would ever close them.
      clearPreviews();
      // Pooled workers hold a model instance each; leaving them alive would pin GPU memory
      // for the rest of the session.
      disposePool();
    },
    [],
  );

  React.useEffect(() => {
    const ctrl = new AbortController();
    probeServerModel(ctrl.signal).then(setServerUp, () => setServerUp(false));
    return () => ctrl.abort();
  }, []);

  // A persisted id can be stale (a model that no longer exists) or momentarily unusable (rmbg2
  // while the sidecar is down). Both are resolved here rather than written back, so the stored
  // choice returns by itself the moment the sidecar answers again.
  const knownModel = BG_MODELS[storedModel] ? storedModel : DEFAULT_MODEL_ID;
  const serverBlocked = serverUp === false && BG_MODELS[knownModel].server === true;
  const modelId = serverBlocked ? DEFAULT_MODEL_ID : knownModel;

  const spec = BG_MODELS[modelId];
  // The sidecar model has no worker path, and neither does a browser without OffscreenCanvas.
  const usePool = isPoolSupported() && !spec.server;
  const modelReady = isModelLoaded(modelId) || loadedModels.includes(modelId);
  // Resolved fresh each render: any load completing bumps loadedModels, which re-renders.
  // Batches run in the pool, so its workers are the ones that know the real backend; the
  // main-thread engine only reports when it has loaded the model itself.
  const backend = (usePool ? getPoolBackend() : null) ?? getModelBackend(modelId);
  const backendLabel =
    backend === 'webgpu' ? 'GPU' : backend === 'wasm' ? 'CPU' : backend === 'server' ? 'server' : '';
  const busy = running || exporting || warming || aiFixing;

  // A mid-run tab close aborts everything still in flight; autosave keeps what finished, but
  // only the browser's own prompt can stop the close itself.
  React.useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  // Offered in the compare dialog's redo picker. Mirrors the main model select, including the
  // sidecar being unavailable, but choosing one here does not change the global setting.
  const redoModels = React.useMemo(
    () =>
      BG_MODEL_ORDER.map((id) => {
        const option = BG_MODELS[id];
        const offline = option.server === true && serverUp !== true;
        return {
          id,
          label: option.label,
          disabled: offline,
          hint: offline ? 'Local sidecar is not running' : option.description,
        };
      }),
    [serverUp],
  );

  const cutouts = React.useMemo(() => withCutout(items), [items]);
  const pending = React.useMemo(() => items.filter(needsCutout), [items]);
  const selected = React.useMemo(
    // Falls back to the first finished cutout so the tile preview always has a subject.
    () => cutouts.find((item) => item.id === selectedId) ?? cutouts.at(0) ?? null,
    [cutouts, selectedId],
  );
  // The preview's fallback must not drive the highlight: clicking a row that has no cutout yet
  // would otherwise ring a different, already-finished row.
  const highlightId = selectedId ?? selected?.id ?? null;
  // The tile preview draws the small preview bitmap, so the bbox has to come along in the same
  // coordinate space; bounds themselves are stored at full resolution for export.
  // The tile preview draws a decoded preview, so the bbox has to be mapped into that same
  // coordinate space; bounds themselves stay at full resolution for export.
  const selectedPreview = usePreview(
    selected?.cutout ? { key: selected.id, blob: selected.cutout.blob, edge: TILE_PREVIEW_EDGE } : null,
  );
  const selectedPreviewBounds = React.useMemo(() => {
    const cutout = selected?.cutout;
    if (!cutout?.bounds || !selectedPreview) return null;
    return scaleBounds(cutout.bounds, previewScale(cutout, selectedPreview));
  }, [selected, selectedPreview]);

  // Stable so the memoised result cells are not invalidated on every render.
  const selectById = React.useCallback((id: number) => setSelectedId(id), []);
  const proc = useProcessing({ prefix: 'skuc_bg', busy });

  const removeById = React.useCallback((id: number) => {
    const item = itemsRef.current.find((it) => it.id === id);
    if (!item) return;
    releaseItem(item);
    dropPreview(item.id);
    setItems((prev) => prev.filter((it) => it.id !== item.id));
    setSelectedId((prev) => (prev === item.id ? null : prev));
  }, []);

  // The before/after dialog lives here rather than inside the queue list, so a click on a result
  // image opens the same one. Held by id: the item object is replaced on every status patch,
  // which is exactly what lets the dialog update live during a redo.
  const [compareId, setCompareId] = React.useState<number | null>(null);
  const compareIndex = items.findIndex((it) => it.id === compareId);
  const compareItem = compareIndex < 0 ? null : items[compareIndex];
  const compareById = React.useCallback((id: number) => setCompareId(id), []);

  // Multi-select over the results grid. Ranges follow DISPLAY order, so shift-click matches
  // what the user sees even under quality sort.
  const displayIds = React.useMemo(() => displayItems.map((it) => it.id), [displayItems]);
  const gridSel = useGridSelection(displayIds, compareId !== null);

  const patchItem = React.useCallback((id: number, patch: Partial<BgItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  // Applies `patch` only while the item's source is still `source`, checked INSIDE the updater
  // so the test and the write are atomic in React's queue. A pre-checked patch (read itemsRef,
  // then patchItem) loses to an Undo committed in the ref's one-task sync lag; this cannot.
  // `onStale` builds the replacement patch from the live item when the source moved on.
  const patchItemIfSource = React.useCallback(
    (
      id: number,
      source: BgItemSource,
      patch: Partial<BgItem>,
      onStale?: (live: BgItem) => Partial<BgItem>,
    ) => {
      setItems((prev) =>
        prev.map((item) => {
          if (item.id !== id) return item;
          if (item.source === source) return { ...item, ...patch };
          return onStale ? { ...item, ...onStale(item) } : item;
        }),
      );
    },
    [],
  );

  const handleAdd = React.useCallback((drafts: BgItemDraft[]) => {
    setItems((prev) => [...prev, ...createItems(drafts, nextItemId(prev))]);
  }, []);

  // ---- CSV column mapping ----
  // The page owns CSV imports (not the dropzone) so the user can remap which column names the
  // images and which columns hold URLs. One CSV batch at a time: remapping — or dropping a new
  // CSV — replaces the previous CSV's items while file/paste items stay untouched.
  const [csvInfo, setCsvInfo] = React.useState<{
    fileName: string;
    text: string;
    headers: string[];
    imageColumns: string[];
    nameColumn: string;
  } | null>(null);
  /**
   * A name-column change is a pure rename, so it must never go through replaceCsvItems: that
   * path keys membership off the source kind, and an AI edit has already swapped the source to
   * a file. Those rows kept their old name while a duplicate was minted for them under the new
   * one. Matching on the CSV cell reaches every row — edited, in flight, or untouched — and
   * touches nothing else: no membership change, no reorder, no ids, no cutouts.
   */
  const renameCsvItems = React.useCallback((drafts: BgItemDraft[]) => {
    const nameByCell = new Map<string, string>();
    const nameByUrl = new Map<string, string>();
    for (const draft of drafts) {
      if (draft.csv) nameByCell.set(csvCellKey(draft.csv), draft.name);
      // Fallback for rows imported before provenance existed (restored projects and older
      // autosaves): first URL wins, matching the old by-URL behaviour for duplicates.
      if (draft.source.kind === 'url' && !nameByUrl.has(draft.source.url)) {
        nameByUrl.set(draft.source.url, draft.name);
      }
    }
    setItems((prev) =>
      prev.map((it) => {
        const name =
          (it.csv ? nameByCell.get(csvCellKey(it.csv)) : undefined) ??
          (it.source.kind === 'url' ? nameByUrl.get(it.source.url) : undefined);
        // Unchanged rows keep their object identity, so the memoised cells do not repaint and
        // autosave's identity diff does not rewrite records that did not actually change.
        return name === undefined || name === it.name ? it : { ...it, name };
      }),
    );
  }, []);

  const replaceCsvItems = React.useCallback((drafts: BgItemDraft[]) => {
    // Everything is computed OUTSIDE the updater: updaters must be pure, and StrictMode runs
    // them twice. CSV membership is the source kind itself — URLs only ever enter through a
    // CSV, so kind 'url' IS "belongs to the current CSV" and no id bookkeeping can go stale.
    const current = itemsRef.current;
    const prevCsv = current.filter((it) => it.source.kind === 'url');
    const kept = current.filter((it) => it.source.kind !== 'url');

    // An AI edit moves a row out of the 'url' population and into `kept`, but it still stands
    // for its CSV cell. Without this set the row is minted a second time under a fresh id —
    // a visible duplicate, and one the AI-fix dedupe has never seen, so it can be paid for
    // at Azure all over again.
    const claimed = new Set<string>();
    for (const it of kept) if (it.csv) claimed.add(csvCellKey(it.csv));

    // Remapping must not throw finished work away. Rows are matched to the new drafts by their
    // CSV cell, with the URL as the fallback for rows imported before provenance existed. The
    // cell is what makes duplicate URLs pair off correctly: the plain per-URL cursor walked
    // them positionally, so one removed duplicate cross-assigned every later row's name.
    const byCell = new Map<string, BgItem>();
    const byUrl = new Map<string, BgItem[]>();
    for (const it of prevCsv) {
      if (it.csv) byCell.set(csvCellKey(it.csv), it);
      if (it.source.kind !== 'url') continue;
      const list = byUrl.get(it.source.url);
      if (list) list.push(it);
      else byUrl.set(it.source.url, [it]);
    }
    const cursor = new Map<string, number>();
    const reused = new Set<number>();
    let nextId = nextItemId(current);
    const fresh: BgItem[] = [];
    for (const draft of drafts) {
      const cell = draft.csv ? csvCellKey(draft.csv) : '';
      // Already on screen as an AI-edited row — minting a second one is the duplicate bug.
      if (cell && claimed.has(cell)) continue;
      let match = cell ? byCell.get(cell) : undefined;
      if (match && reused.has(match.id)) match = undefined;
      if (!match && draft.source.kind === 'url') {
        const list = byUrl.get(draft.source.url) ?? [];
        let at = cursor.get(draft.source.url) ?? 0;
        // Skip rows already claimed by a cell match, or the same item pairs off twice.
        while (at < list.length && reused.has(list[at].id)) at += 1;
        if (at < list.length) match = list[at];
        cursor.set(draft.source.url, at + (match ? 1 : 0));
      }
      if (match) {
        reused.add(match.id);
        // Provenance is refreshed from the draft: an image-column remap can move a kept row to
        // a different column, and stale provenance would make the next rename miss it.
        fresh.push(
          match.name === draft.name && sameCsvOrigin(match.csv, draft.csv)
            ? match
            : { ...match, name: draft.name, ...(draft.csv ? { csv: draft.csv } : null) },
        );
      } else {
        fresh.push(createItems([draft], nextId)[0]);
        nextId += 1;
      }
    }

    // Both halves matter for the rows that did NOT survive: releaseItem frees the decoded
    // original, dropPreview frees whatever the preview cache holds for that id.
    for (const it of prevCsv) {
      if (reused.has(it.id)) continue;
      releaseItem(it);
      dropPreview(it.id);
    }
    setItems([...kept, ...fresh]);
  }, []);

  const handleCsv = React.useCallback(
    ({ fileName, text, imported }: CsvPayload) => {
      seedSessionName(fileName);
      setCsvInfo({
        fileName,
        text,
        headers: imported.headers,
        imageColumns: imported.imageColumns,
        nameColumn: imported.titleColumn,
      });
      replaceCsvItems(imported.drafts);
      if (!imported.drafts.length) {
        toast.warning(`No image URLs auto-detected in ${fileName} — pick the columns below.`);
      }
    },
    [replaceCsvItems, seedSessionName],
  );

  function updateCsvMapping(next: { nameColumn?: string; imageColumns?: string[] }) {
    if (!csvInfo) return;
    const nameColumn = next.nameColumn ?? csvInfo.nameColumn;
    const imageColumns = next.imageColumns ?? csvInfo.imageColumns;
    const imported = draftsFromCsv(csvInfo.text, { nameColumn: nameColumn || null, imageColumns });
    setCsvInfo({ ...csvInfo, nameColumn, imageColumns });
    // Only an image-column change alters WHICH rows are queued; renaming must not go near the
    // replace path, which would reorder the queue and duplicate every AI-edited row.
    if (next.imageColumns === undefined) renameCsvItems(imported.drafts);
    else replaceCsvItems(imported.drafts);
    if (!imported.drafts.length) toast.warning('No image URLs under the selected columns.');
  }

  // ---- Working file (.zesku): everything needed to resume tile fitting later -------------
  async function handleSaveProject() {
    const all = itemsRef.current;
    if (!all.length || busy) return;
    const projectName = `${sessionSlug || `zesku-project-${new Date().toISOString().slice(0, 10)}`}${PROJECT_EXTENSION}`;
    const dest = await pickSave(projectName);
    if (dest === 'cancelled') return;
    setExporting(true);
    try {
      // v2: EVERY item goes in — unprocessed rows too — with sources (URLs as strings, files
      // as embedded originals unless the size checkbox says otherwise).
      let skippedCount = 0;
      const blob = await saveProject(all, safeArea, outputBg, {
        includeOriginals: saveOriginals,
        onSkip: (skipped) => {
          skippedCount = skipped.length;
          const names = skipped.slice(0, 3).map((s) => s.name).join(', ');
          toast.warning(
            `${skipped.length} unreadable item${skipped.length === 1 ? '' : 's'} left out of the save (${names}${skipped.length > 3 ? ', …' : ''}) — full list in skipped.json inside the file. Those rows are still in the queue; redo them before clearing it.`,
            { duration: Infinity },
          );
        },
      });
      await saveTo(dest, blob, projectName);
      const cutouts = withCutout(all).length - skippedCount;
      toast.success(
        `Saved ${all.length} image${all.length === 1 ? '' : 's'} (${cutouts} finished${skippedCount ? `, ${skippedCount} skipped` : ''}) — originals ${saveOriginals ? 'included' : 'skipped'} (Settings → Defaults).`,
      );
    } catch (e) {
      toast.error(`Could not save the project: ${errorMessage(e)}`);
    } finally {
      setExporting(false);
    }
  }

  async function handleProject(file: File) {
    if (busy) return;
    setExporting(true);
    try {
      const restored = await loadProject(file);
      // Ids are allocated inside the updater from `prev`, like handleAdd. itemsRef lags the
      // committed queue until its sync effect runs, so a base taken from it here could collide
      // with ids handed out in that window (duplicate keys, patch/release cross-talk).
      setItems((prev) => {
        const base = nextItemId(prev);
        return [
          ...prev,
          ...restored.items.map(
            (r, i): BgItem => ({
              id: base + i,
              name: r.name,
              source: r.source,
              original: null,
              cutout: r.cutout,
              // v2 can restore rows that were saved before they ran.
              status: r.cutout ? 'done' : 'ready',
              ...(r.tileFit !== undefined ? { tileFit: r.tileFit } : null),
            }),
          ),
        ];
      });
      setSafeArea(restored.safeArea);
      setOutputBg(restored.outputBg);
      setTileFitOn(true);
      seedSessionName(file.name);
      const count = restored.items.length;
      const finished = restored.items.filter((r) => r.cutout).length;
      toast.success(
        `${file.name}: restored ${count} image${count === 1 ? '' : 's'} (${finished} finished) — safe-area settings applied.`,
      );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  }

  // ---- Processing --------------------------------------------------------

  /**
   * Brings a main-thread engine result into the same compressed shape the workers produce, so
   * the fallback path (no workers, or the sidecar model) stores no more than the pooled one.
   */
  async function toCutout(result: RemoveResult): Promise<PoolCutout> {
    const blob = await new Promise<Blob>((resolve, reject) =>
      result.canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Encoding the cutout failed'))),
        STORE_TYPE,
        1,
      ),
    );
    const bounds = subjectBounds(result.pixels);
    const residueFraction = measureFaintResidue(result.pixels, bounds);
    // The engine's canvas is a full-resolution buffer we are done with.
    releaseCanvas(result.canvas);
    return {
      blob,
      bounds,
      residueFraction,
      width: result.width,
      height: result.height,
      durationMs: result.durationMs,
      backend: result.backend,
      model: result.model,
      removedRegions: result.removedRegions,
      // The main-thread engine does not run band detection; the pooled worker path does.
      bands: [],
      regionReport: result.regionReport,
    };
  }

  function decodeOriginal(item: BgItem): Promise<HTMLImageElement> {
    if (item.original) return Promise.resolve(item.original);
    if (item.source.kind === 'file') return loadImageFromFile(item.source.file);
    if (item.source.kind === 'url') return loadImageFromUrl(item.source.url);
    // Unreachable through the UI (retry is disabled for archived items) but a plain error
    // beats a crash if a new code path ever gets here.
    return Promise.reject(new Error('This item was restored from a project — the original was not saved.'));
  }

  async function cutOut(
    item: BgItem,
    signal: AbortSignal,
    preloaded?: Promise<HTMLImageElement>,
    overrides?: RunOverrides,
  ) {
    // A redo from the compare dialog picks its own settings without touching the global ones.
    const runModel = overrides?.model ?? modelId;
    const runRefine = overrides?.refine ?? refine;
    patchItem(item.id, {
      status: modelReady ? 'removing' : 'loading-model',
      error: undefined,
    });
    const original = await (preloaded ?? decodeOriginal(item));
    patchItem(item.id, { original });

    // Every stage fires a callback, but the row only has two states to show. Patching on each
    // one rebuilt the items array several times per image — pure re-render cost with nothing
    // new on screen — so a no-op patch is skipped here.
    let shown: BgItemStatus | null = null;
    const showStatus = (next: BgItemStatus) => {
      if (shown === next) return;
      shown = next;
      patchItem(item.id, { status: next });
    };

    const shared = {
      model: runModel,
      refine: runRefine,
      zoomPass: highDetail,
      productOnly,
      signal,
      onLoadProgress: setDownload,
      onStage: (next: RemoveStage) => {
        setStage(next);
        if (next === 'loading') {
          showStatus('loading-model');
          return;
        }
        // Weights are resident by the time inference starts; drop the download line.
        setDownload(null);
        if (next !== 'done') showStatus('removing');
      },
    };
    // Pooled workers keep the GPU fed across images; the main-thread engine is the fallback
    // when workers/OffscreenCanvas are unavailable, and the only path for the server model.
    const produced: PoolCutout = usePool
      ? await poolRemoveBackground(original, shared)
      : await toCutout(await removeBackground(original, shared));

    // The decoded original is the largest thing an item holds and nothing needs it once a
    // cutout exists — the before/after view re-decodes from item.source on demand.
    // `item` is the snapshot the run loop captured, taken BEFORE the decode, so its `original`
    // is still null; releasing it must be handed the element we actually decoded or the object
    // URL loadImageFromFile minted is never revoked.
    releaseOriginal({ ...item, original });
    // The item may have been undone while this inference ran (the AI-fix undo toast overlaps
    // the deferred re-removal drain): the result then belongs to an input the user rejected.
    // The source check lives inside the updater — atomic with the write — so no ordering of
    // undo-commit vs worker-completion can pair the old source with this cutout. On staleness
    // the result is discarded and the status our stage callbacks stomped is repaired.
    patchItemIfSource(
      item.id,
      item.source,
      {
        cutout: {
          blob: produced.blob,
          bounds: produced.bounds,
          width: produced.width,
          height: produced.height,
          residueFraction: produced.residueFraction,
        },
        original: null,
        status: 'done',
        durationMs: produced.durationMs,
        removedRegions: produced.removedRegions,
        regionReport: produced.regionReport,
        error: undefined,
      },
      (live) => ({ status: live.cutout ? 'done' : 'ready', original: null }),
    );
    setLoadedModels((prev) => (prev.includes(runModel) ? prev : [...prev, runModel]));
  }

  async function runBatchInner(
    targets: BgItem[],
    verb: string,
    ctrl: AbortController,
    overrides?: RunOverrides,
  ) {
    let done = 0;
    let failed = 0;
    let cancelled = false;

    // How many images may be in flight. Pooled: enough to keep both workers busy plus a couple
    // decoding ahead, so the GPU never waits on a fetch. Unpooled: strictly one, since a single
    // main-thread engine gains nothing from overlap and only inflates peak memory.
    const inFlight = usePool ? POOL_CONCURRENCY : 1;
    let started = 0;
    let finished = 0;
    const eta = createEta();

    const settleOne = (item: BgItem, e?: unknown) => {
      finished++;
      if (!e) {
        done++;
      } else if (isAbortError(e)) {
        // Conditional like cutOut's result patch: an item undone mid-flight keeps its restored
        // state instead of wearing this run's cancelled/error badge.
        patchItemIfSource(item.id, item.source, { status: 'cancelled' });
        cancelled = true;
      } else {
        // One bad image must never end the batch.
        const message = errorMessage(e);
        failed++;
        patchItemIfSource(item.id, item.source, { status: 'error', error: message });
        // A dead image URL also says 404/fetch — only blame the weights when the model
        // itself never became resident.
        if (!isModelLoaded(modelId) && looksLikeMissingWeights(message)) setSetupError(message);
        toast.error(`${item.name || 'Image'}: ${message}`);
      }
      const left = eta.remaining(finished, targets.length);
      setProgress({
        pct: (finished / targets.length) * 100,
        text: `${verb} ${Math.min(finished + 1, targets.length)} of ${targets.length}${left ? ` · ${left}` : ''}`,
      });
    };

    // A promise-per-lane worker loop: each lane pulls the next index until the queue drains,
    // which keeps exactly `inFlight` images alive regardless of how uneven their run times are.
    const lane = async () => {
      for (;;) {
        if (ctrl.signal.aborted) {
          cancelled = true;
          return;
        }
        const index = started++;
        if (index >= targets.length) return;
        const item = targets[index];
        try {
          await cutOut(item, ctrl.signal, undefined, overrides);
          settleOne(item);
        } catch (e) {
          settleOne(item, e);
          if (isAbortError(e)) return;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(inFlight, targets.length) }, lane));

    setDownload(null);
    setStage(null);
    setProgress({
      pct: 100,
      text: cancelled
        ? `Cancelled — ${done} finished, ${targets.length - done} left in the queue.`
        : failed
          ? `${done} of ${targets.length} done, ${failed} failed.`
          : `${done} of ${targets.length} done.`,
    });
  }

  async function runBatch(targets: BgItem[], verb: string, overrides?: RunOverrides) {
    // The ref, not `busy`: the AI-edit flow calls this after an await, when its closure's
    // `busy` no longer reflects whether a batch is running.
    if (runningRef.current || exporting || warming || !targets.length) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    runningRef.current = true;
    setRunning(true);
    setSetupError(null);
    setCompressSummary('');
    try {
      await runBatchInner(targets, verb, ctrl, overrides);
      // Regenerated images whose Azure phase finished mid-batch queued here for re-removal.
      // Drained before the lock releases, so "the run is finished" means all of it, and a
      // concurrent handleRun can never double-process them. The loop re-checks because more
      // can arrive while a drain batch runs.
      while (!ctrl.signal.aborted && deferredReRemovalRef.current.length) {
        const queued = deferredReRemovalRef.current;
        deferredReRemovalRef.current = [];
        // Skip only entries PROVABLY handled — a cutout already exists for this exact source,
        // or the item is gone. itemsRef lags React's commit by one task, so a positive test
        // ("looks fresh, run it") is the safe direction: worst case a since-undone entry burns
        // one inference and cutOut's atomic source check discards the result. The inverse test
        // ("looks stale, drop it") read the same lagging ref and could silently discard an
        // entry whose regeneration simply hadn't committed yet — a promised re-removal that
        // never happens.
        const fresh = queued.filter((u) => {
          const live = itemsRef.current.find((it) => it.id === u.id);
          return !!live && !(live.source === u.source && live.cutout !== null);
        });
        if (fresh.length) await runBatchInner(fresh, 'Re-removing', ctrl);
      }
    } finally {
      // A cancelled run must not leave deferred work behind: those items are 'ready' with no
      // cutout, so the ordinary Remove button covers them — and a leftover entry would
      // otherwise fire unexpectedly at the end of some future batch. Say so — a toast already
      // promised these items a re-removal, and a silently broken promise reads as a hang.
      if (ctrl.signal.aborted && deferredReRemovalRef.current.length) {
        const n = deferredReRemovalRef.current.length;
        toast.info(
          `${n} regenerated image${n === 1 ? '' : 's'} left in the queue — Remove backgrounds finishes them.`,
        );
      }
      if (ctrl.signal.aborted) deferredReRemovalRef.current = [];
      // The lock must release even if something outside cutOut's own catch throws, or every
      // button on the page stays disabled until a reload — which also drops the queue.
      runningRef.current = false;
      setRunning(false);
      abortRef.current = null;
    }
  }

  /**
   * Re-removes backgrounds of AI-regenerated items, now or later: immediately when idle, or
   * queued onto the running batch's tail when the workers are already saturated — that batch
   * drains the queue before it releases the lock.
   */
  async function reRemoveOrDefer(updated: BgItem[]) {
    if (!updated.length) return;
    if (runningRef.current) {
      deferredReRemovalRef.current.push(...updated);
      toast.info(
        `${updated.length} regenerated — re-removing backgrounds when the current batch finishes.`,
      );
      return;
    }
    await runBatch(updated, 'Re-removing');
  }

  function handleRun() {
    void runBatch(pending, 'Removing');
  }

  function aiEditGuards(): { prompt: string; mock: boolean } | null {
    // aiPrompt always resolves (blank falls back to DEFAULT_AI_PROMPT), so only the
    // credentials can block an edit.
    const prompt = aiPrompt.trim();
    const mock =
      typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('mock');
    if (!mock && (!azureEndpoint.trim() || !azureKey.trim())) {
      toast.error('Set the Azure endpoint and API key in Settings (gear at the bottom of the rail), or use ?mock=1.');
      return null;
    }
    return { prompt, mock };
  }

  /**
   * One image through Azure: the generated image REPLACES the item's source, so every later
   * step — thumbnails, a redo, exports, a saved project — sees the updated image and never the
   * old one. Returns the updated item (background not yet re-removed), or null on failure —
   * failures mark the item and keep going, one bad request must not sink a batch.
   */
  async function aiEditOne(
    item: BgItem,
    prompt: string,
    mock: boolean,
    signal?: AbortSignal,
  ): Promise<BgItem | null> {
    patchItem(item.id, { status: 'editing', error: undefined });
    try {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const src = item.source;
      if (src.kind === 'archived') return null; // callers exclude this via canRetry
      const loaded =
        src.kind === 'url' ? await loadImageFromUrl(src.url) : await loadImageFromFile(src.file);
      const source = aiFocusCrop ? await cropToHero(item, loaded) : loaded;
      const edited = mock
        ? await mockComposite([source])
        : await callAzure([source], {
            signal,
            endpoint: azureEndpoint,
            apiKey: azureKey,
            prompt,
            // quality: suite-wide, from Settings → Quality.
            // The focus crop makes the reference non-square; without an explicit size the
            // edits endpoint mirrors that aspect and returns rectangular images.
            size: '1024x1024',
          });

      const canvas = document.createElement('canvas');
      canvas.width = edited.naturalWidth;
      canvas.height = edited.naturalHeight;
      canvas.getContext('2d')!.drawImage(edited, 0, 0);
      const blob = await canvasToPngBlob(canvas);
      releaseCanvas(canvas);
      const file = new File([blob], `${item.name || 'image'}-ai-edit.png`, { type: 'image/png' });

      dropPreview(item.id);
      // Only the fields the edit actually owns. `item` was captured before a network round trip
      // that can take a minute, so patching the whole object back would silently revert
      // anything changed meanwhile — a rename from a column remap, a tile-fit pin.
      const patch: Partial<BgItem> = {
        source: { kind: 'file', file, regenerated: true },
        original: edited,
        cutout: null,
        status: 'ready',
        error: undefined,
        durationMs: undefined,
        // Undo restores the pre-edit input AND its cutout in one step.
        prev: { source: item.source, cutout: item.cutout },
      };
      patchItem(item.id, patch);
      return { ...item, ...patch };
    } catch (e) {
      if (isAbortError(e)) {
        // Stopped, not failed — the tile goes back exactly where it was (nothing was replaced;
        // the source swap happens atomically after the Azure call succeeds).
        patchItem(item.id, { status: item.status, error: undefined });
        return null;
      }
      patchItem(item.id, { status: 'error', error: `AI edit failed: ${errorMessage(e)}` });
      return null;
    }
  }

  /** ?mock=1 short-circuits Azure, same as the compositor. */
  async function handleAiEdit(item: BgItem, promptOverride?: string) {
    // Same relaxation as aiEditMany: a running removal batch is not a conflict.
    if (aiFixing || exporting || warming || item.status === 'editing' || !canRetry(item)) return;
    const guards = aiEditGuards();
    if (!guards) return;
    const controller = new AbortController();
    aiAbortRef.current = controller;
    setAiFixing(true);
    let updated: BgItem | null = null;
    try {
      // The dialog's per-image prompt wins for this one run; blank falls back to the default,
      // so "select all + delete" in the dialog can never fire an empty instruction.
      updated = await aiEditOne(
        item,
        promptOverride?.trim() || guards.prompt,
        guards.mock,
        controller.signal,
      );
    } finally {
      // Only while this run still owns the slot — see aiEditMany's teardown.
      if (aiAbortRef.current === controller) {
        aiAbortRef.current = null;
        setAiFixing(false);
      }
    }
    if (controller.signal.aborted) return; // stopped by the user — no error, no re-removal
    if (!updated) {
      toast.error('AI edit failed — see the image for the error.');
      return;
    }
    await reRemoveOrDefer([updated]);
  }

  /**
   * Every quality-flagged image through Azure, the suite's parallel-requests setting at a
   * time, then one normal
   * removal batch over the regenerated images. Per-image failures mark their own tile and never
   * stop the rest; the re-removal only sees the successes.
   */
  async function handleAiEditFlagged() {
    await aiEditMany(flaggedItems);
  }

  async function handleAiEditSelected() {
    // Archived sources have no pixels to re-reference; skip them like the per-item edit does.
    const targets = itemsRef.current.filter((it) => gridSel.checked.has(it.id) && canRetry(it));
    gridSel.clear();
    await aiEditMany(targets);
  }

  async function aiEditMany(targets: BgItem[]) {
    // Deliberately NOT gated on `running`: the Azure phase is network-bound and runs fine
    // alongside a removal batch — only the re-removal needs the workers, and that defers.
    if (aiFixing || exporting || warming || !targets.length) return;
    const guards = aiEditGuards();
    if (!guards) return;
    const controller = new AbortController();
    aiAbortRef.current = controller;
    setAiFixing(true);
    // Manual sends count as the attempt too — auto must never re-spend on an id a human
    // already sent, whatever the result looked like.
    for (const t of targets) aiAttemptedRef.current.add(t.id);
    let finished = 0;
    const eta = createEta();
    // Its own progress line — a removal batch may own the main one at the same time.
    setAiProgress({ pct: 0, text: `AI edit 1 of ${targets.length}` });
    let updated: BgItem[] = [];
    try {
      const results = await mapWithLimit(targets, readParallel(), async (item) => {
        if (controller.signal.aborted) return null; // stopped: leave the rest untouched
        const updated = await aiEditOne(item, guards.prompt, guards.mock, controller.signal);
        finished++;
        const left = eta.remaining(finished, targets.length);
        setAiProgress({
          pct: (finished / targets.length) * 100,
          text: `AI edit ${Math.min(finished + 1, targets.length)} of ${targets.length}${left ? ` · ${left}` : ''}`,
        });
        return updated;
      });
      updated = results.filter((r): r is BgItem => r !== null);
      if (controller.signal.aborted) {
        // Stop means stop. Starting a re-removal here would race the batch teardown the same
        // click triggered — one ordering silently discards it, the other launches a fresh
        // batch right after the user asked for quiet. The items sit 'ready' with no cutout,
        // so the ordinary Remove button covers them.
        toast.info(
          `AI fix stopped — ${updated.length} of ${targets.length} regenerated; they stay queued for Remove backgrounds.`,
        );
        updated = [];
      } else {
        const failed = targets.length - updated.length;
        if (failed) {
          toast.error(`${failed} AI edit${failed === 1 ? '' : 's'} failed — their tiles show the error.`);
        }
      }
    } finally {
      // Teardown BEFORE the re-removal below, and only while this run still owns the slot: the
      // button re-enables the moment aiFixing clears, so a second run may already be in flight
      // by the time control returns here — its controller/progress must not be clobbered.
      if (aiAbortRef.current === controller) {
        aiAbortRef.current = null;
        setAiFixing(false);
        setAiProgress(null);
      }
    }
    if (updated.length) {
      // When idle this awaits the whole re-removal; when a batch is running it returns at
      // once and the undo toast appears while the re-removal is still deferred. Safe either
      // way: what undo restores (the pre-edit source + cutout) exists already, and cutOut's
      // atomic source check discards any in-flight result for an undone item.
      await reRemoveOrDefer(updated);
      offerUndo(updated.map((u) => u.id), 'AI-edited', true);
    }
  }

  function handleRetry(item: BgItem, overrides?: RunOverrides) {
    if (busy) return;
    // The cache owns decoded previews; drop this item's so a redo does not show the old one.
    dropPreview(item.id);
    const reset: BgItem = {
      ...item,
      cutout: null,
      status: 'ready',
      error: undefined,
      durationMs: undefined,
      prev: { source: item.source, cutout: item.cutout },
    };
    patchItem(item.id, reset);
    void runBatch([reset], 'Redoing', overrides);
  }

  /** Restores an item to the source+cutout the last Redo / AI edit replaced. */
  function undoItem(id: number) {
    const item = itemsRef.current.find((it) => it.id === id);
    if (!item?.prev) return;
    dropPreview(id);
    patchItem(id, {
      source: item.prev.source,
      cutout: item.prev.cutout,
      status: item.prev.cutout ? 'done' : 'ready',
      error: undefined,
      durationMs: undefined,
      original: null,
      prev: undefined,
    });
  }

  /** Post-batch toast with a one-click bulk undo over everything the batch replaced. */
  function offerUndo(ids: number[], verb: string, trustIds = false) {
    // itemsRef lags React's commit, so a caller that JUST wrote prev onto these very items
    // passes trustIds — filtering against the ref would undercount. undoItem re-checks prev
    // at click time either way, so a trusted id can never undo something with nothing there.
    const undoable = trustIds
      ? ids
      : ids.filter((id) => itemsRef.current.find((it) => it.id === id)?.prev);
    if (!undoable.length) return;
    toast.success(`${undoable.length} ${verb}`, {
      action: { label: 'Undo', onClick: () => undoable.forEach(undoItem) },
    });
  }

  // ---- Selection bulk actions --------------------------------------------

  function handleRetrySelected() {
    if (busy) return;
    // Archived sources have no pixels to re-run; skip them like the per-item Redo does.
    const targets = itemsRef.current.filter((it) => gridSel.checked.has(it.id) && canRetry(it));
    if (!targets.length) return;
    const resets = targets.map((it) => ({
      ...it,
      cutout: null,
      status: 'ready' as const,
      error: undefined,
      durationMs: undefined,
      prev: { source: it.source, cutout: it.cutout },
    }));
    for (const r of resets) dropPreview(r.id);
    setItems((prev) => prev.map((it) => resets.find((r) => r.id === it.id) ?? it));
    gridSel.clear();
    void runBatch(resets, 'Redoing').then(() => offerUndo(resets.map((r) => r.id), 'redone'));
  }

  function deleteSelected() {
    const doomed = itemsRef.current.filter((it) => gridSel.checked.has(it.id));
    for (const it of doomed) {
      releaseItem(it);
      dropPreview(it.id);
    }
    setItems((prev) => prev.filter((it) => !gridSel.checked.has(it.id)));
    setSelectedId((prev) => (prev !== null && gridSel.checked.has(prev) ? null : prev));
    setCompareId((prev) => (prev !== null && gridSel.checked.has(prev) ? null : prev));
    gridSel.clear();
  }

  // Whether ANY / ALL cells render as tiles — drives the uniform VirtualGrid row height.
  const tileStats = React.useMemo(() => {
    let on = 0;
    for (const it of items) if (effectiveTileFit(it)) on++;
    return { any: on > 0, all: items.length > 0 && on === items.length };
  }, [items, effectiveTileFit]);

  // Whether every selected cell currently RENDERS as a tile — the bar button toggles against
  // what the user sees, not against the override bookkeeping. (An earlier cycle started by
  // pinning the current state, which looked like "nothing happened to my selection while the
  // global switch moves everything else".)
  const selAllTiled = React.useMemo(() => {
    if (!gridSel.active) return false;
    const chosen = items.filter((it) => gridSel.checked.has(it.id));
    return chosen.length > 0 && chosen.every((it) => effectiveTileFit(it));
  }, [items, gridSel.active, gridSel.checked, effectiveTileFit]);

  /** Flips tile fit for the SELECTED images only, pinning them regardless of the global switch. */
  function toggleTileFitSelected() {
    const next = !selAllTiled;
    setItems((prev) =>
      prev.map((it) => (gridSel.checked.has(it.id) ? { ...it, tileFit: next } : it)),
    );
  }

  /** Empties the queue and frees every decoded original and cached preview. */
  function clearAllItems() {
    for (const it of itemsRef.current) {
      releaseItem(it);
      dropPreview(it.id);
    }
    setItems([]);
    setSelectedId(null);
    setCompareId(null);
    gridSel.clear();
  }

  function handleCancel() {
    abortRef.current?.abort();
    aiAbortRef.current?.abort();
    // from_pretrained takes no signal, so a download in flight runs to completion and the abort
    // only lands at the next checkpoint. Say so, or a 452 MB fetch looks like a hung button.
    if (stage === 'loading') {
      toast.info('Cancelling — the model download has to finish first.');
    }
  }

  async function handleWarm() {
    if (spec.server || modelReady || busy) return;
    setWarming(true);
    setSetupError(null);
    try {
      await warmModel(modelId, setDownload);
      // Each pooled worker loads its own copy; doing it now means a batch starts at full speed
      // instead of stalling on the first two images.
      if (usePool) await warmPool(modelId);
      setLoadedModels((prev) => (prev.includes(modelId) ? prev : [...prev, modelId]));
      toast.success(`${spec.label} is loaded and ready.`);
    } catch (e) {
      const message = errorMessage(e);
      if (looksLikeMissingWeights(message)) setSetupError(message);
      toast.error(`${spec.label}: ${message}`);
    } finally {
      setDownload(null);
      setWarming(false);
    }
  }

  // ---- Export: render, optionally compress, zip ---------------------------

  async function handleExport() {
    const ready = withCutout(itemsRef.current);
    if (!ready.length || busy) return;
    // Per-item now: each file renders by its own effective tile fit. Only the ZIP's name still
    // needs an overall shape — all-tiles / all-cutouts keep their old names, a mix says so.
    const tileCount = ready.filter((it) => effectiveTileFit(it)).length;
    const shape = tileCount === ready.length ? 'tiles' : tileCount === 0 ? 'cutouts' : 'mixed';
    // The save dialog opens now, while the click still counts as user activation — after
    // minutes of encoding Chrome would refuse it. Cancelling the dialog cancels the export.
    const zipName = sessionSlug
      ? `${sessionSlug}-${shape === 'mixed' ? 'export' : shape}.zip`
      : shape === 'tiles'
        ? 'safe-area-tiles.zip'
        : shape === 'cutouts'
          ? 'bg-cutouts.zip'
          : 'zigma-export.zip';
    const dest = await pickSave(zipName);
    if (dest === 'cancelled') return;
    // Snapshotted once: editing the ceiling mid-export must not give the ZIP two different rules.
    const budget = budgetActive
      ? { maxBytes: budgetKbSafe * 1024, allowDownscale: budgetShrink, dither: false }
      : null;

    setExporting(true);
    setCompressSummary('');
    const files: ZipStreamEntry[] = [];
    let inTotal = 0;
    let outTotal = 0;
    let failed = 0;

    try {
      // canvas.toBlob's latency is per-call and overlaps almost perfectly across calls, so
      // encoding sequentially made a batch wait N times over for work that costs the same done
      // at once. The limit is what bounds peak memory: at most this many full-size canvases and
      // their encoded copies are alive together.
      let encoded = 0;
      // Per-phase clocks: encode and compress throughputs differ wildly, so one shared
      // tracker would carry the first phase's pace into the second.
      const encodeEta = createEta();
      // One slot per file, filled in whatever order the lanes finish; null means the budget was
      // off for this run, so nothing about the file was negotiated.
      const outcomes = new Array<BudgetResult | null>(ready.length).fill(null);
      const pngs = await mapWithLimit(ready, ENCODE_CONCURRENCY, async (item, n) => {
        // Cutouts are stored compressed, so export decodes the master back to full resolution
        // here — briefly, for one image at a time per lane — rather than keeping every image's
        // pixels alive for the whole session.
        const full = await decodeCutout(item.cutout);
        try {
          const canvas = effectiveTileFit(item)
            ? renderTile(full, safeArea, { bounds: item.cutout.bounds })
            : flattenOnBackground(full, outputBg);
          // fitToBudget owns the encode when the budget is on: its first rung is the same
          // truecolor PNG canvasToPngBytes produces, so a file that already fits is byte-identical
          // to today's export and only a miss costs anything.
          const budgeted = budget ? await fitToBudget(canvas, budget) : null;
          outcomes[n] = budgeted;
          const data = budgeted ? budgeted.bytes : await canvasToPngBytes(canvas);
          releaseCanvas(canvas);
          encoded++;
          // The compress half only exists when the compress switch is on; without it the encode
          // stage owns the whole bar, or it would stall at 50% until the run ended.
          const span = proc.compressOn ? 50 : 100;
          const left = encodeEta.remaining(encoded, ready.length);
          setExportProgress({
            pct: (encoded / ready.length) * span,
            text: `Encoding ${encoded} of ${ready.length}…${left ? ` · ${left}` : ''}`,
          });
          // Blob, not bytes: Chrome pages blob data to disk, so a queue-scale export holds one
          // image's bytes per lane instead of every PNG at once ("failed to allocate buffer").
          return new Blob([data as BlobPart], { type: 'image/png' });
        } finally {
          full.close();
        }
      });

      // The processing space's shared compress step (pngquant + oxipng, local). A failure
      // keeps the uncompressed PNG rather than dropping an image.
      let compressed = 0;
      const compressEta = createEta();
      const finalBytes = proc.compressOn
        ? await mapWithLimit(pngs, COMPRESS_CONCURRENCY, async (data, n) => {
            try {
              const bytes = new Uint8Array(await data.arrayBuffer());
              const out = await proc.compressBytes(bytes);
              inTotal += bytes.length;
              outTotal += out.length;
              return new Blob([out as BlobPart], { type: 'image/png' });
            } catch (e) {
              failed++;
              toast.error(`${ready[n].name || `Image ${n + 1}`}: ${errorMessage(e)}`);
              return data;
            } finally {
              compressed++;
              const left = compressEta.remaining(compressed, ready.length);
              setExportProgress({
                pct: 50 + (compressed / ready.length) * 50,
                text: `Compressing ${compressed} of ${ready.length}…${left ? ` · ${left}` : ''}`,
              });
            }
          })
        : pngs;

      const names = exportFileNames(
        ready.map((item) => item.name),
        { numbered: numberFiles },
      );
      ready.forEach((item, n) => files.push({ name: names[n], data: finalBytes[n] }));

      // Quantising and downscaling leave no mark on the file itself, so this report is the only
      // place a user can learn a tile was degraded — anything unsaid here gets discovered on the
      // CDN instead.
      const fitted = outcomes
        .map((result, index) => ({ result, index }))
        .filter((entry): entry is { result: BudgetResult; index: number } => entry.result !== null);
      const shrunk = fitted.filter((entry) => entry.result.scale !== 1);
      // Judged on the bytes that actually go into the ZIP, not on what the ladder returned:
      // TinyPNG runs after the budget pass and can pull a near-miss back under the ceiling.
      const missed = fitted.filter((entry) => finalBytes[entry.index].size > budgetKbSafe * 1024);
      let budgetLine = '';
      if (fitted.length) {
        const quantised = fitted.filter(
          (entry) => entry.result.colors !== null && entry.result.scale === 1,
        ).length;
        const parts = [`${fitted.length - quantised - shrunk.length} untouched`];
        if (quantised) parts.push(`${quantised} quantised`);
        if (shrunk.length) {
          const smallest = shrunk.reduce((a, b) =>
            a.result.width * a.result.height <= b.result.width * b.result.height ? a : b,
          );
          const sizes = new Set(shrunk.map((entry) => `${entry.result.width}×${entry.result.height}`));
          const size = `${smallest.result.width}×${smallest.result.height}`;
          parts.push(`${shrunk.length} downscaled (${sizes.size === 1 ? 'to' : 'smallest'} ${size})`);
        }
        if (missed.length) parts.push(`${missed.length} STILL OVER`);
        budgetLine = `Budget ${budgetKbSafe} KB: ${parts.join(', ')}`;
      }

      // The status line truncates, so anything a user must not miss is also named in a toast.
      const listNames = (entries: typeof fitted) => {
        const shown = entries
          .slice(0, BUDGET_TOAST_NAMES)
          .map((entry) => names[entry.index])
          .join(', ');
        const rest = entries.length - BUDGET_TOAST_NAMES;
        return rest > 0 ? `${shown} (+${rest} more)` : shown;
      };
      if (shrunk.length) {
        toast.warning(
          `${shrunk.length} file${shrunk.length > 1 ? 's were' : ' was'} downscaled to fit ${budgetKbSafe} KB: ${listNames(shrunk)}`,
        );
      }
      if (missed.length) {
        const worst = missed.reduce((a, b) =>
          finalBytes[a.index].size >= finalBytes[b.index].size ? a : b,
        );
        toast.error(
          `${missed.length} file${missed.length > 1 ? 's are' : ' is'} still over ${budgetKbSafe} KB — largest is ${formatKb(finalBytes[worst.index].size)} at ${describeBudget(worst.result)}: ${listNames(missed)}`,
        );
      }

      const summary: string[] = [];
      if (budgetLine) summary.push(budgetLine);
      if (outTotal) {
        summary.push(
          `Compressed: ${formatKb(inTotal)} → ${formatKb(outTotal)} (saved ${Math.round((1 - outTotal / inTotal) * 100)}%)`,
        );
      }
      setCompressSummary(summary.join(' · '));
      setExportProgress({
        pct: 100,
        text: failed
          ? `Exported ${files.length} PNG${files.length > 1 ? 's' : ''} with ${failed} compression failure${failed > 1 ? 's' : ''}.`
          : `Exported ${files.length} PNG${files.length > 1 ? 's' : ''}.`,
      });

      const blob = await buildZipStream(files);
      await saveTo(dest, blob, zipName);
    } catch (e) {
      toast.error(`Export failed: ${errorMessage(e)}`);
    } finally {
      setExporting(false);
    }
  }

  // ---- Shared panes ------------------------------------------------------

  const bgChoice: 'transparent' | 'white' | 'custom' =
    outputBg === TRANSPARENT ? 'transparent' : outputBg.toLowerCase() === WHITE ? 'white' : 'custom';

  function chooseBackground(next: string) {
    if (next === 'transparent') setOutputBg(TRANSPARENT);
    else if (next === 'white') setOutputBg(WHITE);
    else setOutputBg(bgChoice === 'custom' ? outputBg : DEFAULT_CUSTOM_BG);
  }

  const inputCard = (
    <>
    <PanelSection title="Images" hint="Files, a clipboard paste, or a CSV of image URLs.">
        <ImageDropzone onAdd={handleAdd} onCsv={handleCsv} onProject={(file) => void handleProject(file)} itemCount={items.length} disabled={busy} />
    </PanelSection>
        {csvInfo && (
          <PanelSection title={<>Columns — {csvInfo.fileName}</>}>
          <div className="space-y-4">
            <Field>
              <FieldLabel htmlFor="csv-name-col">
                <Hint hint="Names the previews and exported files. Safe to change any time — finished rows are renamed in place and their cutouts are kept.">
                  Name column
                </Hint>
              </FieldLabel>
              <Select
                value={csvInfo.nameColumn || NONE}
                onValueChange={(value) =>
                  updateCsvMapping({ nameColumn: value === NONE ? '' : String(value ?? '') })
                }
                disabled={busy}
              >
                <SelectTrigger id="csv-name-col" className="w-full">
                  <SelectValue>
                    {(value) => (value && value !== NONE ? String(value) : '(URL filename)')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>(URL filename)</SelectItem>
                  {csvInfo.headers.map((header) => (
                    <SelectItem key={header} value={header}>
                      {header}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Image URL columns</FieldLabel>
              {csvInfo.headers.map((header) => (
                <Field key={header} orientation="horizontal">
                  <Checkbox
                    id={`csv-img-${header}`}
                    checked={csvInfo.imageColumns.includes(header)}
                    disabled={busy}
                    onCheckedChange={(checked) =>
                      updateCsvMapping({
                        imageColumns:
                          checked === true
                            ? [...csvInfo.imageColumns, header]
                            : csvInfo.imageColumns.filter((column) => column !== header),
                      })
                    }
                  />
                  <FieldLabel htmlFor={`csv-img-${header}`} className="font-normal">
                    {header}
                  </FieldLabel>
                </Field>
              ))}
            </Field>
          </div>
          </PanelSection>
        )}
    </>
  );

  // The queue used to be a separate card of rows here; the results grid IS the queue now —
  // originals appear as tiles the moment they land and are replaced by their cutouts in place,
  // with the row's status line and retry/remove controls folded into each tile.

  // The prompt always resolves to something (blank falls back to the default), so only the
  // credentials gate AI editing.
  const aiReady =
    azureEndpoint.trim().length > 0 && azureKey.trim().length > 0 ||
    (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('mock'));

  // ---- Auto AI-fix: a standing order over the flagged list. ----
  // Sends every not-yet-attempted flagged cutout through the AI edit the moment it appears —
  // during a removal batch too (the Azure phase runs alongside; only the re-removal waits for
  // the workers). One wave at a time: aiFixing gates re-entry, and its release re-runs this
  // effect, which picks up whatever flagged while the wave flew. aiAttemptedRef (marked
  // synchronously inside aiEditMany) is the dedupe — an effect re-fire between commits can
  // never send the same id twice, and an image still flagged after its fix is never resent.
  React.useEffect(() => {
    if (!autoAiFix || !aiReady) return;
    if (aiFixing || exporting || warming) return;
    const wave = flaggedItems.filter((item) => !aiAttemptedRef.current.has(item.id));
    if (!wave.length) return;
    toast.info(`Auto AI-fix: sending ${wave.length} flagged image${wave.length === 1 ? '' : 's'}.`);
    void aiEditMany(wave);
    // aiEditMany is intentionally not a dependency: it is redeclared every render, and the
    // attempted-set makes extra firings no-ops anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAiFix, aiReady, aiFixing, exporting, warming, flaggedItems]);
  const aiCard = (
    <PanelSection title="AI edit"
        hint="Send an image to Azure GPT-Image from its dialog; the result replaces the image and its background is removed again.">
        <FieldGroup className="gap-4">
          {/* The .md tile is its own label — a "Prompt" heading above it read as a second
              section title. The per-image override note lives in the editor dialog. */}
          <MdFileTile
            name={activeAiSkill?.name ?? 'ai-edit-prompt.md'}
            text={aiPrompt}
            badge={activeAiSkill ? (activeAiSkill.builtin ? 'Skill' : 'Custom skill') : 'Edited'}
            onClick={() => setPromptEditorOpen(true)}
            disabled={busy}
            skills={{ list: skills, activeId: aiSkillId, onSelect: (sk) => setAiPrompt(sk.content) }}
          />
          <Field orientation="horizontal">
            <Checkbox
              id="bg-ai-focus-crop"
              checked={aiFocusCrop}
              disabled={busy}
              onCheckedChange={(checked) => setAiFocusCrop(checked === true)}
            />
            <FieldContent>
              <FieldLabel htmlFor="bg-ai-focus-crop" className="font-normal">
                <Hint hint="Crops the reference to the main product before sending it to the model, so bowls, props and scattered pieces can't be copied back into the result. Falls back to the full image when there's nothing to crop away.">
                  Focus on main subject
                </Hint>
              </FieldLabel>
            </FieldContent>
          </Field>
        </FieldGroup>
      </PanelSection>
  );

  // Tile fit — the old second tab, now a properties section: switch it on, tune the safe
  // area, and the export renders tiles instead of raw cutouts. The live preview shows the
  // SELECTED cutout, Figma-style: pick on the canvas, preview in the properties.
  const tileFitCard = (
    <PanelSection
      title="Tile fit"
      hint="Export composites every cutout into the safe area below instead of keeping the source frame."
      action={
        <Switch
          aria-label="Tile fit"
          checked={tileFitOn}
          disabled={busy}
          onCheckedChange={(checked) => setTileFitOn(checked === true)}
        />
      }
      className="space-y-4"
    >
        {tileFitOn ? (
          <>
            <SafeAreaControls
              config={safeArea}
              onChange={setSafeArea}
              onReset={() => setSafeArea(structuredClone(DEFAULT_SAFE_AREA))}
              disabled={busy}
            />
            <div className="rounded-lg bg-muted/40 p-3">
              <TilePreview
                source={selectedPreview}
                bounds={selectedPreviewBounds}
                config={safeArea}
                showOverlay
                maxSize={240}
                sourceScale={
                  selected?.cutout && selectedPreview
                    ? previewScale(selected.cutout, selectedPreview)
                    : 1
                }
              />
              <p className="mt-1 truncate text-center text-xs text-muted-foreground">
                {selected?.name || 'Select a cutout on the canvas to preview it'}
              </p>
            </div>
          </>
        ) : undefined}
      </PanelSection>
  );

  const keyCard = (
    <PanelSection title="Compression">
        {/* Field carries no margin, so the fields need a group to space them — same wrapper
            the Model section uses. */}
        <FieldGroup className="gap-4">
          <Field orientation="horizontal">
            <Checkbox
              id="bg-number-files"
              checked={numberFiles}
              disabled={busy}
              onCheckedChange={(checked) => setNumberFiles(checked === true)}
            />
            <FieldContent>
              <FieldLabel htmlFor="bg-number-files" className="font-normal">
                Number exported files
              </FieldLabel>
              <FieldDescription>
                {numberFiles
                  ? 'Files are named 01-product-name.png.'
                  : 'Files use the name alone; repeats get -2, -3 so nothing is overwritten.'}
              </FieldDescription>
            </FieldContent>
          </Field>

          <BudgetControls
            idPrefix="bg"
            on={budgetOn}
            onOnChange={setBudgetOn}
            kb={budgetKb}
            onKbChange={setBudgetKb}
            kbSafe={budgetKbSafe}
            shrink={budgetShrink}
            onShrinkChange={setBudgetShrink}
            disabled={busy}
            available={png8Ready}
          />

        </FieldGroup>
      </PanelSection>
  );

  const runFooter = (
    <div className="flex gap-2">
      <Button className="flex-1" disabled={busy || !pending.length} onClick={handleRun}>
        {running ? <Spinner data-icon="inline-start" /> : <WandSparklesIcon data-icon="inline-start" />}
        {pending.length
          ? `Remove backgrounds (${pending.length})`
          : items.length
            ? 'All images cut out'
            : 'Nothing queued'}
      </Button>
      {(running || aiFixing) && (
        <Button variant="outline" onClick={handleCancel}>
          <CircleStopIcon data-icon="inline-start" />
          Stop
        </Button>
      )}
    </div>
  );

  // progress.text is never cleared once a run or an export has finished, so the compression
  // summary has to share the line with it rather than sit behind it in a fallback chain.
  // The AI-edit phase and the export can each overlap a removal batch, so their lines join in
  // rather than replacing — three phases can legitimately be reporting at once.
  const statusLine =
    (download && describeDownload(download)) ||
    [progress?.text, aiProgress?.text, exportProgress?.text, compressSummary]
      .filter(Boolean)
      .join(' · ') ||
    'Cutouts export as PNGs in a ZIP.';

  const exportFooter = (
    <div className="space-y-2">
      {progress && <Progress value={progress.pct} />}
      {aiProgress && <Progress value={aiProgress.pct} />}
      {exportProgress && <Progress value={exportProgress.pct} />}
      {download?.ratio != null && <Progress value={download.ratio * 100} />}
      <p className="text-xs break-words text-muted-foreground">
        {statusLine}
        {stage && stage !== 'done' ? ` · ${stage}` : ''}
      </p>
      <div className="flex flex-col gap-2">
        <Button
          variant="outline"
          disabled={busy || !items.length}
          onClick={() => void handleSaveProject()}
          title="Everything needed to reopen this batch later — inputs, cutouts, bounds and safe-area settings — without re-running the models"
        >
          <SaveIcon data-icon="inline-start" />
          Save project
        </Button>
        <Button disabled={busy || !cutouts.length} onClick={handleExport}>
          {exporting ? <Spinner data-icon="inline-start" /> : <DownloadIcon data-icon="inline-start" />}
          Export ZIP
        </Button>
      </div>
    </div>
  );

  const emptyState = (
    <Empty className="h-full min-h-60">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ImagesIcon />
        </EmptyMedia>
        <EmptyTitle>Nothing queued yet</EmptyTitle>
        <EmptyDescription>
          Drop or browse image files, paste an image straight from the clipboard, or drop a CSV
          and every image URL in it becomes its own queue item.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );

  const setupBanner = setupError && (
    <div className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <p className="font-medium">{SETUP_HINT}</p>
        <p className="mt-1 break-words opacity-80">{setupError}</p>
      </div>
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
                  placeholder="Untitled batch"
                  product="Cleanup"
                  chips={
                    [
                      items.length > 0 && { label: `${items.length} image${items.length === 1 ? '' : 's'}` },
                      cutouts.length > 0 && { label: `${cutouts.length} cut out` },
                      flaggedCount > 0 && { label: `${flaggedCount} flagged`, tone: 'warn' as const },
                      autosaveFailing && { label: 'Autosave failing — retrying', tone: 'warn' as const },
                      !autosaveFailing && autosavedAt !== null && {
                        label: `Autosaved ${new Date(autosavedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
                      },
                    ].filter(Boolean) as SessionChip[]
                  }
                />
              }
            >
              {inputCard}
              <PanelSection title="Model" hint="Weights download once, then stay cached.">
                  <div className="mb-3">
                    <Badge variant={modelReady ? 'default' : 'outline'}>
                      {spec.label}
                      {modelReady
                        ? ` · ready${backendLabel ? ` · ${backendLabel}` : ''}`
                        : spec.approxSizeMb
                          ? ` · ${spec.approxSizeMb} MB`
                          : ''}
                    </Badge>
                  </div>
                  <FieldGroup className="gap-4">
                    <Field>
                      <FieldLabel htmlFor="bg-model" className="sr-only">Model</FieldLabel>
                      <Select
                        value={modelId}
                        onValueChange={(value) => setModelId(value as BgModelId)}
                        disabled={busy}
                      >
                        <SelectTrigger id="bg-model" className="w-full">
                          <SelectValue>
                            {(value) => BG_MODELS[value as BgModelId]?.label ?? 'Choose a model'}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {BG_MODEL_ORDER.map((id) => {
                            const option = BG_MODELS[id];
                            const offline = option.server === true && serverUp !== true;
                            return (
                              <SelectItem key={id} value={id} disabled={offline}>
                                <span className="flex min-w-0 flex-col gap-0.5 py-0.5">
                                  <span>
                                    {option.label}
                                    {option.approxSizeMb ? ` · ${option.approxSizeMb} MB` : ''}
                                  </span>
                                  <span className="text-xs text-muted-foreground">
                                    {offline
                                      ? 'Local sidecar is not running'
                                      : option.description}
                                  </span>
                                </span>
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                      {serverBlocked && (
                        <FieldDescription>
                          {`${BG_MODELS[knownModel].label} needs its local sidecar — using ${spec.label} until it answers.`}
                        </FieldDescription>
                      )}
                    </Field>

                    <Field orientation="horizontal">
                      <Checkbox
                        id="bg-refine"
                        checked={refine}
                        disabled={busy}
                        onCheckedChange={(checked) => setRefine(checked === true)}
                      />
                      <FieldContent>
                        <FieldLabel htmlFor="bg-refine" className="font-normal">
                          <Hint hint="Slower, but much better on hair, fur and soft edges.">
                            Refine edges
                          </Hint>
                        </FieldLabel>
                      </FieldContent>
                    </Field>

                    <Field orientation="horizontal">
                      <Checkbox
                        id="bg-high-detail"
                        checked={highDetail}
                        disabled={busy}
                        onCheckedChange={(checked) => setHighDetail(checked === true)}
                      />
                      <FieldContent>
                        <FieldLabel htmlFor="bg-high-detail" className="font-normal">
                          <Hint hint="Re-runs the model on a tight crop of the subject for sharper edges — about twice as slow per image.">
                            High detail (two passes)
                          </Hint>
                        </FieldLabel>
                      </FieldContent>
                    </Field>

                    <Field orientation="horizontal">
                      <Checkbox
                        id="bg-product-only"
                        checked={productOnly}
                        disabled={busy}
                        onCheckedChange={(checked) => setProductOnly(checked === true)}
                      />
                      <FieldContent>
                        <FieldLabel htmlFor="bg-product-only" className="font-normal">
                          <Hint hint="Drops flat colour strips and badges the model kept, and re-measures the subject without them. Only affects graphics detached from the product.">
                            Product only
                          </Hint>
                        </FieldLabel>
                      </FieldContent>
                    </Field>

                    <Field>
                      <FieldLabel>
                        <Hint hint="Applied on export and in the previews; the cutout itself keeps its alpha.">
                          Output background
                        </Hint>
                      </FieldLabel>
                      <div className="flex items-center gap-2">
                        <ToggleGroup
                          value={[bgChoice]}
                          onValueChange={(value) => value[0] && chooseBackground(value[0])}
                          variant="outline"
                          size="sm"
                          disabled={busy}
                        >
                          <ToggleGroupItem value="transparent">Transparent</ToggleGroupItem>
                          <ToggleGroupItem value="white">White</ToggleGroupItem>
                          <ToggleGroupItem value="custom">Custom</ToggleGroupItem>
                        </ToggleGroup>
                        {bgChoice === 'custom' && (
                          <Input
                            type="color"
                            aria-label="Custom output background"
                            className="h-7 w-12 p-1"
                            value={outputBg}
                            onChange={(e) => setOutputBg(e.target.value)}
                          />
                        )}
                      </div>
                    </Field>

                    {!spec.server && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-fit"
                        disabled={busy || modelReady}
                        onClick={() => void handleWarm()}
                      >
                        {warming ? (
                          <Spinner data-icon="inline-start" />
                        ) : (
                          <CloudDownloadIcon data-icon="inline-start" />
                        )}
                        {modelReady
                          ? 'Model loaded'
                          : `Warm up${spec.approxSizeMb ? ` · ${spec.approxSizeMb} MB download` : ''}`}
                      </Button>
                    )}
                  </FieldGroup>
                </PanelSection>
              {aiCard}
            </LeftPanel>

            <Canvas scrollRef={removeScrollRef}>
              {setupBanner}
              {items.length === 0 ? (
                emptyState
              ) : (
                <>
                  {/* Grid toolbar: count on the left, whole-queue reset on the right. */}
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      {gridSel.active
                        ? `${gridSel.checked.size} of ${items.length} selected`
                        : `${items.length} image${items.length === 1 ? '' : 's'}`}
                    </span>
                    <ClearAllButton
                      title="Clear the queue?"
                      disabled={busy}
                      onConfirm={clearAllItems}
                      description={
                        <>
                          Removes all {items.length} image{items.length === 1 ? '' : 's'},
                          including finished cutouts that haven&rsquo;t been exported. Your
                          source files on disk are untouched.
                        </>
                      }
                    />
                  </div>
                  {flaggedCount > 0 && (
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        // `running` is deliberately absent: flagged items can start their Azure
                        // phase while the rest of the batch is still removing; only their
                        // re-removal waits for the workers to free up.
                        disabled={aiFixing || exporting || warming || !aiReady || !flaggedItems.length}
                        title={
                          aiReady
                            ? 'Regenerate every flagged image with the AI edit prompt, then re-remove their backgrounds (after the current batch, if one is running). Parallelism comes from Settings → Image model.'
                            : 'AI edit needs the Azure endpoint + key (Settings, gear in the rail)'
                        }
                        onClick={() => void handleAiEditFlagged()}
                      >
                        {aiFixing ? (
                          <Spinner data-icon="inline-start" />
                        ) : (
                          <WandSparklesIcon data-icon="inline-start" />
                        )}
                        AI-fix flagged ({flaggedItems.length})
                      </Button>
                      <label
                        className="flex items-center gap-1.5 text-xs text-muted-foreground"
                        title="Keep watching the queue and send every newly flagged image to the AI edit automatically — each image is sent at most once."
                      >
                        <Switch
                          checked={autoAiFix}
                          onCheckedChange={setAutoAiFix}
                          disabled={!aiReady}
                        />
                        Auto
                      </label>
                      <ToggleGroup
                        size="sm"
                        variant="outline"
                        value={[qualitySort ? 'quality' : 'queue']}
                        onValueChange={(next) => setQualitySort(next[0] === 'quality')}
                      >
                        <ToggleGroupItem value="queue" aria-label="Queue order">
                          Queue order
                        </ToggleGroupItem>
                        <ToggleGroupItem value="quality" aria-label="Flagged first">
                          <CircleAlertIcon data-icon="inline-start" />
                          Flagged
                        </ToggleGroupItem>
                      </ToggleGroup>
                    </div>
                  )}
                  <VirtualGrid
                    items={displayItems}
                    scrollRef={removeScrollRef}
                    minCellWidth={GRID_MIN_CELL}
                    gap={GRID_GAP}
                    // Preview box plus the filename line beneath it. VirtualGrid rows must stay
                    // uniform, so with per-item overrides a MIXED queue sizes every row to the
                    // taller of the two shapes and the shorter cells letterbox inside; all-tile
                    // and all-square queues keep their exact old heights.
                    cellHeight={(w) => {
                      const r = safeArea.tile.height / safeArea.tile.width;
                      const h = tileStats.all ? w * r : tileStats.any ? w * Math.max(1, r) : w;
                      return h + GRID_LABEL_HEIGHT;
                    }}
                    keyOf={(item) => item.id}
                    renderItem={(item, index) => (
                      <CutoutCell
                        item={item}
                        label={item.name || `Image ${index + 1}`}
                        selected={item.id === highlightId}
                        checked={gridSel.checked.has(item.id)}
                        selectionActive={gridSel.active}
                        background={outputBg}
                        running={busy}
                        tileConfig={effectiveTileFit(item) ? safeArea : null}
                        tileOverride={item.tileFit}
                        onSelect={selectById}
                        onCompare={compareById}
                        onRemove={removeById}
                        onToggleSelect={gridSel.toggle}
                      />
                    )}
                  />
                  {gridSel.active && (
                    <SelectionBar
                      count={gridSel.checked.size}
                      total={items.length}
                      allSelected={gridSel.allSelected}
                      busy={busy}
                      actions={[
                        {
                          key: 'ai-edit',
                          label: aiReady
                            ? 'AI edit selected — regenerate with the AI edit prompt, then re-remove backgrounds'
                            : 'AI edit needs the Azure endpoint + key (Settings, gear in the rail)',
                          icon: WandSparklesIcon,
                          accent: true,
                          disabled: !aiReady,
                          onRun: () => void handleAiEditSelected(),
                        },
                        {
                          key: 'redo',
                          label: 'Redo selected — re-remove backgrounds with the current model settings',
                          icon: RefreshCwIcon,
                          onRun: handleRetrySelected,
                        },
                        {
                          key: 'tile-fit',
                          label: selAllTiled
                            ? 'Turn tile fit OFF for the selected images — only they change, and they stop following the global switch'
                            : 'Turn tile fit ON for the selected images — only they change, and they stop following the global switch',
                          icon: FrameIcon,
                          onRun: toggleTileFitSelected,
                        },
                      ]}
                      deleteTitle={`Delete ${gridSel.checked.size} image${gridSel.checked.size === 1 ? '' : 's'}?`}
                      deleteDescription="Removes them from the queue, including any finished cutouts. Your source files on disk are untouched."
                      onDelete={deleteSelected}
                      onSelectAll={gridSel.selectAll}
                      onClear={gridSel.clear}
                    />
                  )}
                </>
              )}
            </Canvas>

            <RightPanel
              title="Process & export"
              footer={exportFooter}
            >
              {tileFitCard}
              {proc.panel}
              {keyCard}
            </RightPanel>
          </StudioShell>



      {/* One dialog for the whole product: queue rows and result images open the same view. */}
      <CompareDialog
        item={compareItem}
        index={compareIndex < 0 ? 0 : compareIndex}
        background={outputBg}
        numbered={numberFiles}
        onClose={() => setCompareId(null)}
        onUndo={(item) => undoItem(item.id)}
        models={redoModels}
        defaultModel={modelId}
        defaultRefine={refine}
        onRedo={(item, options) =>
          handleRetry(item, { model: options.model as BgModelId, refine: options.refine })
        }
        aiEdit={{
          ready: aiReady && !busy,
          hint: aiReady
            ? 'Send to Azure GPT-Image with this prompt; the result replaces this image'
            : 'Set the Azure endpoint + key in Settings (gear in the rail) first',
          defaultPrompt: aiPrompt,
          onEdit: (item, prompt) => void handleAiEdit(item, prompt),
        }}
        busy={busy}
      />

      {/* Crash recovery — blocking on purpose: while this is undecided, autosave holds all
          writes, so leaving it open-ended (the old toast) silently disabled the crash net for
          the whole session. Only the two buttons close it. */}
      <AlertDialog open={autosavePending !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Unsaved session found — {autosavePending?.count ?? 0} image
              {(autosavePending?.count ?? 0) === 1 ? '' : 's'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Autosaved {autosavePending ? new Date(autosavePending.savedAt).toLocaleString() : ''}.
              Restore it into the queue, or discard it to start fresh. Autosave stays paused
              until you choose.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => discardAutosave()}>Discard</AlertDialogCancel>
            <AlertDialogAction onClick={handleRestoreAutosave}>Restore</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Prompt editor — the .md tile in the AI edit card opens this. Edits bind live to the
          persisted default; Reset restores the shipped packshot prompt. */}
      <Dialog open={promptEditorOpen} onOpenChange={setPromptEditorOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MdFileIcon className="size-4 text-muted-foreground" />
              {activeAiSkill?.name ?? 'ai-edit-prompt.md'}
            </DialogTitle>
            <DialogDescription>
              The default prompt for every AI edit, including the AI-fix flagged batch.
              Individual images can override it from their compare dialog without changing this.
            </DialogDescription>
          </DialogHeader>
          {/* Capped: the textarea auto-grows with content (field-sizing-content), so a long
              prompt would otherwise push the dialog past the viewport. */}
          <Textarea
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            rows={16}
            disabled={busy}
            aria-label="Default AI edit prompt"
            className="max-h-[55dvh] min-h-40 overflow-y-auto text-xs"
          />
          <DialogFooter>
            {promptCustomised && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setAiPrompt(DEFAULT_AI_PROMPT)}
              >
                Reset to default
              </Button>
            )}
            <Button onClick={() => setPromptEditorOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---- Layout scaffolding ---------------------------------------------------

// Both result grids are memoised per cell. A batch patches state once per finished image, and
// re-rendering every cell each time cost more than the inference did once a queue got long.
// selected/label/background are primitives and onSelect is stable, so only the changed cell
// re-renders.
/**
 * A cutout composited on its tile, for the canvas cells when Tile fit is on. Split out so the
 * preview-cache hook only exists while a cell is on screen — with virtualisation that is a few
 * dozen decodes, not one per queued image.
 */
function TileFitThumb({
  itemId,
  cutout,
  config,
}: {
  itemId: number;
  cutout: NonNullable<BgItem['cutout']>;
  config: SafeAreaConfig;
}) {
  const preview = usePreview({ key: itemId, blob: cutout.blob, edge: 256 });
  const scale = preview ? previewScale(cutout, preview) : 1;
  const bounds = cutout.bounds && preview ? scaleBounds(cutout.bounds, scale) : null;
  // sourceScale keeps the upscale guard honest: the thumb renders from a small preview, and
  // without it a no-upscale config capped the subject at PREVIEW resolution — every cell a
  // different size, none matching the export. No caption either; the cell has its own label.
  return (
    <TilePreview
      source={preview}
      bounds={bounds}
      config={config}
      showOverlay={false}
      maxSize={230}
      sourceScale={scale}
      showCaption={false}
    />
  );
}

const CutoutCell = React.memo(function CutoutCell({
  item,
  label,
  selected,
  checked,
  selectionActive,
  background,
  running,
  tileConfig,
  tileOverride,
  onSelect,
  onCompare,
  onRemove,
  onToggleSelect,
}: {
  item: BgItem;
  label: string;
  selected: boolean;
  checked: boolean;
  selectionActive: boolean;
  background: string;
  running: boolean;
  /** Set when this item's EFFECTIVE tile fit is on: the cell shows the cutout on its tile. */
  tileConfig: SafeAreaConfig | null;
  /** The item's own override (undefined = follows the global switch) — shown as a badge. */
  tileOverride: boolean | undefined;
  onSelect: (id: number) => void;
  /** Clicking any result opens the same before/after view as a queue row, finished or not. */
  onCompare: (id: number) => void;
  onRemove: (id: number) => void;
  onToggleSelect: (id: number, shiftKey: boolean) => void;
}) {
  const working =
    item.status === 'removing' || item.status === 'loading-model' || item.status === 'editing';
  const quality = item.status === 'done' ? assessQuality(item) : null;
  return (
    <ResultCell
      label={label}
      status={statusLine(item)}
      selected={selected}
      checked={checked}
      selectionActive={selectionActive}
      onSelect={() => {
        onSelect(item.id);
        // Deliberately ungated on `cutout`: an AI edit clears the cutout until its re-removal
        // lands, and that window can last indefinitely (deferred behind a batch, stopped,
        // errored, or restored mid-flow). Gating here stranded exactly those images — the
        // dialog is the only place Undo, the per-image prompt and Redo live, so the item
        // people most need to inspect was the one they could not open.
        onCompare(item.id);
      }}
      onToggleSelect={(shiftKey) => onToggleSelect(item.id, shiftKey)}
      onRemove={() => onRemove(item.id)}
      removeDisabled={running}
    >
      <div
        // TilePreview frames itself, so tile mode drops the cell's own border and backdrop —
        // a wrapper box would double-frame it.
        //
        // The cell takes the TILE's aspect ratio in tile mode rather than staying square: a
        // definite-width frame with an aspect-ratio cannot shrink its width back when a
        // max-height binds, so a portrait tile in a square cell came out both distorted and
        // cropped. Matching the ratio here means the frame is only ever width-constrained.
        className={cn(
          'relative grid place-items-center overflow-hidden rounded-lg',
          tileConfig && item.cutout ? undefined : 'aspect-square border p-2',
        )}
        style={
          tileConfig && item.cutout
            ? { aspectRatio: `${tileConfig.tile.width} / ${tileConfig.tile.height}` }
            : backdropStyle(background)
        }
      >
        {item.cutout ? (
          tileConfig ? (
            <TileFitThumb itemId={item.id} cutout={item.cutout} config={tileConfig} />
          ) : (
            <CutoutImage itemId={item.id} cutout={item.cutout} max={240} className="max-h-full max-w-full" />
          )
        ) : (
          // The original stands in until its cutout replaces it — the tile is the queue row now,
          // so an image is visible from the moment it is added, not only once it is done.
          <SourceImage item={item} className="max-h-full max-w-full object-contain" />
        )}
        {working && (
          <div className="absolute inset-0 grid place-items-center bg-background/70">
            <Spinner className="size-5 text-primary" />
          </div>
        )}
        {item.status === 'error' && (
          <TriangleAlertIcon className="absolute bottom-2 left-2 size-4 text-destructive" />
        )}
        {quality && quality.level !== 'ok' && (
          <Hint
            hint={quality.reasons.join(' · ')}
            className="absolute bottom-2 left-2"
          >
            <CircleAlertIcon
              className={cn('size-4', quality.level === 'bad' ? 'text-destructive' : 'text-amber-500')}
            />
          </Hint>
        )}
        {tileOverride !== undefined && (
          <Hint
            hint={`Tile fit forced ${tileOverride ? 'on' : 'off'} for this image — the global switch doesn't apply. Select it and use the bar's frame button to change.`}
            className="absolute right-2 bottom-2"
          >
            <FrameIcon className={cn('size-4', tileOverride ? 'text-primary' : 'text-muted-foreground')} />
          </Hint>
        )}
      </div>
    </ResultCell>
  );
});

