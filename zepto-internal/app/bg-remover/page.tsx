'use client';

import * as React from 'react';
import { toast } from 'sonner';
import {
  CircleAlertIcon,
  CircleStopIcon,
  CloudDownloadIcon,
  DownloadIcon,
  FrameIcon,
  RefreshCwIcon,
  SaveIcon,
  TriangleAlertIcon,
  SparklesIcon,
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

import { Button } from '@/components/ui/button';
import { Hint } from '@/components/hint';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field, FieldContent, FieldDescription, FieldGroup, FieldLabel,
} from '@/components/ui/field';
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
import { Canvas, CanvasToolbar, LeftPanel, PanelSection, RightPanel, StudioShell } from '@/components/pane-layout';
import { useProcessing } from '@/components/process-panel';
import {
  CompareDialog, CutoutImage, SourceImage, backdropStyle, statusLine,
} from '@/components/bg-remover/bg-queue-list';
import { ImageDropzone, type CsvPayload } from '@/components/bg-remover/image-dropzone';
import { CsvFileTile } from '@/components/csv-dropzone';
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
  SETUP_HINT, canRetry, canvasToPngBlob, canvasToPngBytes, createItems, csvCellKey, csvSourceUrl, cutoutEvidence, describeDownload, draftsFromCsv, errorMessage,
  exportFileNames, flattenOnBackground, formatKb, isAbortError,
  decodeCutout, loadImageFromFile, looksLikeMissingWeights, mapWithLimit, needsCutout,
  nextItemId, pickSave, previewScale, releaseCanvas, releaseItem, releaseOriginal, sameCsvOrigin, saveTo, withCutout,
  type CutoutItem,
  type SaveDestination,
  type BgCutout, type BgItem, type BgItemDraft, type BgItemSource, type BgItemStatus,
} from '@/lib/bg/batch';
import { useAutosave, type AutosaveRecord } from '@/lib/bg/autosave';
import { measureFaintResidue } from '@/lib/bg/regions';
import { describeBudget, fitToBudget, type BudgetResult } from '@/lib/bg/budget';
import { isPng8Supported } from '@/lib/bg/png8';
import {
  disposePool, getPoolBackend, isPoolSupported, poolRemoveBackground, warmPool,
  type PoolCutout,
} from '@/lib/bg/pool';
import { PROJECT_EXTENSION, loadProject, saveProject, type ProjectCsv } from '@/lib/bg/project';
import {
  assessQuality, assessQueue, countQueueFilters, filterQueue, isAiGenerated, needsVerify,
  sortByQualityWith, verdictLookup,
  type QueueFilter, type QueueSort,
} from '@/lib/bg/quality';
import { VERIFY_MODEL_ID, compareCutouts, filteredRects } from '@/lib/bg/verify';
import { askSemantic, probeSemanticSidecar } from '@/lib/bg/semantic';
import { QueueFilters } from '@/components/bg-remover/queue-filters';
import { ColorPicker } from '@/components/color-picker';
import { ColumnPicker } from '@/components/column-picker';
import { BatchPromptDialog, resolvePromptSource, type PromptSource } from '@/components/regen-prompt';
import { parseCSV } from '@/lib/csv';
import { buildRowPrompt } from '@/lib/row-prompt';
import { BatchList } from '@/components/bg-remover/batch-list';
import {
  DEFAULT_SEAL_SIZE, cleanUnexported, nextAllocation, planExport, planFinalSeal, planReexport,
  planSeal,
  recordBatch, remainingUnexported, stampBatch, summarizeLedger, unverifiedUnexported,
  type Allocation, type BatchRecord, type ExportPlan,
} from '@/lib/bg/ledger';
import { readParallel } from '@/lib/rate';
import { createEta } from '@/lib/eta';
import { DEFAULT_AI_PROMPT, matchSkill, useSkills } from '@/lib/skills';
import { clearPreviews, dropPreview, usePreview } from '@/lib/bg/preview-store';
import { readSession, restingStatus, saveSession, sessionKey } from '@/lib/bg/session-store';
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

/**
 * Separates the AI-edit prompt from the CSV row's cells. Worded for the edits endpoint, which
 * is looking at the product rather than inventing it: the row describes what the picture
 * already shows ("this is a 500 g butter pack"), it does not order up a new one.
 */
const AI_ROW_HEADING = 'Details of the product in this image:';

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
/**
 * What survives a hop to another product. Not persistence — see lib/bg/session-store.ts; this
 * only covers the route change the rail makes one click away, which used to take a half-finished
 * batch with it. Run flags are deliberately absent: leaving aborts the batch, so coming back to
 * a queue that claims to be running would be a lie.
 */
interface BgSession {
  items: BgItem[];
  sessionName: string;
  selectedId: number | null;
  queueFilter: QueueFilter;
  queueSort: QueueSort;
  ledger: BatchRecord[];
  allocFloor: Allocation;
  csvInfo: CsvInfo | null;
  /** Ids already sent to Azure, so returning cannot re-buy an AI fix this session paid for. */
  aiAttempted: number[];
}

const BG_SESSION = sessionKey<BgSession>('bg-remover');

