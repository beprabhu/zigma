'use client';

// BG Remover queue building blocks. The queue itself IS the results grid on the product page —
// there is no separate list any more — so this file holds what the grid's tiles and the
// before/after Dialog are built from: the transparency backdrop, the downscaled preview
// canvases, the original-image element, the status vocabulary, and the CompareDialog.

import * as React from 'react';
import {
  CheckIcon, ChevronRightIcon, CopyIcon, DownloadIcon, ExternalLinkIcon, RefreshCwIcon,
  SparklesIcon, Undo2Icon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { usePreview } from '@/lib/bg/preview-store';
import {
  canRetry,
  canvasToPngBlob,
  decodeCutout,
  pickSave,
  saveTo,
  errorMessage,
  exportFileName,
  flattenOnBackground,
  formatDuration,
  importedSource,
  type BgCutout,
  type BgItem,
  type BgItemSource,
  type BgItemStatus,
} from '@/lib/bg/batch';
import { TRANSPARENT } from '@/lib/bg/safe-area';
import type { RegionReport } from '@/lib/bg/regions';

/* eslint-disable @next/next/no-img-element */

type BadgeVariant = 'secondary' | 'destructive' | 'outline' | 'default';

export const BADGE: Record<BgItemStatus, { variant: BadgeVariant; text: string }> = {
  'ready': { variant: 'secondary', text: 'ready' },
  'loading-model': { variant: 'outline', text: 'loading model…' },
  'removing': { variant: 'outline', text: 'removing…' },
  'editing': { variant: 'outline', text: 'AI editing…' },
  'done': { variant: 'default', text: '✓ done' },
  'error': { variant: 'destructive', text: 'error' },
  'cancelled': { variant: 'outline', text: 'stopped' },
};

/** Transparency backdrop. Uses --muted so it reads correctly in both themes. */
export const CHECKERBOARD: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg, var(--muted) 25%, transparent 25%), linear-gradient(-45deg, var(--muted) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--muted) 75%), linear-gradient(-45deg, transparent 75%, var(--muted) 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
};

/** Backdrop for a cutout shown against `background` ('transparent' = checkerboard). */
export function backdropStyle(background: string): React.CSSProperties {
  return background === TRANSPARENT ? CHECKERBOARD : { background };
}

interface PreviewCanvasProps {
  source: HTMLCanvasElement | HTMLImageElement | ImageBitmap | null;
  /** Longest-edge resolution cap for the copy that gets drawn. */
  max: number;
  className?: string;
}

/**
 * Draws a downscaled copy of a cutout. The full-resolution canvas stays on the item for export;
 * putting it in the DOM directly would mean one 4000px backing store per visible row.
 *
 * No CSS size is set: the backing store IS the intrinsic size, so the caller's `max-w-full` /
 * `max-h-full` scale the element proportionally instead of squashing it. Pass a `max` larger
 * than the box it lands in — the surplus becomes supersampling.
 *
 * `min-h-0 min-w-0` is what makes those max-* rules actually bind. Every preview box in the
 * suite centres its media with `grid place-items-center`, and a grid item's automatic minimum
 * size is its own content — that floor outranks `max-height: 100%`, so a portrait cutout stayed
 * at full height and was silently cropped by the box's `overflow-hidden` instead of scaling to
 * fit. Measured on a 600x1200 source in a 256px-tall pane: 280x560 (clipped) before, 119x238
 * (whole image, true aspect) after. Same rule as the `min-w-0` the dialog grid already carries,
 * one axis over.
 */
/**
 * PreviewCanvas fed by the on-demand preview cache. Nothing holds a decoded bitmap per queue
 * item any more, so every consumer goes through here and gets whatever the cache has (or null
 * while it decodes) rather than owning pixels itself.
 */
export function CutoutImage({
  itemId,
  cutout,
  max,
  className,
}: {
  itemId: number;
  cutout: BgCutout | null;
  max: number;
  className?: string;
}) {
  const preview = usePreview(cutout ? { key: itemId, blob: cutout.blob, edge: max } : null);
  return <PreviewCanvas source={preview} max={max} className={className} />;
}