interface CsvInfo {
  fileName: string;
  text: string;
  headers: string[];
  imageColumns: string[];
  nameColumn: string;
  /**
   * Columns whose cells ride along with the AI-edit prompt; empty = the prompt goes alone.
   * Optional: a session snapshot written before this field existed revives without it.
   */
  promptColumns?: string[];
  /** Optional: a session revived from before this field existed simply shows no row badge. */
  rowCount?: number;
}

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
      ? {
          blob: record.cutout,
          bounds: record.bounds,
          width: record.width,
          height: record.height,
          ...(record.residueFraction !== undefined
            ? { residueFraction: record.residueFraction }
            : null),
        }
      : null,
    // A record without a cutout is an AI-regenerated source that crashed before re-removal —
    // it comes back queued, one "Remove backgrounds" away from where it left off.
    status: record.cutout ? 'done' : 'ready',
    // Provenance has to come back with the row or a later remap has only the URL to go on, and
    // one CSV row's images repeat across rows: two rows sharing a picture both took the first
    // row's title, so restoring and then changing the name column mislabelled every duplicate.
    ...(record.csv ? { csv: record.csv } : null),
    ...(record.originalSourceUrl
      ? { originalSource: { kind: 'url' as const, url: record.originalSourceUrl } }
      : null),
    ...(record.batch !== undefined ? { batch: record.batch } : null),
    // Without these the verdict is recomputed from the bounding box alone and a row that was
    // flagged for residue or a surviving prop comes back looking clean.
    ...(record.regions?.length ? { regionReport: record.regions } : null),
    ...(record.removedRegions !== undefined ? { removedRegions: record.removedRegions } : null),
    ...(record.originalInk ? { originalInk: record.originalInk } : null),
    ...(record.components?.length ? { originalComponents: record.components } : null),
    ...(record.verify ? { verify: record.verify } : null),
    ...(record.bands?.length ? { bands: record.bands } : null),
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
  // Drops flat graphic panels (colour strips, badges) the matte kept as foreground. Off by
  // default: it is a heuristic, so it only ever runs where it was asked for.
  const [productOnly, setProductOnly] = usePersistedState('skuc_bgProductOnly', false);
  const [glass, setGlass] = usePersistedState('skuc_bgGlass', false);
  // Continuously sends newly flagged cutouts through the AI edit, no button press per wave.
  // Off by default: every send spends Azure money, so the standing order has to be explicit.
  const [autoAiFix, setAutoAiFix] = usePersistedState('skuc_bgAutoAiFix', false);
  // Second-model cross-check on ambiguous cutouts after each batch (quality.needsVerify).
  // On by default: the ambiguous band is small by construction, so the cost is a handful of
  // BiRefNet inferences per batch — and the failures it catches are the invisible ones.
  const [verifyPass, setVerifyPass] = usePersistedState('skuc_bgVerifyPass', true);
  // Semantic pass: the optional Qwen sidecar answering "is anything here besides the product?"
  // Off by default — it needs Ollama running locally and costs a few seconds per image, so it
  // is opt-in the way the HQ server model is, not a silent tax on every batch.
  const [semanticPass, setSemanticPass] = usePersistedState('skuc_bgSemanticPass', false);
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
  // The wand asks before it spends: pressing it opens the batch prompt rather than firing.
  const [aiBatchOpen, setAiBatchOpen] = React.useState(false);
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
  // Seeded from the session store so a hop to another product and back returns the queue
  // rather than an empty grid. readSession is a plain read, so StrictMode's second pass in dev
  // gets the same snapshot instead of an emptied one.
  const [items, setItems] = React.useState<BgItem[]>(() => readSession(BG_SESSION)?.items ?? []);
  // Whether this mount inherited a live session rather than starting empty. Read once, before
  // anything can add to the queue, because it decides how autosave treats the records on disk.
  const adoptedSessionRef = React.useRef(items.length > 0);
  // Crash recovery: mirrors finished work into IndexedDB and offers the previous session back
  // after a crash. Declared against `items` so every mutation path syncs through one place.
  const {
    pending: autosavePending,
    restore: restoreAutosave,
    discard: discardAutosave,
    lastSavedAt: autosavedAt,
    failing: autosaveFailing,
    saveCsv: autosaveCsv,
    saveLedger: autosaveLedger,
  } = useAutosave(items, {
    // A queue carried across a product switch is not a crash to recover from.
    adopt: adoptedSessionRef.current,
  });

  /**
   * Rebuilds the panel's CSV state from a saved sheet. `headers` is not stored — re-parsing the
   * text is what the mapping UI needs anyway, and one parse on open is cheaper than carrying a
   * second copy of the column list that could disagree with the text it came from.
   */
  const csvInfoFromSheet = React.useCallback((sheet: ProjectCsv) => {
    const { headers, rowCount } = draftsFromCsv(sheet.text, {
      nameColumn: sheet.nameColumn || null,
      imageColumns: sheet.imageColumns,
    });
    return {
      fileName: sheet.fileName,
      text: sheet.text,
      headers,
      imageColumns: sheet.imageColumns,
      nameColumn: sheet.nameColumn,
      promptColumns: sheet.promptColumns ?? [],
      rowCount,
    };
  }, []);

  // Figma-style "file name" for the session, shown in the panel header. Working state, not
  // decoration: it seeds the .zesku and export ZIP filenames. Auto-seeded from the first
  // CSV/project file dropped, but never over a name the user already typed.
  const [sessionName, setSessionName] = React.useState(() => readSession(BG_SESSION)?.sessionName ?? '');
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
      // Stamps are resolved against the RECORD ids, before the rebuild re-mints them — after
      // that the question "was this row already exported?" has no answer, and every image of
      // every shipped batch would go out again in the next ZIP.
      const shipped = new Map<number, number>();
      for (const row of records.ledger ?? []) {
        for (const id of row.ids) shipped.set(id, row.batch);
      }
      batchIdsRef.current = new Map();
      setItems((prev) => {
        const base = nextItemId(prev);
        return [
          ...prev,
          ...records.map((r, i) => {
            const item = itemFromAutosave(r, base + i);
            const batch = shipped.get(r.id) ?? item.batch;
            if (batch !== undefined) {
              const ids = batchIdsRef.current.get(batch) ?? [];
              ids.push(item.id);
              batchIdsRef.current.set(batch, ids);
            }
            return batch === undefined ? item : { ...item, batch };
          }),
        ];
      });
      // Only when this session has no sheet of its own: a recovered queue must never displace
      // the CSV the user is already working against.
      if (records.csv) setCsvInfo((prev) => prev ?? csvInfoFromSheet(records.csv!));
      toast.success(`Restored ${records.length} image${records.length === 1 ? '' : 's'}.`);
    });
  }, [restoreAutosave, csvInfoFromSheet]);
  const [selectedId, setSelectedId] = React.useState<number | null>(
    () => readSession(BG_SESSION)?.selectedId ?? null,
  );
  // Display-only view of the queue — filtering and sorting never touch `items`, so export
  // naming, retry-by-id and batch membership are all unaffected by what is on screen.
  const [queueFilter, setQueueFilter] = React.useState<QueueFilter>(
    () => readSession(BG_SESSION)?.queueFilter ?? 'all',
  );
  const [queueSort, setQueueSort] = React.useState<QueueSort>(
    () => readSession(BG_SESSION)?.queueSort ?? 'queue',
  );
  // Assessed once per queue change. The verdict is pure arithmetic, but it was being recomputed
  // in two memos plus once per visible cell per render; the filter needs it for every item, so
  // one pass feeds all of them.
  const verdicts = React.useMemo(() => assessQueue(items), [items]);
  const verdictOf = React.useMemo(() => verdictLookup(verdicts), [verdicts]);
  const filterCounts = React.useMemo(
    () => countQueueFilters(items, verdictOf),
    [items, verdictOf],
  );
  const flaggedCount = filterCounts.flagged;
  // What "AI-fix flagged" operates on — a WORKLIST, not the view. Archived items are excluded
  // because they have no original left to send to the model, which is why this count can sit
  // below the flagged chip's: the chip shows every flagged tile, including the unfixable ones.
  // Deriving one from the other would either hide tiles or promise fixes that cannot happen.
  const flaggedItems = React.useMemo(
    () => items.filter((item) => canRetry(item) && verdictOf(item).level !== 'ok'),
    [items, verdictOf],
  );
  // ---- Export ledger ----
  // A batch is born when it is EXPORTED, never when it is flagged: flagged-ness changes the
  // moment an AI fix lands, so a cohort defined by it would leak members and those images would
  // end up in no ZIP at all. "Clean" ships now, "the rest" ships when the user says so, and the
  // two together are always exactly the queue.
  const [ledger, setLedger] = React.useState<BatchRecord[]>(() => readSession(BG_SESSION)?.ledger ?? []);
  /**
   * Batches whose numbers and file range are allocated but whose ZIP is not on disk yet — sealed
   * and waiting for the click that a save dialog legally needs, or currently encoding, or failed
   * and awaiting a retry. They keep their claim the whole time: encoding takes minutes and the
   * stamp only lands on success, so anything that forgot them would hand the same images and the
   * same file numbers to a second ZIP.
   */
  const [openPlans, setOpenPlans] = React.useState<ExportPlan[]>([]);
  const claimed = React.useMemo(
    () => new Set(openPlans.flatMap((plan) => plan.items.map((it) => it.id))),
    [openPlans],
  );
  // Set in Settings -> Defaults; usePersistedState syncs the change into this tab live.
  const [sealSize] = usePersistedState('skuc_bgSealSize', DEFAULT_SEAL_SIZE);
  const [selectedBatch, setSelectedBatch] = React.useState<number | null>(null);
  const [exportingBatch, setExportingBatch] = React.useState<number | null>(null);
  // Files already written cannot be un-written, so numbering may never retreat into names that
  // exist — not when shipped rows are deleted, and not when a restore brings back stamps without
  // their records. Moved when a range is handed out, never when it lands.
  // Whether the run in progress has sealed a batch, which is what decides if its leftover clean
  // images are worth a batch of their own when it ends.
  const sealedThisRunRef = React.useRef(false);
  const wasRunningRef = React.useRef(false);
  /** Ids per shipped batch — what the crash net needs to re-stamp a restored queue. */
  const batchIdsRef = React.useRef(new Map<number, number[]>());
  const allocFloorRef = React.useRef<Allocation>(
    readSession(BG_SESSION)?.allocFloor ?? { batch: 1, offset: 0 },
  );

  const displayItems = React.useMemo(() => {
    const byBatch =
      selectedBatch === null ? items : items.filter((it) => it.batch === selectedBatch);
    const shown = filterQueue(byBatch, queueFilter, verdictOf);
    return queueSort === 'quality' ? sortByQualityWith(shown, verdictOf) : shown;
  }, [items, selectedBatch, queueFilter, queueSort, verdictOf]);

  const cleanCohort = React.useMemo(
    () => cleanUnexported(items, verdictOf, { claimed }),
    [items, verdictOf, claimed],
  );
  const restCohort = React.useMemo(() => remainingUnexported(items, { claimed }), [items, claimed]);
  const unverifiedCohort = React.useMemo(
    () => unverifiedUnexported(items, { claimed }),
    [items, claimed],
  );
  const ledgerSummary = React.useMemo(
    () => summarizeLedger(items, ledger, { claimed }),
    [items, ledger, claimed],
  );

  /**
   * Rows for both halves of a batch's life: rows already on disk come from the ledger, rows
   * sealed but not yet downloaded come from the open plans — a sealed batch has its number the
   * moment it is allocated, so it gets a chip and a Download button straight away instead of
   * being invisible until its file exists.
   */
  const batchRows = React.useMemo(() => {
    const shipped = ledgerSummary.batches.map((b) => ({
      batch: b.batch,
      done: b.present,
      total: b.shipped ?? b.present,
      downloaded: true,
      stale: b.staleness === 'stale',
    }));
    // No custom label: the list renders its own state chip, and "Batch 1 · ready" beside a
    // "ready" chip said the same thing twice.
    const waiting = openPlans.map((plan) => ({
      batch: plan.batch,
      done: plan.items.length,
      total: plan.items.length,
      downloaded: false,
    }));
    return [...shipped, ...waiting].sort((a, b) => a.batch - b.batch);
  }, [ledgerSummary, openPlans]);

  // ---- Run state ----
  const [running, setRunning] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [warming, setWarming] = React.useState(false);
  /** True while "AI-fix flagged" is mid-flight through Azure (before the re-removal batch). */
  const [aiFixing, setAiFixing] = React.useState(false);
  // Mirrors verifyingRef for rendering. The sweep drives the progress bar and holds the pool,
  // so it is a visible working phase and must be stoppable — the Stop button renders on this.
  const [verifying, setVerifying] = React.useState(false);
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
  // The post-batch verify sweep: its own abort (Cancel stops it; a starting batch pre-empts
  // it) and its own lock — it must never overlap itself, and it yields the workers to any
  // batch immediately.
  const verifyAbortRef = React.useRef<AbortController | null>(null);
  const verifyingRef = React.useRef(false);
  // A sweep that was owed while another was still unwinding. Without it, a batch short enough
  // to finish before the pre-empted sweep unwinds leaves the queue with no sweep at all.
  const verifyPendingRef = React.useRef(false);
  // Whether the sidecar answered its health probe. Null while unknown, so the switch can stay
  // hidden rather than offering a pass that would fail on every image.
  const [semanticReady, setSemanticReady] = React.useState<boolean | null>(null);
  const semanticAbortRef = React.useRef<AbortController | null>(null);
  const semanticRef = React.useRef(false);
  // Every id that has been through an AI edit once, manual or auto. The auto-fix watcher never
  // resends one: an image that comes back still flagged after its regeneration would otherwise
  // cycle through Azure forever, spending money on an image the model cannot fix.
  const aiAttemptedRef = React.useRef<Set<number>>(new Set(readSession(BG_SESSION)?.aiAttempted));
  // The run loop reads the queue across awaits, so it needs the committed value, not a closure.
  const itemsRef = React.useRef<BgItem[]>(items);
  React.useEffect(() => { itemsRef.current = items; }, [items]);

  // The unmount cleanup runs once, so its closure is the FIRST render's — it would snapshot an
  // empty session. Everything it needs is mirrored here on every commit instead.
  const sessionRef = React.useRef<BgSession>({
    items,
    sessionName,
    selectedId,
    queueFilter,
    queueSort,
    csvInfo: null,
    ledger: [],
    allocFloor: { batch: 1, offset: 0 },
    aiAttempted: [],
  });

  // Leaving the product must stop inference (the models hold the main thread otherwise) and hand
  // back every object URL the decoded originals are holding — a client-side route change keeps
  // the document alive, so nothing else ever revokes them.
  React.useEffect(
    () => () => {
      abortRef.current?.abort();
      // The AI phase can outlive the page too — without this, in-flight Azure requests keep
      // running (and spending) after navigation, then respawn the disposed worker pool.
      aiAbortRef.current?.abort();
      // Same for the verify sweep, and for the same reason: between items it is awaiting a
      // decode rather than the pool, so disposePool's orphan rejection never reaches it — it
      // would walk on after navigation and call ensurePool(), respawning the very workers
      // being torn down two lines below and reloading BiRefNet into them.
      verifyAbortRef.current?.abort();
      semanticAbortRef.current?.abort();
      // Snapshot BEFORE the teardown below, then hand back every decoded original: releaseItem
      // revokes those blob: URLs and clearPreviews closes the cached bitmaps, so a snapshot that
      // kept them would revive a queue of broken images. `original` re-decodes from `source` on
      // demand, so dropping it costs one read and nothing else.
      //
      // Statuses have to come to rest as well. The aborts above resolve their cancellation
      // patches after this component is gone, so those writes never commit — without this, rows
      // caught mid-run come back as permanent spinners, and one stuck in 'editing' refuses any
      // further AI edit.
      saveSession(BG_SESSION, {
        ...sessionRef.current,
        items: itemsRef.current.map((item) => ({
          ...item,
          original: null,
          status: restingStatus(item.status, item.cutout !== null),
        })),
        aiAttempted: [...aiAttemptedRef.current],
      });
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
  // The verify sweep always infers with the checker model, so its poolability is the
  // checker's question, never the selected batch model's.
  const verifyViaPool = isPoolSupported() && !BG_MODELS[VERIFY_MODEL_ID].server;
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

  // Selection is dropped whenever the view changes. useGridSelection prunes its checked set
  // against the visible order, so switching filters otherwise produces three different
  // surprises: ids checked while hidden reappear when the filter clears, a toggle while
  // filtered silently drops them for good, and select-all replaces them wholesale. Clearing is
  // the one behaviour that reads the same in all three.
  const changeQueueFilter = React.useCallback(
    (next: QueueFilter) => {
      setQueueFilter(next);
      gridSel.clear();
    },
    [gridSel],
  );

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

  // The same atomicity for a measurement that describes ONE cutout. A verdict is only true of
  // the blob it was computed from, and the source check above cannot stand in for that: undo
  // of a redo restores the very same source object, so a stale write passes the source test
  // while the cutout underneath it has been swapped.
  const patchItemIfCutout = React.useCallback(
    (id: number, cutout: BgCutout, patch: Partial<BgItem>) => {
      setItems((prev) =>
        prev.map((item) =>
          item.id === id && item.cutout === cutout ? { ...item, ...patch } : item,
        ),
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
  const [csvInfo, setCsvInfo] = React.useState<CsvInfo | null>(
    () => readSession(BG_SESSION)?.csvInfo ?? null,
  );

  // ---- Row context for the AI edit ----
  // Items carry only the cell they were imported from ({row, column}); the fields that cell sat
  // next to live in the sheet's text. Re-parsing it here is what turns a queued picture back
  // into the row that describes it. Keyed on the text alone, so a column remap — which rebuilds
  // csvInfo — does not re-parse, and a replaced sheet can never be read against stale rows.
  const csvText = csvInfo?.text ?? null;
  const csvRecords = React.useMemo(() => (csvText ? parseCSV(csvText).records : []), [csvText]);
  const promptColumns = React.useMemo(() => csvInfo?.promptColumns ?? [], [csvInfo]);

  /**
   * What one image is actually sent with: the AI-edit prompt, plus the picked cells of the CSV
   * row it came from. Assembled by the same rule Generate uses (lib/row-prompt.ts), so a column
   * reads the same way in both products.
   *
   * Pictures added as files or pastes have no row, and a row that has been through an AI edit
   * still has one — the cell stays on the item when its source is swapped — so a second edit
   * quotes the same fields the first one did.
   */
  const rowPromptFor = React.useCallback(
    (item: BgItem, base: string): string => {
      if (!promptColumns.length || !item.csv) return base;
      const record = csvRecords[item.csv.row];
      if (!record) return base;
      return buildRowPrompt(base, promptColumns, record, undefined, AI_ROW_HEADING);
    },
    [csvRecords, promptColumns],
  );

  /** Just the appended block, for the dialog's preview — '' when nothing would be appended. */
  const rowContextFor = React.useCallback(
    (item: BgItem): string => {
      const withRow = rowPromptFor(item, '');
      return withRow.startsWith('---\n') ? withRow.slice(4) : '';
    },
    [rowPromptFor],
  );

  /**
   * A name-column change is a pure rename, so it must never go through replaceCsvItems: that
   * path keys membership off the source kind, and an AI edit has already swapped the source to
   * a file. Those rows kept their old name while a duplicate was minted for them under the new
   * one. Matching on the CSV cell reaches every row — edited, in flight, or untouched — and
   * touches nothing else: no membership change, no reorder, no ids, no cutouts.
   */
  const renameCsvItems = React.useCallback((drafts: BgItemDraft[]) => {
    // Each cell carries the URL it names, because a cell is a position and positions repeat
    // across files: without the check, a row left over from an earlier CSV takes the new file's
    // title for the same row number and the export ships one product's picture under another's.
    const byCell = new Map<string, { name: string; url: string | null }>();
    const nameByUrl = new Map<string, string>();
    for (const draft of drafts) {
      const url = draft.source.kind === 'url' ? draft.source.url : null;
      if (draft.csv) byCell.set(csvCellKey(draft.csv), { name: draft.name, url });
      // Fallback for rows imported before provenance existed (restored projects and older
      // autosaves): first URL wins, matching the old by-URL behaviour for duplicates.
      if (url && !nameByUrl.has(url)) nameByUrl.set(url, draft.name);
    }
    setItems((prev) =>
      prev.map((it) => {
        const url = csvSourceUrl(it);
        const cell = it.csv ? byCell.get(csvCellKey(it.csv)) : undefined;
        const name =
          (cell && cell.url === url ? cell.name : undefined) ??
          (url ? nameByUrl.get(url) : undefined);
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
    // for its CSV cell. Without this the row is minted a second time under a fresh id — a
    // visible duplicate, and one the AI-fix dedupe has never seen, so it can be paid for at
    // Azure all over again. The URL is stored alongside so the claim only suppresses the row it
    // is actually standing in for: a position claimed against one file must not swallow the
    // same-numbered row of the next, which vanished from the queue with nothing said.
    const claimed = new Map<string, string | null>();
    for (const it of kept) if (it.csv) claimed.set(csvCellKey(it.csv), csvSourceUrl(it));

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
      const draftUrl = draft.source.kind === 'url' ? draft.source.url : null;
      // Already on screen as an AI-edited row — minting a second one is the duplicate bug.
      if (cell && claimed.has(cell) && claimed.get(cell) === draftUrl) continue;
      let match = cell ? byCell.get(cell) : undefined;
      // A cell alone does not identify a row: it is a position, and every sheet exported from
      // the same template repeats it. Reusing on a bare cell hit handed the new row the old
      // file's URL and cutout, so a corrected CSV re-dropped over its own queue kept serving
      // the picture the correction was meant to replace.
      if (match && (reused.has(match.id) || csvSourceUrl(match) !== draftUrl)) match = undefined;
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

  // Live sealing. Reads the COMMITTED queue, not the run loop's lagging ref: "have enough clean
  // results accumulated" can only be answered by the array React has actually rendered.
  //
  // A seal claims its cohort and stops there — it deliberately does not open a save dialog,
  // because it fires mid-run with no user gesture behind it and the browser would refuse one.
  // The rail shows the sealed batch with a Download button and the user's click supplies the
  // gesture, while the next batch is already filling behind it.
  React.useEffect(() => {
    if (!running) return;
    const plan = planSeal(items, verdictOf, {
      threshold: sealSize,
      alloc: nextAllocation(items, ledger, openPlans, allocFloorRef.current),
      ledger,
      claimed,
    });
    if (!plan) return;
    openPlan(plan);
    sealedThisRunRef.current = true;
    toast.info(`Batch ${plan.batch} sealed — ${plan.items.length.toLocaleString()} clean images ready to download.`);
  }, [items, verdictOf, running, sealSize, ledger, openPlans, claimed]);

  /**
   * The tail of a run. The threshold caps how big a ZIP gets; it was never meant to decide
   * whether the last images ship at all, and as a gate it stranded every run's remainder — a
   * 14,105-image run finished with 2,829 clean cutouts that no batch would take, leaving one
   * button that would have mixed them back in with the 5,264 still awaiting an AI fix.
   *
   * Only when this run actually sealed something: a queue smaller than one batch is not batching
   * at all, and turning a 40-image run into "Batch 1 · 40 files" would be ceremony where a plain
   * export is the whole story.
   */
  React.useEffect(() => {
    // Edges only. This effect also re-runs on every commit of the queue (verdictOf is rebuilt
    // with the items), so a plain `if (running) reset` cleared the flag again a tick after each
    // seal set it, and the run always ended looking as though it had sealed nothing.
    const was = wasRunningRef.current;
    wasRunningRef.current = running;
    if (running) {
      if (!was) sealedThisRunRef.current = false;
      return;
    }
    if (!was || !sealedThisRunRef.current) return;
    sealedThisRunRef.current = false;
    const plan = planFinalSeal(itemsRef.current, verdictOf, {
      alloc: nextAllocation(itemsRef.current, ledger, openPlans, allocFloorRef.current),
      claimed,
    });
    if (!plan) return;
    openPlan(plan);
    toast.info(
      `Batch ${plan.batch} sealed — the last ${plan.items.length.toLocaleString()} clean images.`,
    );
    // openPlans/claimed are read through the allocation above, which is recomputed on every run
    // edge; listing them would re-fire this the moment it seals its own batch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, verdictOf]);

  // Feeds the once-only unmount snapshot with current values instead of first-render ones.
  React.useEffect(() => {
    sessionRef.current = {
      items,
      sessionName,
      selectedId,
      queueFilter,
      queueSort,
      csvInfo,
      ledger,
      allocFloor: allocFloorRef.current,
      aiAttempted: [...aiAttemptedRef.current],
    };
  });

  // The seal has to reach disk on its own: stamping a batch changes nothing else about a row, so
  // the item records are never rewritten by it, and a crash right after a ZIP was written would
  // bring all of its images back reading as unexported — straight into the next export, a second
  // time, under different numbers.
  const ledgerMirrored = React.useRef(false);
  React.useEffect(() => {
    if (!ledger.length && !ledgerMirrored.current) return;
    ledgerMirrored.current = true;
    autosaveLedger(
      ledger.map((row) => ({
        batch: row.batch,
        ids: batchIdsRef.current.get(row.batch) ?? [],
        exportedAt: row.savedAt,
        fileName: row.fileName ?? '',
      })),
    );
  }, [ledger, autosaveLedger]);

  // Mirrors the sheet into the crash net alongside the items. The ref is what stops a fresh
  // mount from writing a null: that would delete a crashed session's CSV before its restore
  // prompt has even been answered. Only a sheet that existed in THIS session can clear one.
  const csvMirrored = React.useRef(false);
  React.useEffect(() => {
    if (!csvInfo && !csvMirrored.current) return;
    csvMirrored.current = true;
    autosaveCsv(
      csvInfo
        ? {
            fileName: csvInfo.fileName,
            text: csvInfo.text,
            nameColumn: csvInfo.nameColumn,
            imageColumns: csvInfo.imageColumns,
            promptColumns: csvInfo.promptColumns,
          }
        : null,
    );
  }, [csvInfo, autosaveCsv]);

  const handleCsv = React.useCallback(
    ({ fileName, text, imported }: CsvPayload) => {
      seedSessionName(fileName);
      setCsvInfo({
        fileName,
        text,
        headers: imported.headers,
        imageColumns: imported.imageColumns,
        nameColumn: imported.titleColumn,
        // Opt-in, and empty on purpose: the AI-edit prompt ships tuned for packshots, and
        // quietly appending a sheet's worth of SKU codes and links to it would change what
        // every existing user's flagged-image fix sends the moment they drop a CSV.
        promptColumns: [],
        rowCount: imported.rowCount,
      });
      replaceCsvItems(imported.drafts);
      if (!imported.drafts.length) {
        toast.warning(`No image URLs auto-detected in ${fileName} — pick the columns below.`);
      }
    },
    [replaceCsvItems, seedSessionName],
  );

  /** The CSV tile's ✕ — drops the mapping AND the URL rows it imported. AI-edited rows have
      moved to a file source and survive, same population rule replaceCsvItems lives by. */
  const removeCsv = React.useCallback(() => {
    replaceCsvItems([]);
    setCsvInfo(null);
  }, [replaceCsvItems]);

  /** The CSV tile's body click — same parse-and-hand-over path as a drop on the ImageDropzone. */
  const replaceCsv = React.useCallback(
    async (file: File) => {
      let text: string;
      try {
        text = await file.text();
      } catch (e) {
        toast.error(`Could not read ${file.name}: ${errorMessage(e)}`);
        return;
      }
      const imported = draftsFromCsv(text);
      if (!imported.headers.length) {
        toast.error(`${file.name} does not look like a CSV.`);
        return;
      }
      handleCsv({ fileName: file.name, text, imported });
    },
    [handleCsv],
  );

  function updateCsvMapping(next: {
    nameColumn?: string;
    imageColumns?: string[];
    promptColumns?: string[];
  }) {
    if (!csvInfo) return;
    const nameColumn = next.nameColumn ?? csvInfo.nameColumn;
    const imageColumns = next.imageColumns ?? csvInfo.imageColumns;
    const promptColumns = next.promptColumns ?? csvInfo.promptColumns;
    // Prompt columns change nothing about WHICH rows are queued or what they are called, so
    // they take the cheap path out: no re-parse, no rename, no replace.
    if (next.nameColumn === undefined && next.imageColumns === undefined) {
      setCsvInfo({ ...csvInfo, promptColumns });
      return;
    }
    const imported = draftsFromCsv(csvInfo.text, { nameColumn: nameColumn || null, imageColumns });
    setCsvInfo({ ...csvInfo, nameColumn, imageColumns, promptColumns });
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
        // The sheet travels with the queue: without it a reopened project cannot re-derive the
        // column mapping, so the name column can never be changed again.
        csv: csvInfo
          ? {
              fileName: csvInfo.fileName,
              text: csvInfo.text,
              nameColumn: csvInfo.nameColumn,
              imageColumns: csvInfo.imageColumns,
              promptColumns: csvInfo.promptColumns,
            }
          : undefined,
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
              // Same reason as the autosave path: without the cell a later remap falls back to
              // the URL, and rows that share a picture cannot be told apart.
              ...(r.csv ? { csv: r.csv } : null),
              ...(r.originalSourceUrl
                ? { originalSource: { kind: 'url' as const, url: r.originalSourceUrl } }
                : null),
              ...(r.batch !== undefined ? { batch: r.batch } : null),
              ...(r.regions?.length ? { regionReport: r.regions } : null),
              ...(r.removedRegions !== undefined ? { removedRegions: r.removedRegions } : null),
              ...(r.originalInk ? { originalInk: r.originalInk } : null),
              ...(r.components?.length ? { originalComponents: r.components } : null),
              ...(r.verify ? { verify: r.verify } : null),
              // A file written before the evidence was saved cannot be re-judged on anything but
              // its bounding box, so its rows are marked rather than quietly presented as clean.
              ...(restored.qualitySignals || !r.cutout ? null : { qualityUnknown: true }),
            }),
          ),
        ];
      });
      // Same rule as the autosave restore: the file's sheet fills an empty panel, it never
      // replaces the CSV this session is already mapped against.
      if (restored.csv) setCsvInfo((prev) => prev ?? csvInfoFromSheet(restored.csv!));
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
      originalInk: result.originalInk,
      originalComponents: result.originalComponents,
      glass: result.glass,
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
      productOnly,
      glass,
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
        originalInk: produced.originalInk,
        originalComponents: produced.originalComponents,
        bands: produced.bands,
        // A fresh matte invalidates any earlier cross-check — the verdict described a cutout
        // that no longer exists. Cleared here, re-earned by the next verify sweep if the new
        // evidence is still ambiguous.
        verify: undefined,
        // Same reasoning as the cross-check above: the verdict described a picture that no
        // longer exists, so it cannot ride along to a new matte.
        semantic: undefined,
        // This row's evidence is no longer missing: the patch above writes the complete set
        // from a live run. Leaving the mark set would keep the row permanently out of the
        // verify band and out of the clean cohorts, for a file it no longer resembles.
        qualityUnknown: undefined,
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
    // A batch owns the workers; a verify sweep in flight yields immediately. Whatever it had
    // not yet checked stays unverified (verify absent), so the sweep after THIS batch picks
    // those same items up again — nothing is silently dropped.
    verifyAbortRef.current?.abort();
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
    // After the lock releases, never inside it: the sweep wants the same workers the batch
    // was saturating, and a cancelled run should not spend more inference on a queue the
    // user just stopped.
    if (!ctrl.signal.aborted) void runVerifySweep().then(() => runSemanticSweep());
  }

  // Probe the optional semantic sidecar once on mount, and again whenever the pass is switched
  // on, so the UI can say "start Ollama" up front instead of failing once per image.
  React.useEffect(() => {
    let cancelled = false;
    void probeSemanticSidecar().then((ok) => {
      if (!cancelled) setSemanticReady(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [semanticPass]);

  /**
   * Semantic pass over finished cutouts (lib/bg/semantic): asks the local Qwen sidecar whether
   * anything besides the product survived the matte — the defect class the fitted model is
   * structurally blind to, since none of its 33 inputs encode "a bowl".
   *
   * Runs AFTER the verify sweep so the two never contend for the machine, and only over items
   * with no verdict yet; a verdict is cleared whenever a new matte replaces the picture it
   * described, so a redo re-earns it.
   *
   * Sequential on purpose. One vision model is resident in Ollama and the GPU is the
   * bottleneck, so parallel submission buys no throughput and only makes Stop less responsive.
   */
  async function runSemanticSweep() {
    if (!semanticPass || runningRef.current || semanticRef.current) return;
    semanticRef.current = true;
    const ctrl = new AbortController();
    semanticAbortRef.current = ctrl;
    let checked = 0;
    let flagged = 0;
    try {
      // Same one-macrotask wait as the verify sweep, for the same reason: itemsRef lags the
      // commit by one flush, so reading it synchronously drops the batch's last item.
      await new Promise((r) => setTimeout(r, 0));
      if (runningRef.current) return;
      // Re-probe rather than trusting the mount-time answer: Ollama may have been stopped
      // since, and one health call is cheaper than N failing inferences.
      if (!(await probeSemanticSidecar(ctrl.signal))) {
        setSemanticReady(false);
        return;
      }
      setSemanticReady(true);
      // Already-flagged items are skipped for the same reason the verify sweep skips them, and
      // here the reason is stronger: this verdict can only ADD a flag, so on an item the rules
      // or the tree already flagged it cannot change the routing at all — it would be pure
      // inference spent to confirm a decision that is already made. Measured on the 601-row
      // labelled set the tree flags ~71%, so checking only the clean pile is roughly a 3x cut
      // in what the pass costs.
      const targets = itemsRef.current.filter(
        (item) =>
          item.status === 'done' &&
          item.cutout &&
          !item.semantic &&
          assessQuality(item).level === 'ok',
      );
      if (!targets.length) return;
      for (const item of targets) {
        if (ctrl.signal.aborted || runningRef.current) break;
        setProgress({
          pct: (checked / targets.length) * 100,
          text: `Semantic check ${checked + 1} of ${targets.length}…`,
        });
        try {
          const verdict = await askSemantic(item.cutout!, ctrl.signal);
          // null is "no answer" — sidecar stopped mid-sweep, or a reply the route would not
          // strictly parse. Writing a clean verdict there would mark the row checked-and-fine
          // on no evidence, so it stays unanswered and the next sweep retries it.
          if (verdict) {
            patchItem(item.id, { semantic: verdict });
            if (verdict.extra) flagged += 1;
          }
        } catch (e) {
          if (isAbortError(e)) break;
          console.warn(`semantic check skipped for ${item.name}:`, errorMessage(e));
        }
        checked += 1;
      }
      // Same guard as the verify sweep: a pre-empted pass must not write a finished-looking
      // line onto the progress bar the batch that pre-empted it is about to use.
      if (checked > 0 && !ctrl.signal.aborted && !runningRef.current) {
        const done = `Semantic check on ${checked} cutout${checked === 1 ? '' : 's'}`;
        setProgress({
          pct: 100,
          text: flagged
            ? `${done} — ${flagged} flagged for extras.`
            : `${done} — nothing extra found.`,
        });
      }
    } finally {
      semanticRef.current = false;
      semanticAbortRef.current = null;
    }
  }

  /**
   * Second-model cross-check over the ambiguous band (quality.needsVerify): re-runs each
   * item's ORIGINAL through BiRefNet and compares mattes. Disagreement flags the item (and
   * with Auto AI-fix on, routes it to Azure like any other flag); agreement quietly retires
   * the ambiguity. One item at a time on purpose — sequential submission keeps the second
   * model resident in a single pool worker instead of doubling weights across both.
   */
  async function runVerifySweep() {
    if (!verifyPass || runningRef.current) return;
    if (verifyingRef.current) {
      // A previous sweep is still unwinding (its decode takes no signal, so an abort only
      // lands at the next pool call). Remember that a sweep is owed, or this one vanishes.
      verifyPendingRef.current = true;
      return;
    }
    // The lock is taken BEFORE the yield below so a second post-batch call cannot interleave
    // through the await; every exit from here on goes through the finally.
    verifyingRef.current = true;
    setVerifying(true);
    const ctrl = new AbortController();
    verifyAbortRef.current = ctrl;
    let checked = 0;
    let disagreements = 0;
    try {
      // itemsRef lags the commit by one flush (see its declaration) and this runs
      // synchronously after the batch lock releases — the LAST item's evidence has not
      // reached the ref yet, so reading it now silently drops that item from the sweep. One
      // macrotask puts the read after React's commit and the ref-sync effect. (Found live: a
      // fixture measured survival 0.71 — squarely in the verify band — and the sweep never
      // saw it.)
      await new Promise((r) => setTimeout(r, 0));
      if (runningRef.current) return;
      // Already-flagged items are excluded HERE, not in needsVerify: a flag routes to AI-fix
      // regardless of what a second model thinks, so the inference buys no routing change —
      // but needsVerify itself stays a pure ambiguity test so other callers can compose it.
      const targets = itemsRef.current.filter(
        (item) =>
          needsVerify(item) && canRetry(item) && assessQuality(item).level === 'ok',
      );
      if (!targets.length) return;
      for (const item of targets) {
        // A batch starting mid-sweep aborts ctrl; re-check both anyway — abort() and the
        // runningRef flip are separate writes and this loop must lose every race.
        if (ctrl.signal.aborted || runningRef.current) break;
        setProgress({
          pct: (checked / targets.length) * 100,
          text: `Verifying ${checked + 1} of ${targets.length} uncertain cutout${targets.length === 1 ? '' : 's'} (${BG_MODELS[VERIFY_MODEL_ID].label})…`,
        });
        let original: HTMLImageElement | null = null;
        const cutout = item.cutout;
        if (!cutout) continue;
        try {
          original = await decodeOriginal(item);
          const shared = {
            model: VERIFY_MODEL_ID,
            // The check compares SHAPES at 512px — refinement sharpens edges that comparison
            // cannot see, at extra cost.
            refine: false,
            // Deliberately UNFILTERED, whatever the page's current switch says. The filter is
            // a second heuristic on top of the matte, and running it here would make the check
            // answer "do the two models plus two filter passes agree?" — a marketing banner
            // that RMBG isolated and the filter correctly dropped comes back fused to the
            // product under BiRefNet's softer matte, and the item gets flagged for a
            // disagreement that is really a filter difference. The primary's own filtered
            // areas are excluded from the comparison instead (see filteredRects).
            productOnly: false,
            signal: ctrl.signal,
            onLoadProgress: setDownload,
          };
          // Poolability follows the CHECKER, not the page's selected model: with the server
          // model picked, usePool is false and this would run BiRefNet uncapped on the main
          // thread, freezing the UI once per item with no Stop to reach.
          const produced: PoolCutout = verifyViaPool
            ? await poolRemoveBackground(original, shared)
            : await toCutout(await removeBackground(original, shared));
          setDownload(null);
          const verify = await compareCutouts(
            cutout.blob,
            produced.blob,
            VERIFY_MODEL_ID,
            filteredRects(item),
          );
          checked++;
          if (!verify.agree) disagreements++;
          // Checked against the CUTOUT, atomically with the write: an undo that lands while
          // BiRefNet works restores the same source object, so a source test would pass while
          // the blob this verdict measured is already gone.
          patchItemIfCutout(item.id, cutout, { verify });
        } catch (e) {
          if (isAbortError(e)) break;
          // One failed check must not end the sweep — and no toast per miss: verify is a
          // background pass, its silence is the point. The item stays unverified, so the
          // next sweep retries it.
          console.warn(`verify skipped for ${item.name}:`, errorMessage(e));
        } finally {
          if (original) releaseOriginal({ ...item, original });
        }
      }
      // Only when the sweep actually finished on its own terms. A pre-empted one writing
      // "Verified 2 — all agreed" with a full bar lands on the progress line the batch that
      // pre-empted it is about to use, and reads as that batch having finished.
      if (checked > 0 && !ctrl.signal.aborted && !runningRef.current) {
        const done = `Verified ${checked} uncertain cutout${checked === 1 ? '' : 's'}`;
        setProgress({
          pct: 100,
          text: disagreements
            ? `${done} — ${disagreements} disagreement${disagreements === 1 ? '' : 's'} flagged.`
            : `${done} — all agreed.`,
        });
      }
    } finally {
      verifyingRef.current = false;
      setVerifying(false);
      verifyAbortRef.current = null;
      setDownload(null);
      // A sweep that was pre-empted mid-flight left ambiguous items unchecked, and the batch
      // that pre-empted it already ran its own tail call — which found the lock held and did
      // nothing. Without this the queue silently loses that sweep entirely.
      if (verifyPendingRef.current && !runningRef.current) {
        verifyPendingRef.current = false;
        void runVerifySweep();
      }
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

  /**
   * What the original/last-generated toggle may offer for one item. An item that has never been
   * edited has only one picture — `originalSource` is written the first time an edit replaces
   * the source — so there is nothing to choose between and the control stays hidden.
   */
  function aiSourceChoices(item: BgItem) {
    return {
      hasLatest: !!item.originalSource,
      hasOriginal: !!item.originalSource && item.originalSource.kind !== 'archived',
    };
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
    from: PromptSource = 'latest',
  ): Promise<BgItem | null> {
    patchItem(item.id, { status: 'editing', error: undefined });
    try {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      // 'original' reaches past every edit already applied to the picture this item was
      // imported with, so a second instruction corrects the import instead of compounding on a
      // first edit that went wrong. Resolved per item: a selection can offer both while an
      // individual row has only ever been through one, and an archived original has no pixels
      // to reference, so both fall back to what the item is carrying now.
      const chosen = resolvePromptSource(from, aiSourceChoices(item));
      const src = chosen === 'original' ? (item.originalSource ?? item.source) : item.source;
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
            // Assembled per item, not per batch: the prompt is shared, the row is not. A batch
            // that built one string up front would send the first flagged image's fields with
            // every other image in the wave.
            prompt: rowPromptFor(item, prompt),
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
        // Undo restores the pre-edit input AND its cutout in one step — with the evidence
        // that was measured from that cutout, not the AI run's.
        prev: { source: item.source, cutout: item.cutout, ...cutoutEvidence(item) },
        // Write-once: a second edit finds this already set and keeps the imported image rather
        // than promoting the first AI output to "the original". `prev` holds one step only, so
        // without this nothing in the item still pointed at the CSV picture after two edits.
        originalSource: item.originalSource ?? item.source,
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
  async function handleAiEdit(item: BgItem, promptOverride?: string, from: PromptSource = 'latest') {
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
        from,
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

  async function handleAiEditSelected(promptOverride: string, from: PromptSource) {
    // Archived sources have no pixels to re-reference; skip them like the per-item edit does.
    const targets = itemsRef.current.filter((it) => gridSel.checked.has(it.id) && canRetry(it));
    gridSel.clear();
    await aiEditMany(targets, promptOverride, from);
  }

  /** `promptOverride` is the selection's one-off wording from the batch dialog. */
  async function aiEditMany(targets: BgItem[], promptOverride?: string, from: PromptSource = 'latest') {
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
        const updated = await aiEditOne(
          item,
          promptOverride?.trim() || guards.prompt,
          guards.mock,
          controller.signal,
          from,
        );
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
      prev: { source: item.source, cutout: item.cutout, ...cutoutEvidence(item) },
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
      // The evidence comes back with the cutout it was measured from. Restoring the picture
      // and leaving the replacement run's numbers behind is how a good cutout ends up wearing
      // a bad one's flags — and how a cross-check verdict for a discarded matte would keep
      // the restored one out of the verify band forever. Explicit undefined clears them when
      // the snapshot has none (an item redone before this shipped).
      removedRegions: item.prev.removedRegions,
      regionReport: item.prev.regionReport,
      originalInk: item.prev.originalInk,
      originalComponents: item.prev.originalComponents,
      verify: item.prev.verify,
      semantic: item.prev.semantic,
      bands: item.prev.bands,
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
      prev: { source: it.source, cutout: it.cutout, ...cutoutEvidence(it) },
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
    // The whole-run reset takes the CSV mapping with it — a "cleared" queue that still showed
    // a loaded sheet and its column pickers read as a bug, and the next run's images would
    // inherit a mapping meant for rows that no longer exist. (Compose and Generate's clearAll
    // already work this way.)
    setCsvInfo(null);
    setSelectedId(null);
    setCompareId(null);
    gridSel.clear();
  }

  function handleCancel() {
    abortRef.current?.abort();
    aiAbortRef.current?.abort();
    verifyAbortRef.current?.abort();
    // from_pretrained takes no signal, so a download in flight runs to completion and the abort
    // only lands at the next checkpoint. Say so, or a 452 MB fetch looks like a hung button.
    if (stage === 'loading') {
      toast.info('Cancelling — the model download has to finish first.');
    }
  }

  // Loading starts on choosing, not on a second click. The picker already stated the cost
  // (size is in every option), and the old flow made "chose a model" and "can use it" two
  // separate acts — so the first run of a batch was the thing that discovered the weights had
  // never been fetched. Server models are skipped: their weights live in the sidecar.
  //
  // The ref, not `warming`, is the re-entrancy guard: state has not committed yet when a
  // remount or a fast second change re-enters, and two warms of one model race the cache.
  const autoWarmedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (spec.server || modelReady || busy) return;
    if (autoWarmedRef.current === modelId) return;
    autoWarmedRef.current = modelId;
    void handleWarm();
    // handleWarm closes over the current model and is redeclared every render; the ref above is
    // what makes re-firing a no-op, so it is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, modelReady, busy, spec.server]);

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
      // Let the button offer a retry: without this the auto-warm would never fire again for
      // this model and the only affordance would be switching away and back.
      autoWarmedRef.current = null;
    } finally {
      setDownload(null);
      setWarming(false);
    }
  }

  // ---- Export: render, optionally compress, zip ---------------------------

  /** The next unused batch number and file range, counting every plan still open. */
  function allocate(): Allocation {
    return nextAllocation(itemsRef.current, ledger, openPlans, allocFloorRef.current);
  }

  /** Reserves a plan's numbers immediately — an allocated range is spent whatever happens next. */
  function openPlan(plan: ExportPlan) {
    setOpenPlans((prev) => [...prev, plan]);
    allocFloorRef.current = {
      batch: Math.max(allocFloorRef.current.batch, plan.batch + 1),
      offset: Math.max(allocFloorRef.current.offset, plan.offset + plan.items.length),
    };
  }

  /**
   * Writes one plan out and records it ONLY if the file actually reached disk. The order is the
   * whole safety property: a stamp is what removes an image from every future cohort, so
   * stamping a batch whose save failed would drop those pictures out of the remaining work with
   * no ZIP anywhere containing them. A failed plan stays open, keeps its claim and keeps its
   * chip, so the same Download button retries it under the same numbers.
   */
  async function runPlan(plan: ExportPlan, opts: { reexport?: boolean } = {}) {
    if (exportingBatch !== null) return;
    setExportingBatch(plan.batch);
    try {
      const saved = await exportItems(plan.items, {
        suffix: `batch-${String(plan.batch).padStart(2, '0')}`,
        offset: plan.offset,
      });
      if (!saved) return;
      setItems((prev) => stampBatch(prev, plan));
      batchIdsRef.current.set(plan.batch, plan.items.map((it) => it.id));
      const record = recordBatch(plan, { fileName: saved });
      setLedger((prev) =>
        opts.reexport
          ? prev.map((row) => (row.batch === plan.batch ? record : row))
          : [...prev, record],
      );
      setOpenPlans((prev) => prev.filter((p) => p !== plan));
    } finally {
      setExportingBatch(null);
    }
  }

  /** Seals nothing — just hands the current cohort a range and a chip the user can download. */
  function exportCohort(cohort: CutoutItem[]) {
    const plan = planExport(cohort, allocate());
    if (!plan) return;
    openPlan(plan);
    void runPlan(plan);
  }

  /**
   * Renders, optionally compresses and zips one cohort. A batched run calls this per sealed
   * batch rather than once over the whole queue, so everything that used to be implicitly "the
   * queue" is a parameter now: which rows, what the ZIP is called, and where its numbering
   * starts. `offset` is what stops every ZIP from opening with an `01-` file — unzip two of
   * those into one folder and the second overwrites the first.
   */
  async function exportItems(
    ready: CutoutItem[],
    opts: { suffix?: string; offset?: number; dest?: SaveDestination } = {},
  ) {
    // Exports serialize against each other and wait for a model warm-up, but NOT for a run: a
    // batch that sealed mid-run has to be able to write itself out while the workers keep going,
    // which is the whole point of sealing early. The whole-queue button stays disabled by `busy`
    // in the footer, so only a deliberate per-batch export takes this path. The encode side is
    // bounded (a fixed number of lanes, each one image at a time) and reports on its own
    // progress line, so it does not fight the run for either memory or the status bar.
    if (!ready.length || exporting || warming) return;
    // Per-item now: each file renders by its own effective tile fit. Only the ZIP's name still
    // needs an overall shape — all-tiles / all-cutouts keep their old names, a mix says so.
    const tileCount = ready.filter((it) => effectiveTileFit(it)).length;
    const shape = tileCount === ready.length ? 'tiles' : tileCount === 0 ? 'cutouts' : 'mixed';
    const suffix = opts.suffix ? `-${opts.suffix}` : '';
    // The save dialog opens now, while the click still counts as user activation — after
    // minutes of encoding Chrome would refuse it. Cancelling the dialog cancels the export.
    const zipName = sessionSlug
      ? `${sessionSlug}-${shape === 'mixed' ? 'export' : shape}${suffix}.zip`
      : shape === 'tiles'
        ? `safe-area-tiles${suffix}.zip`
        : shape === 'cutouts'
          ? `bg-cutouts${suffix}.zip`
          : `zigma-export${suffix}.zip`;
    // A destination handed in was already chosen — an auto-saving run picked its folder once,
    // at a click, and must not ask again per batch.
    const dest = opts.dest ?? (await pickSave(zipName));
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
        { numbered: numberFiles, offset: opts.offset ?? 0 },
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
      return zipName;
    } catch (e) {
      toast.error(`Export failed: ${errorMessage(e)}`);
    } finally {
      setExporting(false);
    }
    return undefined;
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

        {csvInfo && (
          <PanelSection title="CSV">
          <div className="space-y-4">
            {/* The loaded sheet as the suite's file card (same shape as the prompt tiles):
                click to replace, ✕ to remove. Removal takes the imported URL rows with it —
                cutouts among them included — so it confirms first. */}
            <CsvFileTile
              name={csvInfo.fileName}
              description={csvInfo.headers.join(', ')}
              badge={
                csvInfo.rowCount !== undefined
                  ? `${csvInfo.rowCount.toLocaleString()} row${csvInfo.rowCount === 1 ? '' : 's'}`
                  : 'CSV'
              }
              onReplace={(file) => void replaceCsv(file)}
              onRemove={removeCsv}
              disabled={busy}
              removeConfirm={{
                title: 'Remove the CSV?',
                description: (
                  <>
                    Removes the column mapping and every image imported from{' '}
                    {csvInfo.fileName}, including finished cutouts that haven&rsquo;t been
                    exported. Images added as files stay. Your CSV on disk is untouched — drop
                    it again to rebuild the rows.
                  </>
                ),
              }}
            />
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
              <FieldLabel htmlFor="csv-img-cols">
                <Hint hint="Every http(s) URL in these columns becomes its own queue item. Changing them re-imports the CSV's rows; images added as files or pastes are untouched.">
                  Image URL columns
                </Hint>
              </FieldLabel>
              <ColumnPicker
                id="csv-img-cols"
                columns={csvInfo.headers}
                selected={csvInfo.imageColumns}
                onChange={(next) => updateCsvMapping({ imageColumns: next })}
                disabled={busy}
                placeholder="None — no rows will be imported"
              />
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
  // What the wand will actually touch — the dialog counts these, not the raw selection.
  const aiSelectedCount = items.filter((it) => gridSel.checked.has(it.id) && canRetry(it)).length;
  /** Of those, the ones that HAVE an earlier import to go back to — what the toggle needs. */
  const aiEditedSelectedCount = items.filter(
    (it) => gridSel.checked.has(it.id) && canRetry(it) && aiSourceChoices(it).hasOriginal,
  ).length;
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
              section title. The per-image override note lives in the editor dialog. No
              `badge`: the tile shows the active skill's own tag, or "Edited" when the text
              matches no skill. A chip reading "Skill" only repeated the section it sits in. */}
          <MdFileTile
            name={activeAiSkill?.name ?? 'ai-edit-prompt.md'}
            text={aiPrompt}
            onClick={() => setPromptEditorOpen(true)}
            disabled={busy}
            skills={{ list: skills, activeId: aiSkillId, onSelect: (sk) => setAiPrompt(sk.content) }}
          />
          {csvInfo && (
            <Field>
              <FieldLabel htmlFor="bg-ai-prompt-cols">
                <Hint hint="Each picked cell is appended to the prompt as `header: value`, so the model is told what the picture shows instead of inferring it from pixels. Blank cells are skipped, and images that didn't come from the CSV are sent with the prompt alone.">
                  Send CSV columns
                </Hint>
              </FieldLabel>
              <ColumnPicker
                id="bg-ai-prompt-cols"
                columns={csvInfo.headers}
                selected={promptColumns}
                onChange={(next) => updateCsvMapping({ promptColumns: next })}
                disabled={busy}
                placeholder="None — the prompt goes out alone"
              />
            </Field>
          )}
          <Field orientation="horizontal">
            <FieldLabel htmlFor="bg-ai-focus-crop" className="font-normal">
              <Hint hint="Crops the reference to the main product before sending it to the model, so bowls, props and scattered pieces can't be copied back into the result. Falls back to the full image when there's nothing to crop away.">
                Focus on main subject
              </Hint>
            </FieldLabel>
            <Switch
              id="bg-ai-focus-crop"
              checked={aiFocusCrop}
              disabled={busy}
              onCheckedChange={(checked) => setAiFocusCrop(checked === true)}
            />
          </Field>
          {/* The action lives with the prompt and the skill it will actually send, rather than
              floating in the grid toolbar between a filter and a sort control where its cost —
              one paid Azure call per flagged image — read like another view toggle. Disabled
              rather than hidden at zero flagged: a button that vanishes teaches nothing. */}
          <Field orientation="horizontal" className="items-center justify-between">
            <Button
              size="sm"
              variant="outline"
              // `running` is deliberately absent: flagged images can start their Azure phase
              // while the rest of the batch is still removing; only their re-removal waits for
              // the workers to free up.
              disabled={aiFixing || exporting || warming || !aiReady || !flaggedItems.length}
              title={
                !aiReady
                  ? 'AI edit needs the Azure endpoint + key (Settings, gear in the rail)'
                  : !flaggedItems.length
                    ? 'Nothing is flagged that the AI fix can re-run.'
                    : 'Regenerate every flagged image with the prompt above, then re-remove their backgrounds (after the current batch, if one is running).'
              }
              onClick={() => void handleAiEditFlagged()}
            >
              {aiFixing ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <WandSparklesIcon data-icon="inline-start" />
              )}
              Fix flagged ({flaggedItems.length.toLocaleString()})
            </Button>
            <label
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              title="Keep watching the queue and send every newly flagged image to the AI edit automatically — each image is sent at most once."
            >
              <Switch checked={autoAiFix} onCheckedChange={setAutoAiFix} disabled={!aiReady} />
              Auto
            </label>
            <label
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              title={`After each batch, re-check cutouts with ambiguous evidence against ${BG_MODELS[VERIFY_MODEL_ID].label} and flag the ones the two models disagree on. Local and free — only the uncertain few are checked.`}
            >
              <Switch checked={verifyPass} onCheckedChange={setVerifyPass} />
              Verify
            </label>
            <label
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              title={
                semanticReady
                  ? 'After each batch, ask the local vision model whether anything survived besides the product — props, stands, spilled contents, stray banners. Local and free; a few seconds per image.'
                  : 'Needs the local vision sidecar. Start it with: ollama serve (and ollama pull qwen2.5vl:7b)'
              }
            >
              <Switch
                checked={semanticPass}
                onCheckedChange={setSemanticPass}
                disabled={semanticReady === false}
              />
              Semantic
            </label>
          </Field>
        </FieldGroup>
      </PanelSection>
  );

  // The list itself; the footer frames it. Renders nothing until there is something to show,
  // so a small queue never pays for the block.
  const batchList =
    batchRows.length || running || restCohort.length ? (
      <BatchList
        batches={batchRows}
        selected={selectedBatch}
        onSelect={setSelectedBatch}
        onDownload={(batch: number) => {
          const open = openPlans.find((p) => p.batch === batch);
          if (open) return void runPlan(open);
          const row = ledger.find((r) => r.batch === batch);
          const redo = row && planReexport(itemsRef.current, row);
          if (redo) void runPlan(redo, { reexport: true });
        }}
        downloadingBatch={exportingBatch}
        downloadDisabled={exporting}
        running={running}
        // At rest the same row stops being a progress readout and becomes an action: clean work
        // that no batch took — a run stopped early, or one whose tail predates this behaviour —
        // would otherwise only be shippable mixed in with the flagged pile.
        filling={
          running || cleanCohort.length
            ? { clean: cleanCohort.length, threshold: Math.max(1, sealSize), idle: !running }
            : null
        }
        onExportClean={() => exportCohort(cleanCohort)}
        exportingClean={exportingBatch !== null}
        // Shown for context only — the footer's primary button is the one that ships it, so the
        // same action does not appear twice a few pixels apart.
        tail={
          restCohort.length
            ? {
                count: restCohort.length,
                // The flagged share is what is left once the clean and the unjudgeable are
                // accounted for; deriving it keeps the three numbers adding up to the count.
                flagged: restCohort.length - cleanCohort.length - unverifiedCohort.length,
                unverified: unverifiedCohort.length,
              }
            : null
        }
      />
    ) : null;

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
      {(running || aiFixing || verifying) && (
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

  // A sealed batch already owns part of the queue even before its ZIP exists, so the plain
  // "Export ZIP" label would promise the whole queue while shipping only what is left.
  const batched = ledger.length > 0 || openPlans.length > 0;

  const exportFooter = (
    <div className="space-y-2">
      {/* Batches sit with the export CTAs, not up in the settings: a batch ZIP is rendered with
          whatever tile fit, background and compression are live when Download is pressed, so it
          belongs downstream of the controls that decide its contents, not above them.
          Height-capped with its own scroll because this footer does not scroll — a 14,000-image
          run seals 28 batches, and an unbounded list would squeeze the settings above it out of
          the panel entirely. */}
      {batchList && (
        <div className="-mx-1 max-h-52 overflow-y-auto px-1 pb-2">{batchList}</div>
      )}
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
        {/* One export action, and its label says what it will actually ship. It exports the
            rows no batch has taken yet — never the whole queue — because once anything has been
            exported, "everything with a cutout" would put images that are already inside a
            downloaded ZIP into a second one under different numbers, and re-stamp them into a
            batch they were never part of. With nothing exported yet the two sets are identical,
            so the plain case is unchanged. */}
        <Button
          disabled={busy || !restCohort.length}
          onClick={() => exportCohort(restCohort)}
          title={
            batched
              ? 'Everything no batch has taken yet, including images you have since fixed.'
              : 'Every finished cutout in the queue, as PNGs in one ZIP.'
          }
        >
          {exporting ? <Spinner data-icon="inline-start" /> : <DownloadIcon data-icon="inline-start" />}
          {batched ? `Export remaining (${restCohort.length.toLocaleString()})` : 'Export ZIP'}
        </Button>
      </div>
    </div>
  );

  // The empty canvas IS the dropzone. Drop and paste were already bound to the window, so this
  // moves the affordance to where the eye goes rather than changing how a file gets in.
  const emptyState = (
    <ImageDropzone
      size="canvas"
      onAdd={handleAdd}
      onCsv={handleCsv}
      onProject={(file) => void handleProject(file)}
      itemCount={items.length}
      disabled={busy}
    />
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
              <PanelSection
                title="Model"
                hint="Weights download once, then stay cached. Choosing a model starts loading it."
                action={
                  // The section heading IS this control's label, so the select sits on the
                  // heading's row rather than under a second "Model" label repeating it.
                  <Select
                    value={modelId}
                    onValueChange={(value) => setModelId(value as BgModelId)}
                    disabled={busy}
                  >
                    <SelectTrigger id="bg-model" aria-label="Model" className="h-8 w-44">
                      <SelectValue>
                        {(value) => (
                          <span className="flex min-w-0 items-center gap-1.5">
                            {/* The dot is the state at a glance; the words after it are for
                                when a glance is not enough, and truncate first. */}
                            <span
                              aria-hidden
                              className={cn(
                                'size-1.5 shrink-0 rounded-full',
                                modelReady
                                  ? 'bg-emerald-500'
                                  : warming
                                    ? 'animate-pulse bg-amber-500'
                                    : 'bg-muted-foreground/40',
                              )}
                            />
                            <span className="truncate">
                              {BG_MODELS[value as BgModelId]?.label ?? 'Choose a model'}
                            </span>
                            <span className="shrink truncate text-muted-foreground">
                              {modelReady
                                ? backendLabel || 'ready'
                                : warming
                                  ? 'loading'
                                  : spec.approxSizeMb
                                    ? `${spec.approxSizeMb} MB`
                                    : ''}
                            </span>
                          </span>
                        )}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent align="end">
                      {BG_MODEL_ORDER.map((id) => {
                        const option = BG_MODELS[id];
                        const offline = option.server === true && serverUp !== true;
                        return (
                          <SelectItem key={id} value={id} disabled={offline}>
                            <span className="flex min-w-0 flex-col gap-0.5 py-0.5">
                              <span>
                                {option.label}
                                {/* Loaded weights cost nothing to switch to; unloaded ones cost
                                    their download. Saying which is which here is what stops a
                                    452 MB choice from being a surprise. */}
                                {loadedModels.includes(id) || isModelLoaded(id)
                                  ? ' · loaded'
                                  : option.approxSizeMb
                                    ? ` · ${option.approxSizeMb} MB`
                                    : ''}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {offline ? 'Local sidecar is not running' : option.description}
                              </span>
                            </span>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                }
              >
                  <FieldGroup className="gap-4">
                    {serverBlocked && (
                      <FieldDescription>
                        {`${BG_MODELS[knownModel].label} needs its local sidecar — using ${spec.label} until it answers.`}
                      </FieldDescription>
                    )}

                    {/* Settings rows: the label takes the row and the control sits at the end,
                        so the whole section scans down one edge. Switches rather than
                        checkboxes — each of these takes effect on the next run rather than
                        being submitted, which is what a switch means and a checkbox does not. */}
                    <Field orientation="horizontal">
                      <FieldLabel htmlFor="bg-refine" className="font-normal">
                        <Hint hint="Slower, but much better on hair, fur and soft edges.">
                          Refine edges
                        </Hint>
                      </FieldLabel>
                      <Switch
                        id="bg-refine"
                        checked={refine}
                        disabled={busy}
                        onCheckedChange={(checked) => setRefine(checked === true)}
                      />
                    </Field>

                    {/* Belongs here, not with the AI edit: this runs on EVERY removal and
                        changes the exported cutout. (The AI card's "Focus on main subject" only
                        crops the reference sent to Azure and leaves the cutout alone — it reads
                        this option's region analysis, which is the whole of their relationship.) */}
                    <Field orientation="horizontal">
                      <FieldLabel htmlFor="bg-glass" className="font-normal">
                        <Hint hint="For clear plastic, glass and blister packs: rebuilds see-through areas the matte cut as a soft alpha instead of a hole, and strips the studio white out of their colour. Needs a plain, even background.">
                          Keep transparency
                        </Hint>
                      </FieldLabel>
                      <Switch
                        id="bg-glass"
                        checked={glass}
                        disabled={busy}
                        onCheckedChange={(checked) => setGlass(checked === true)}
                      />
                    </Field>

                    <Field orientation="horizontal">
                      <FieldLabel htmlFor="bg-product-only" className="font-normal">
                        <Hint hint="Drops flat colour strips and badges the model kept, and re-measures the subject without them. Only affects graphics detached from the product.">
                          Product only
                        </Hint>
                      </FieldLabel>
                      <Switch
                        id="bg-product-only"
                        checked={productOnly}
                        disabled={busy}
                        onCheckedChange={(checked) => setProductOnly(checked === true)}
                      />
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
                          <ColorPicker
                            aria-label="Custom output background"
                            showValue={false}
                            className="h-7"
                            value={outputBg}
                            onChange={setOutputBg}
                          />
                        )}
                      </div>
                    </Field>

                    {/* Only when loading did not happen on its own — a retry after a failed
                        fetch, or while a run is holding it off. Ready state is the badge's job,
                        so a permanently disabled "Model loaded" button was a row of chrome
                        restating it. */}
                    {!spec.server && !modelReady && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-fit"
                        disabled={busy}
                        onClick={() => void handleWarm()}
                      >
                        {warming ? (
                          <Spinner data-icon="inline-start" />
                        ) : (
                          <CloudDownloadIcon data-icon="inline-start" />
                        )}
                        {warming
                          ? 'Loading…'
                          : `Load${spec.approxSizeMb ? ` · ${spec.approxSizeMb} MB` : ''}`}
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
                  {/* One row: what the grid is showing on the left, how much of it on the
                      right. The filter and sort controls used to be nine identically-shaped
                      pills spread over three rows, where nothing but the label said which of
                      them changed the order and which changed the contents. */}
                  <CanvasToolbar>
                    <QueueFilters
                      filter={queueFilter}
                      onFilterChange={changeQueueFilter}
                      counts={filterCounts}
                      sort={queueSort}
                      onSortChange={setQueueSort}
                    />
                    <div className="flex items-center gap-2">
                      {/* The only thing the window-level drop and paste cannot offer: a click
                          that opens the file picker. */}
                      <ImageDropzone
                        size="button"
                        onAdd={handleAdd}
                        onCsv={handleCsv}
                        onProject={(file) => void handleProject(file)}
                        itemCount={items.length}
                        disabled={busy}
                      />
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {gridSel.active
                          ? `${gridSel.checked.size.toLocaleString()} of ${displayItems.length.toLocaleString()} selected`
                          : displayItems.length === items.length
                            ? `${items.length.toLocaleString()} image${items.length === 1 ? '' : 's'}`
                            : `${displayItems.length.toLocaleString()} of ${items.length.toLocaleString()}`}
                      </span>
                      <ClearAllButton
                        title="Clear the queue?"
                        disabled={busy}
                        onConfirm={clearAllItems}
                        description={
                          <>
                            Removes all {items.length.toLocaleString()} image
                            {items.length === 1 ? '' : 's'}, including finished cutouts that
                            haven&rsquo;t been exported{csvInfo ? ', and unloads the CSV' : ''}.
                            Your source files on disk are untouched.
                          </>
                        }
                      />
                    </div>
                  </CanvasToolbar>
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
                          onRun: () => setAiBatchOpen(true),
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
      <BatchPromptDialog
        open={aiBatchOpen}
        onOpenChange={setAiBatchOpen}
        defaultPrompt={aiPrompt}
        count={aiSelectedCount}
        noun="image"
        busy={aiFixing || exporting || warming}
        excludedNote={(() => {
          const skipped = gridSel.checked.size - aiSelectedCount;
          return skipped > 0
            ? `${skipped} selected image${skipped === 1 ? ' has' : 's have'} no source left to re-reference and ${skipped === 1 ? 'is' : 'are'} left out.`
            : undefined;
        })()}
        source={{
          // Same two words the compare dialog's image panes use. This control used to say
          // "Last AI result" / "Imported image" for the exact pair the panes above call
          // "AI edit" / "Original" — one screen, two vocabularies for two pictures.
          latestLabel: 'AI edit',
          originalLabel: 'Original',
          // Offered as soon as ANY selected image has an earlier import to go back to; the
          // rest resolve to their only picture at send time rather than being skipped.
          hasLatest: aiEditedSelectedCount > 0,
          hasOriginal: aiEditedSelectedCount > 0,
          note:
            aiEditedSelectedCount === aiSelectedCount
              ? 'Images that have never been AI-edited send the picture they came in with either way.'
              : `${aiEditedSelectedCount} of ${aiSelectedCount} have been AI-edited before; the rest send the picture they came in with either way.`,
        }}
        onRun={(p, from) => void handleAiEditSelected(p, from)}
      />

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
          // The dialog edits the prompt; the row block is appended by the page. Passing it down
          // is what keeps the dialog honest — otherwise the one screen that shows the prompt in
          // full would be showing something other than what gets sent.
          rowContext: compareItem ? rowContextFor(compareItem) : '',
          source: compareItem
            ? {
                latestLabel: 'AI edit',
                originalLabel: 'Original',
                ...aiSourceChoices(compareItem),
                note: 'Original is the picture this row was imported with; AI edit is what the last run produced.',
              }
            : undefined,
          onEdit: (item, prompt, from) => void handleAiEdit(item, prompt, from),
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
        <DialogContent className="sm:max-w-3xl">
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
        {isAiGenerated(item) && (
          <Hint
            hint="Regenerated with the AI edit — the imported image is still available in the details view."
            className="absolute top-2 left-2"
          >
            <SparklesIcon className="size-4 text-primary" />
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