export function PreviewCanvas({ source, max, className }: PreviewCanvasProps) {
  const ref = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const sw = source ? ('naturalWidth' in source ? source.naturalWidth : source.width) : 0;
    const sh = source ? ('naturalHeight' in source ? source.naturalHeight : source.height) : 0;
    if (!source || !sw || !sh) {
      canvas.width = 0;
      canvas.height = 0;
      return;
    }
    const scale = Math.min(1, max / Math.max(sw, sh));
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  }, [source, max]);

  return <canvas ref={ref} className={cn('block min-h-0 min-w-0', className)} />;
}

/**
 * Draws one BgItemSource and nothing else: the proxy URL for a remote image (same bytes the
 * engine will see, and same-origin so nothing taints a canvas), or a temporary object URL for a
 * local file. src is assigned imperatively so the object URL has a real lifetime to be revoked
 * against.
 *
 * The url branch comes FIRST on purpose: lib/pipeline.ts's loadImageFromUrl revokes its object
 * URL inside onload, so a remote item's decoded element holds a dead blob: URL by the time this
 * runs.
 *
 * `decoded` is an optional shortcut past a second object URL for a file already in memory, and
 * the caller must only pass an element decoded from THIS source. item.original does not qualify
 * once an item has been AI-edited — it then holds the generated bitmap while the import it is
 * being compared against is a different picture entirely, which is precisely how the compare
 * dialog ended up showing the AI output in the pane captioned "Original".
 */
export function RawSourceImage({
  source,
  decoded,
  className,
}: {
  source: BgItemSource;
  decoded?: HTMLImageElement | null;
  className?: string;
}) {
  const ref = React.useRef<HTMLImageElement>(null);

  React.useEffect(() => {
    const img = ref.current;
    if (!img) return;
    if (source.kind === 'url') {
      img.src = `/api/fetch-image?url=${encodeURIComponent(source.url)}`;
      return;
    }
    if (decoded) {
      img.src = decoded.src;
      return;
    }
    if (source.kind === 'file') {
      const url = URL.createObjectURL(source.file);
      img.src = url;
      return () => URL.revokeObjectURL(url);
    }
  }, [decoded, source]);

  // A restored project carries only the cutout — the original was never saved.
  if (source.kind === 'archived') {
    return (
      <span className="px-3 text-center text-xs text-muted-foreground">
        Original not included in the saved project
      </span>
    );
  }
  return <img ref={ref} loading="lazy" alt="" className={cn('min-h-0 min-w-0', className)} />;
}

/**
 * The image an item currently holds — after an AI edit that is the generated file, not the
 * import. Passing item.original is safe here only because it is always the decode of that same
 * current source; anything wanting the import must go through RawSourceImage directly.
 */
export function SourceImage({ item, className }: { item: BgItem; className?: string }) {
  return <RawSourceImage source={item.source} decoded={item.original} className={className} />;
}

/**
 * Why each region survived or was dropped. A heuristic that cannot be inspected cannot be
 * tuned — and these numbers are what a bug report needs to be actionable.
 */
/**
 * Stands in for the cutout that is not there yet. The dialog opens for unfinished rows now, so
 * this pane is legitimately empty across most of the queue's life — and the message has to name
 * the actual state: telling someone to "run Remove backgrounds" while their batch is halfway
 * through removing that very image is advice to do the thing already happening, and the modal
 * covers the tile whose spinner would otherwise have said so.
 */
function EmptyCutout({ status }: { status: BgItemStatus }) {
  const working = status === 'removing' || status === 'loading-model' || status === 'editing';
  const message =
    status === 'error'
      ? 'Background removal failed — Redo below to try again.'
      : status === 'cancelled'
        ? 'Stopped before it finished — Redo to run it again.'
        : status === 'editing'
          ? 'Regenerating this image with the AI edit…'
          : status === 'loading-model'
            ? 'Loading the model…'
            : status === 'removing'
              ? 'Removing the background…'
              : 'No cutout yet — run Remove backgrounds to create one.';
  return (
    <div className="flex max-w-56 flex-col items-center gap-2">
      {working && <Spinner className="size-5 text-primary" />}
      <p className="text-center text-xs text-balance text-muted-foreground">{message}</p>
    </div>
  );
}

function RegionTable({ regions }: { regions: RegionReport[] }) {
  if (!regions.length) return null;
  const sorted = [...regions].sort((a, b) => b.area - a.area).slice(0, 8);
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="text-xs font-medium">Region analysis</div>
      {/* The table has a min width; this scroller is what keeps that from widening the dialog. */}
      <div className="min-w-0 overflow-x-auto">
        <table className="w-full min-w-96 text-left text-[11px] tabular-nums">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-normal">region</th>
              <th className="py-1 pr-3 font-normal">size</th>
              <th className="py-1 pr-3 font-normal" title="Share covered by the 4 most common colours; high = flat artwork">palette</th>
              <th className="py-1 pr-3 font-normal" title="Distinct quantised colours; photos run into the hundreds">colours</th>
              <th className="py-1 pr-3 font-normal" title="Share of its own bounding box that is filled; a rectangle is ~1.0">fill</th>
              <th className="py-1 pr-3 font-normal" title="Mean local pixel variation; near 0 = smooth">detail</th>
              <th className="py-1 font-normal">verdict</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={i} className="border-t">
                <td className="py-1 pr-3 text-muted-foreground">
                  {r.bounds.w}&times;{r.bounds.h}
                </td>
                <td className="py-1 pr-3">{Math.round(r.area / 1000)}k px</td>
                <td className="py-1 pr-3">{(r.paletteCoverage * 100).toFixed(0)}%</td>
                <td className="py-1 pr-3">{r.distinctColors}</td>
                <td className="py-1 pr-3">{r.fillRatio.toFixed(2)}</td>
                <td className="py-1 pr-3">{r.flatness.toFixed(1)}</td>
                <td
                  className={cn(
                    'py-1',
                    r.removed
                      ? 'text-destructive'
                      : r.flagged
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-muted-foreground',
                  )}
                >
                  {r.removed ? 'removed' : r.flagged ? 'kept · graphic?' : 'kept'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sorted.length === 1 && (
        <p className="text-[11px] text-muted-foreground">
          Only one region: the strip is connected to the product in the matte, so no
          region-based filter can separate them.
        </p>
      )}
    </div>
  );
}

/** Product-only is a heuristic, so a tile says when it acted rather than acting silently. */
export function describeRemovedRegions(item: BgItem): string {
  const n = item.removedRegions ?? 0;
  if (!n) return '';
  return ` · ${n} graphic element${n === 1 ? '' : 's'} removed`;
}

function describeSource(source: BgItemSource): string {
  if (source.kind === 'file') return source.file.name;
  if (source.kind === 'url') return source.url;
  return `restored · ${source.label}`;
}

/**
 * Provenance for the line under the dialog title. An AI-edited row shows both halves —
 * "sku-ai-edit.png · from https://…" — because a generated filename answers none of the
 * questions the row gets opened with, and the CSV cell it came from is otherwise unrecoverable.
 */
function sourceLabel(item: BgItem): string {
  const current = describeSource(item.source);
  const imported = importedSource(item);
  return imported ? `${current} · from ${describeSource(imported)}` : current;
}

/**
 * The one-line status a tile shows under its name — the old queue row's badge and info line
 * folded into one string. Errors carry their message so the line is actionable in place.
 */
export function statusLine(item: BgItem): { text: string; error: boolean } {
  if (item.status === 'error') return { text: item.error || 'Failed', error: true };
  if (item.status === 'done' && item.durationMs !== undefined) {
    return { text: `Cut out in ${formatDuration(item.durationMs)}${describeRemovedRegions(item)}`, error: false };
  }
  return { text: BADGE[item.status].text, error: false };
}

export interface CompareDialogProps {
  /** null keeps the dialog closed. */
  item: BgItem | null;
  index: number;
  background: string;
  numbered: boolean;
  onClose: () => void;
  /** Models offered for a one-off redo. Omit to hide the redo controls entirely. */
  models?: CompareModelOption[];
  defaultModel?: string;
  /** Seeds the dialog's refine checkbox from the global setting. */
  defaultRefine?: boolean;
  onRedo?: (item: BgItem, options: CompareRedoOptions) => void;
  /** Restores what the last Redo / AI edit replaced. Shown only while item.prev exists. */
  onUndo?: (item: BgItem) => void;
  /**
   * Send this image to Azure GPT-Image; the result replaces the item's source. The dialog
   * shows `defaultPrompt` in an editable per-image field and hands the (possibly tweaked)
   * text to onEdit — the product's default prompt is never rewritten from here. Omitted
   * (or ready=false) hides/disables the section.
   */
  aiEdit?: {
    ready: boolean;
    hint: string;
    defaultPrompt: string;
    onEdit: (item: BgItem, prompt: string) => void;
  };
  /** A run is in progress; redo stays visible but disabled. */
  busy?: boolean;
}

export interface CompareModelOption {
  id: string;
  label: string;
  disabled?: boolean;
  hint?: string;
}

/** Per-redo settings. Chosen in the dialog and applied to that one image only. */
export interface CompareRedoOptions {
  model: string;
  refine: boolean;
}

/**
 * The before/after view, owned by the page rather than the queue list so both the queue rows and
 * the result grids can open the same dialog.
 */
export function CompareDialog({
  item,
  index,
  background,
  numbered,
  onClose,
  models,
  defaultModel,
  defaultRefine,
  onRedo,
  onUndo,
  aiEdit,
  busy,
}: CompareDialogProps) {
  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85dvh] w-full overflow-x-hidden overflow-y-auto sm:max-w-3xl">
        {item && (
          <CompareView
            key={item.id}
            item={item}
            index={index}
            background={background}
            numbered={numbered}
            models={models}
            defaultModel={defaultModel}
            defaultRefine={defaultRefine}
            onRedo={onRedo}
            onUndo={onUndo}
            aiEdit={aiEdit}
            busy={busy}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CompareView({
  item,
  index,
  background,
  numbered,
  models,
  defaultModel,
  defaultRefine,
  onRedo,
  onUndo,
  aiEdit,
  busy,
}: {
  item: BgItem;
  index: number;
  background: string;
  numbered: boolean;
  models?: CompareModelOption[];
  defaultModel?: string;
  defaultRefine?: boolean;
  onRedo?: (item: BgItem, options: CompareRedoOptions) => void;
  onUndo?: (item: BgItem) => void;
  aiEdit?: {
    ready: boolean;
    hint: string;
    defaultPrompt: string;
    onEdit: (item: BgItem, prompt: string) => void;
  };
  busy?: boolean;
}) {
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  // Per-image prompt, seeded from the product default. CompareView is keyed by item id, so
  // opening another image reseeds it — a tweak made for one image never leaks into the next.
  const [aiPromptDraft, setAiPromptDraft] = React.useState(aiEdit?.defaultPrompt ?? '');
  const promptEdited = aiPromptDraft.trim() !== (aiEdit?.defaultPrompt ?? '').trim();

  // A one-off choice: redoing from here must not rewrite the global model setting. CompareView
  // is keyed by item id, so opening a different image remounts this and the picker resets to the
  // current global model — no effect needed to sync it.
  const [redoModel, setRedoModel] = React.useState<string>(defaultModel ?? models?.[0]?.id ?? '');
  const [redoRefine, setRedoRefine] = React.useState<boolean>(defaultRefine ?? false);

  // The import, when the item is no longer showing it — null for everything untouched by an AI
  // edit, so every "original" affordance below simply disappears on an ordinary row.
  const imported = importedSource(item);
  // Which input the left pane draws. CompareView is keyed by item id, so each image opens on its
  // import rather than inheriting whatever the previous row was left on.
  const [showImported, setShowImported] = React.useState(true);

  // Falls back to the import: an AI edit swaps `source` for a generated File, and the CSV URL
  // then exists nowhere else on the item — which is why Copy URL and Open original vanished from
  // exactly the rows whose provenance someone was trying to check.
  const sourceUrl =
    item.source.kind === 'url'
      ? item.source.url
      : item.originalSource?.kind === 'url'
        ? item.originalSource.url
        : null;
  const urlFromImport = sourceUrl !== null && item.source.kind !== 'url';

  async function handleCopy() {
    if (!sourceUrl) return;
    // The async Clipboard API rejects outside a secure/focused context, so fall back to the
    // execCommand path rather than leaving the user with an error and no copy.
    try {
      await navigator.clipboard.writeText(sourceUrl);
    } catch {
      const field = document.createElement('textarea');
      field.value = sourceUrl;
      field.setAttribute('readonly', '');
      field.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(field);
      field.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      field.remove();
      if (!ok) {
        setSaveError('Could not copy the URL — select it from the title bar instead.');
        return;
      }
    }
    setSaveError(null);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  async function handleDownload() {
    if (!item.cutout) return;
    // Dialog first, while the click is fresh — it names the file before it lands.
    const fileName = exportFileName(item.name, index, { numbered });
    const dest = await pickSave(fileName);
    if (dest === 'cancelled') return;
    setSaving(true);
    setSaveError(null);
    try {
      // Decode the compressed master so a single download is full resolution, not the preview.
      const full = await decodeCutout(item.cutout);
      try {
        const blob = await canvasToPngBlob(flattenOnBackground(full, background));
        await saveTo(dest, blob, fileName);
      } finally {
        full.close();
      }
    } catch (e) {
      setSaveError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DialogHeader className="min-w-0">
        <DialogTitle className="truncate">{item.name || `Image ${index + 1}`}</DialogTitle>
        <div className="flex min-w-0 items-center gap-1.5">
          <DialogDescription
            className={cn('min-w-0 truncate', item.status === 'error' && item.error && 'text-destructive')}
            title={item.status === 'error' && item.error ? item.error : sourceLabel(item)}
          >
            {item.status === 'error' && item.error
              ? item.error
              : item.durationMs !== undefined
                ? `Cut out in ${formatDuration(item.durationMs)} · ${sourceLabel(item)}`
                : sourceLabel(item)}
          </DialogDescription>
          {sourceUrl && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              title={urlFromImport ? 'Copy the imported image URL' : 'Copy image URL'}
              onClick={() => void handleCopy()}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
              <span className="sr-only">Copy image URL</span>
            </Button>
          )}
          {sourceUrl && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              title={
                urlFromImport
                  ? 'Open the imported image URL in a new tab — this row now holds an AI edit'
                  : 'Open the original image URL in a new tab'
              }
              nativeButton={false}
              render={<a href={sourceUrl} target="_blank" rel="noreferrer" />}
            >
              <ExternalLinkIcon />
              <span className="sr-only">Open original image</span>
            </Button>
          )}
        </div>
      </DialogHeader>

      {/* min-w-0 on the grid AND its children: without it a grid item's automatic minimum size
          is its content, so the region table below widens the whole dialog instead of scrolling
          inside its own container. */}
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <figure className="min-w-0 space-y-1.5">
          {/* min-h-7 on both captions so the toggle appearing over one pane does not push its
              image box out of line with the other's. */}
          <figcaption className="flex min-h-7 min-w-0 items-center text-xs text-muted-foreground">
            {imported ? (
              // An AI-edited row has three images and this dialog has two columns. A third
              // column at sm:max-w-3xl leaves each image ~200px wide, which is under the size
              // where the edge quality anyone opens this for is still visible — so the two
              // inputs share the left pane and swap instead of shrinking.
              //
              // It opens on the import: that is what the caption has always promised, it is the
              // only copy of it left once `prev` is spent, and the AI input is one click away
              // for anyone checking what the removal actually ran on.
              <ToggleGroup
                size="sm"
                variant="outline"
                value={[showImported ? 'import' : 'current']}
                // An empty array is the user re-pressing the active segment; ignoring it keeps
                // the pane from going blank on a click that meant nothing.
                onValueChange={(next) => next[0] && setShowImported(next[0] === 'import')}
              >
                <ToggleGroupItem value="import" title="The image this row was imported with">
                  Original
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="current"
                  title="The image the background removal is running on"
                >
                  {item.source.kind === 'file' && item.source.regenerated ? 'AI edit' : 'Current'}
                </ToggleGroupItem>
              </ToggleGroup>
            ) : (
              'Original'
            )}
          </figcaption>
          <div className="grid h-64 place-items-center overflow-hidden rounded-lg border bg-muted/40 p-2">
            {imported && showImported ? (
              // Not SourceImage: item.original is the AI edit's decoded output on exactly the
              // rows that reach this branch, and drawing it here is the bug this pane exists
              // to fix.
              <RawSourceImage source={imported} className="max-h-full max-w-full object-contain" />
            ) : (
              <SourceImage item={item} className="max-h-full max-w-full object-contain" />
            )}
          </div>
        </figure>
        <figure className="min-w-0 space-y-1.5">
          <figcaption className="flex min-h-7 min-w-0 items-center text-xs text-muted-foreground">
            Background removed{background === TRANSPARENT ? '' : ` · on ${background}`}
          </figcaption>
          <div
            className={cn(
              'grid h-64 place-items-center overflow-hidden rounded-lg border p-2',
              // The export backdrop is only worth showing under an actual cutout. It is a
              // user-chosen colour, so the empty-state text below would be painted onto it —
              // white-on-white for the default light backdrop viewed in a dark theme, and the
              // mirror of that for a dark custom hex. The pane then reads as blank, which is
              // the exact failure this message exists to prevent.
              !item.cutout && 'bg-muted/40',
            )}
            style={item.cutout ? backdropStyle(background) : undefined}
          >
            {item.cutout ? (
              <CutoutImage itemId={item.id} cutout={item.cutout} max={560} className="max-h-full max-w-full" />
            ) : (
              <EmptyCutout status={item.status} />
            )}
          </div>
        </figure>
      </div>

      {/* Tied to the cutout it measures: the report is never cleared, so an AI edit or a failed
          redo leaves last run's verdicts sitting under a pane that says there is no cutout —
          two contradictory claims about a matte the user can no longer see or download. */}
      {item.cutout && item.regionReport && item.regionReport.length > 0 && (
        <RegionTable regions={item.regionReport} />
      )}

      {aiEdit && canRetry(item) && (
        <Collapsible className="rounded-lg border">
          {/* Chevron rotation: a static rule in base.css keys off Base UI's data-panel-open
              (the JIT variants proved unreliable under the long-lived dev server's scan). */}
          <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium">
            <ChevronRightIcon className="size-4 transition-transform" />
            <SparklesIcon className="size-4 text-primary" />
            AI edit
            <span className="ml-auto text-xs font-normal text-muted-foreground">
              {item.status === 'editing'
                ? 'Regenerating…'
                : promptEdited
                  ? 'Custom prompt'
                  : 'Default prompt'}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-2 border-t p-3">
              <Textarea
                value={aiPromptDraft}
                onChange={(e) => setAiPromptDraft(e.target.value)}
                rows={5}
                disabled={busy || item.status === 'editing'}
                aria-label="Prompt for this image"
                className="text-xs"
              />
              <div className="flex flex-wrap items-center gap-2">
                <p className="mr-auto text-xs text-muted-foreground">
                  Applies to this image only — the default prompt stays unchanged.
                </p>
                {promptEdited && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || item.status === 'editing'}
                    onClick={() => setAiPromptDraft(aiEdit.defaultPrompt)}
                  >
                    Reset
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={busy || !aiEdit.ready || item.status === 'editing' || !aiPromptDraft.trim()}
                  title={aiEdit.hint}
                  onClick={() => aiEdit.onEdit(item, aiPromptDraft)}
                >
                  {item.status === 'editing' ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <SparklesIcon data-icon="inline-start" />
                  )}
                  Regenerate
                </Button>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {saveError && <p className="text-xs text-destructive">{saveError}</p>}

      {/* One close affordance only — DialogContent's top-right X. A second Close button here
          competed with Download PNG for the primary slot. */}
      <DialogFooter className="flex-wrap gap-2">
        {onRedo && models?.length && canRetry(item) ? (
          <div className="mr-auto flex min-w-0 items-center gap-2">
            <Select
              value={redoModel}
              onValueChange={(value) => setRedoModel(String(value ?? ''))}
              disabled={busy}
            >
              <SelectTrigger size="sm" className="w-44" aria-label="Model for this redo">
                <SelectValue>
                  {(value) => models.find((m) => m.id === value)?.label ?? 'Model'}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id} disabled={m.disabled}>
                    <span className="flex flex-col gap-0.5 py-0.5">
                      <span>{m.label}</span>
                      {m.hint && <span className="text-xs text-muted-foreground">{m.hint}</span>}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label className="flex cursor-pointer items-center gap-1.5 text-xs whitespace-nowrap">
              <Checkbox
                checked={redoRefine}
                disabled={busy}
                onCheckedChange={(checked) => setRedoRefine(checked === true)}
              />
              Refine edges
            </label>
            <Button
              variant="outline"
              disabled={busy || !redoModel}
              onClick={() => onRedo(item, { model: redoModel, refine: redoRefine })}
              title="Remove the background again with these settings"
            >
              <RefreshCwIcon data-icon="inline-start" />
              Redo
            </Button>
          </div>
        ) : null}
        {onUndo && item.prev && (
          <Button
            variant="outline"
            disabled={busy}
            title="Restore the image and cutout the last redo or AI edit replaced"
            onClick={() => onUndo(item)}
          >
            <Undo2Icon data-icon="inline-start" />
            Undo
          </Button>
        )}
        <Button disabled={!item.cutout || saving} onClick={handleDownload}>
          {saving ? <Spinner data-icon="inline-start" /> : <DownloadIcon data-icon="inline-start" />}
          Download PNG
        </Button>
      </DialogFooter>
    </>
  );
}
