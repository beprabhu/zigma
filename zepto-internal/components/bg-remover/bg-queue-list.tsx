'use client';

// BG Remover queue building blocks. The queue itself IS the results grid on the product page —
// there is no separate list any more — so this file holds what the grid's tiles and the
// before/after Dialog are built from: the transparency backdrop, the downscaled preview
// canvases, the original-image element, the status vocabulary, and the CompareDialog.

import * as React from 'react';
import {
  CheckIcon, ChevronLeftIcon, ChevronRightIcon, CopyIcon, DownloadIcon, ExternalLinkIcon,
  FlagIcon, ImageIcon, InfoIcon, RefreshCwIcon, SparklesIcon, Undo2Icon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup, ButtonGroupText } from '@/components/ui/button-group';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RegenPrompt, type PromptSource, type PromptSourceOptions } from '@/components/regen-prompt';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import { assessQuality } from '@/lib/bg/quality';
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
                      : r.flagged || r.guarded
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-muted-foreground',
                  )}
                  title={
                    r.guarded
                      ? 'Measured as a graphic panel, but kept: it is large and central, where the filter protects possible second products.'
                      : undefined
                  }
                >
                  {r.removed
                    ? 'removed'
                    : r.guarded
                      ? 'kept · panel, spared'
                      : r.flagged
                        ? 'kept · graphic?'
                        : 'kept'}
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
      {/* A silent top-8 cut reads as "this is all of it". On a badge-heavy shot the removals
          alone fill the table and every leftover speck the matte kept falls off the bottom —
          the exact rows you would want when a cutout has visible debris in it. */}
      {regions.length > sorted.length && (
        <p className="text-[11px] text-muted-foreground">
          {regions.length - sorted.length} smaller region
          {regions.length - sorted.length === 1 ? '' : 's'} not shown (
          {regions.filter((r) => !r.removed).length - sorted.filter((r) => !r.removed).length} kept
          ).
        </p>
      )}
    </div>
  );
}

/**
 * Per-element survival of the ORIGINAL's ink against the pre-filter matte, plus the verify
 * verdict when the sweep ran one. Same contract as the region table above: a heuristic that
 * cannot be inspected cannot be tuned, and these are the numbers threshold work needs.
 */
function ComponentTable({ item }: { item: BgItem }) {
  const components = item.originalComponents ?? [];
  if (!components.length && !item.verify) return null;
  const shown = components.slice(0, 8);
  const hiddenComponents = components.length - shown.length;
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="text-xs font-medium">Original elements</div>
      {shown.length > 0 && (
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full min-w-96 text-left text-[11px] tabular-nums">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-normal">element</th>
                <th className="py-1 pr-3 font-normal" title="Share of the original canvas this element's ink covers">size</th>
                <th className="py-1 pr-3 font-normal" title="Share of the element's pixels the matte kept, before the product-only filter">survival</th>
                <th className="py-1 pr-3 font-normal" title="Frame edges touched (0-4); backgrounds span 2+, a banner reaches 1">edges</th>
                <th className="py-1 pr-3 font-normal" title="Mean colour saturation of the original pixels; a shadow is ~0">chroma</th>
                <th className="py-1 pr-3 font-normal" title="Mean local variation of the original pixels; a shadow is smooth. '—' means too thin to sample, which is NOT the same as smooth">detail</th>
                <th className="py-1 font-normal" title="What the element lost: colour of the dropped pixels, and whether they sat below what survived (a shadow does)">lost</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c, i) => (
                <tr key={i} className="border-t">
                  <td className="py-1 pr-3 text-muted-foreground">
                    {c.bounds.w}&times;{c.bounds.h}
                  </td>
                  <td className="py-1 pr-3">{(c.areaFraction * 100).toFixed(1)}%</td>
                  <td
                    className={cn(
                      'py-1 pr-3',
                      c.survival <= 0.1
                        ? 'text-destructive'
                        : c.survival < 0.9
                          ? 'text-amber-600 dark:text-amber-400'
                          : undefined,
                    )}
                  >
                    {(c.survival * 100).toFixed(0)}%
                  </td>
                  <td className="py-1 pr-3">{c.edgeContact}</td>
                  <td className="py-1 pr-3">{c.chroma.toFixed(0)}</td>
                  <td className="py-1 pr-3">
                    {c.gradSamples > 0 ? c.flatness.toFixed(1) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="py-1 text-muted-foreground">
                    {c.survival >= 0.999
                      ? '—'
                      : `chroma ${c.lostChroma.toFixed(0)}, ${
                          c.lostBelow > 0.01 ? 'below' : c.lostBelow < -0.01 ? 'above' : 'level'
                        }`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {/* Bands run between the two tables above — after survival is measured, before the
          region report — so without this line a masked strip shows as "100% survived" in one
          table and is absent from the other, with nothing saying where it went. */}
      {(item.bands?.length ?? 0) > 0 && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          {item.bands!.length} flat edge strip{item.bands!.length === 1 ? '' : 's'} masked out (
          {item.bands!.map((b) => `${b.width}×${b.height}`).join(', ')}) — removed after the
          matte, so they appear in neither table above.
        </p>
      )}
      {hiddenComponents > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {hiddenComponents} smaller element{hiddenComponents === 1 ? '' : 's'} not shown.
        </p>
      )}
      {item.verify && (
        <p
          className={cn(
            'text-[11px]',
            item.verify.agree ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-400',
          )}
        >
          Cross-check ({item.verify.model}): mask overlap {(item.verify.iou * 100).toFixed(0)}%
          {item.verify.agree
            ? ' — the second model agrees with this cutout.'
            : ` — the models dispute ${(item.verify.disputedFraction * 100).toFixed(0)}% of the frame.`}
        </p>
      )}
      {/* The residue measurement drives a flag but was displayed nowhere — a flagged image
          whose visible tables all look perfect reads as a bug in the flag. 0.1% precision
          because the bar is 1%. */}
      {item.cutout?.residueFraction !== undefined && item.cutout.residueFraction > 0 && (
        <p
          className={cn(
            'text-[11px]',
            item.cutout.residueFraction >= 0.01
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-muted-foreground',
          )}
        >
          Faint residue outside the subject: {(item.cutout.residueFraction * 100).toFixed(1)}% of
          the canvas{item.cutout.residueFraction >= 0.01 ? ' — above the flag bar (1%)' : ''}.
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
 * The same provenance, minus whatever the compare dialog's source button group is already
 * showing. That group carries the URL — shortened, with the full value on its tooltip and both
 * a copy and an open button — so printing the raw URL again beside it puts the exact 120-char
 * string back on screen that the group exists to keep off it.
 *
 * An AI-edited row keeps its generated file name: the group shows the IMPORT it came from, and
 * "which file is this now" is a different question that nothing else on the row answers.
 */
function sourceLabelBeside(item: BgItem, hasSourceButtons: boolean): string {
  if (!hasSourceButtons) return sourceLabel(item);
  return item.source.kind === 'url' ? '' : describeSource(item.source);
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
  aiEdit?: CompareAiEdit;
  /** A run is in progress; redo stays visible but disabled. */
  busy?: boolean;
  /**
   * Step to the previous/next image without closing. Walks the VISIBLE queue order, not the raw
   * one, so a filtered queue ("Show: flagged") turns this dialog into a triage loop. Omitted
   * hides the pager entirely.
   */
  onNavigate?: (delta: 1 | -1) => void;
  /** 1-based position in that same visible order, for the pager's label. */
  position?: { index: number; total: number };
  /** Sets (or clears) the manual flag override on this image. Omit to hide the flag control. */
  onSetFlag?: (item: BgItem, flag: 'flag' | 'clear' | undefined) => void;
}

/**
 * The AI-edit section of the compare dialog. One shape, shared by the dialog and the view it
 * wraps — they render the same block, and two hand-kept copies of its props drifted the moment
 * one of them gained the source toggle.
 */
export interface CompareAiEdit {
  ready: boolean;
  hint: string;
  defaultPrompt: string;
  /** The CSV row block the page appends to whatever is typed above; '' when there is none. */
  rowContext?: string;
  /** Offers "imported image" against "last AI result". Omitted where there is no choice. */
  source?: PromptSourceOptions;
  onEdit: (item: BgItem, prompt: string, source: PromptSource) => void;
}

export interface CompareModelOption {
  id: string;
  label: string;
  disabled?: boolean;
  hint?: string;
}

/** Which method the run console is showing. Re-cut leads: it is the cheaper, likelier fix. */
type FixTab = 'recut' | 'ai';

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
  onNavigate,
  position,
  onSetFlag,
}: CompareDialogProps) {
  // Which console tab is open, held HERE rather than in CompareView: the view is keyed by item
  // id and remounts on every step through the queue, so a tab kept inside it would snap back to
  // the default on Next. Someone paging through prompts wants to stay on AI edit across the whole
  // run. Resets to the default only when the dialog closes and reopens.
  const [fixTab, setFixTab] = React.useState<FixTab>('recut');

  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      {/* Wider than the old 3xl: the body is two columns now — a stacked pair of image panes
          beside the run console — and at 3xl neither column had room to be worth looking at. */}
      {/* A fixed-height flex column: header and footer are pinned, only the middle scrolls.
          gap-0/p-0 hand spacing to the three regions so the pinned edges sit flush against the
          scroll seam. A short tab (AI edit) then shows no scrollbar and no floor of dead space
          under a footer floated up to meet it; a long one (BG removal) scrolls between the
          fixed bars. */}
      <DialogContent className="flex max-h-[85dvh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
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
            onNavigate={onNavigate}
            position={position}
            fixTab={fixTab}
            onFixTabChange={setFixTab}
            onSetFlag={onSetFlag}
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
  onNavigate,
  position,
  fixTab,
  onFixTabChange,
  onSetFlag,
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
  aiEdit?: CompareAiEdit;
  busy?: boolean;
  onNavigate?: (delta: 1 | -1) => void;
  position?: { index: number; total: number };
  fixTab: FixTab;
  onFixTabChange: (tab: FixTab) => void;
  onSetFlag?: (item: BgItem, flag: 'flag' | 'clear' | undefined) => void;
}) {
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  // A one-off choice: redoing from here must not rewrite the global model setting. CompareView
  // is keyed by item id, so opening a different image remounts this and the picker resets to the
  // current global model — no effect needed to sync it.
  const [redoModel, setRedoModel] = React.useState<string>(defaultModel ?? models?.[0]?.id ?? '');
  const [redoRefine, setRedoRefine] = React.useState<boolean>(defaultRefine ?? false);

  // Which methods this row actually offers. Both are gated on canRetry — a row with no source
  // left to send can run neither — and the console hides entirely when neither is available.
  const hasRedo = !!(onRedo && models?.length && canRetry(item));
  const hasAiEdit = !!(aiEdit && canRetry(item));
  // The held tab, corrected for THIS row: an image that offers no re-cut still shows AI edit
  // rather than an empty panel, without disturbing the caller's remembered choice.
  const activeTab: FixTab =
    fixTab === 'recut' && !hasRedo ? 'ai' : fixTab === 'ai' && !hasAiEdit ? 'recut' : fixTab;

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

  // What the line beside the source buttons says: the duration always, plus whatever provenance
  // the button group is NOT already carrying. Joined here so an empty half never leaves a
  // dangling separator dot.
  /**
   * The shape both panes take. A fixed height letterboxed every image inside a 4:3 box and made
   * a portrait bottle and a landscape banner look like the same crop — so the frame follows the
   * picture instead. The CUTOUT's dimensions are the source's: the engine preserves aspect, and
   * it is the one measurement still around after `original` is released.
   *
   * max-height still wins where the two disagree, so a very tall portrait cannot push the run
   * console off screen; object-contain keeps it honest inside the clamped box.
   */
  const sourceAspect =
    item.cutout?.width && item.cutout.height
      ? item.cutout.width / item.cutout.height
      : item.original?.naturalWidth && item.original?.naturalHeight
        ? item.original.naturalWidth / item.original.naturalHeight
        : 1;

  const besideLabel = [
    item.durationMs !== undefined ? `Cut out in ${formatDuration(item.durationMs)}` : '',
    sourceLabelBeside(item, sourceUrl !== null),
  ]
    .filter(Boolean)
    .join(' · ');

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

  /**
   * The identifying tail of a source URL — the file name, shortened in the middle. The full URL
   * is a CDN path nobody reads; what someone checks at a glance is which asset this row came
   * from, and the copy/open buttons beside it carry the whole thing anyway.
   */
  function shortSource(url: string): string {
    let tail = url;
    try {
      const parsed = new URL(url);
      tail = parsed.pathname.split('/').filter(Boolean).pop() || parsed.host;
    } catch {
      tail = url.split('/').filter(Boolean).pop() || url;
    }
    return tail.length > 28 ? `${tail.slice(0, 14)}…${tail.slice(-10)}` : tail;
  }

  /**
   * ← / → step through the queue. Bound on the window because there is nothing sensible to
   * focus first, and scoped by what the key is currently FOR: inside a text field the arrows
   * move the caret, and inside a listbox, menu, tablist or slider they move the selection.
   * Stealing them there would break editing the prompt — the reason this was left out at first.
   */
  React.useEffect(() => {
    if (!onNavigate) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      // instanceof, not a truthy check: a keydown dispatched at the window itself has `window`
      // as its target, which carries none of these members and throws on .closest().
      const el = event.target;
      if (
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.isContentEditable ||
          el.closest('[role="listbox"],[role="menu"],[role="tablist"],[role="slider"],[role="textbox"]'))
      ) {
        return;
      }
      event.preventDefault();
      onNavigate(event.key === 'ArrowLeft' ? -1 : 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onNavigate]);

  /**
   * The two tuning tables. They measure the matte the BG-removal tab produces, so they live in
   * that tab rather than under the whole dialog — where they sat between the console and the
   * footer and got read as a summary of the image instead of of one run.
   *
   * Both keep their tie-to-cutout gate: the report is never cleared, so an AI edit or a failed
   * run would otherwise leave last run's verdicts under a pane that says there is no cutout.
   */
  const diagnostics = item.cutout ? (
    <div className="flex min-w-0 flex-col gap-4">
      {item.regionReport && item.regionReport.length > 0 && (
        <RegionTable regions={item.regionReport} />
      )}
      <ComponentTable item={item} />
    </div>
  ) : null;

  // Paging, lifted out of the header to sit on the control bar beside the views it steps
  // between. ← / → drive the same move (see the key handler above).
  const pager =
    onNavigate && position && position.total > 1 ? (
      <ButtonGroup className="shrink-0">
        <Button
          variant="outline"
          size="icon-sm"
          disabled={position.index <= 1}
          title="Previous image"
          onClick={() => onNavigate(-1)}
        >
          <ChevronLeftIcon />
          <span className="sr-only">Previous image</span>
        </Button>
        <ButtonGroupText className="h-7 rounded-[min(var(--radius-md),12px)] px-2 text-xs font-normal tabular-nums">
          <span aria-live="polite">{position.index} / {position.total}</span>
        </ButtonGroupText>
        <Button
          variant="outline"
          size="icon-sm"
          disabled={position.index >= position.total}
          title="Next image"
          onClick={() => onNavigate(1)}
        >
          <ChevronRightIcon />
          <span className="sr-only">Next image</span>
        </Button>
      </ButtonGroup>
    ) : null;

  // Which image the left pane shows. A fused pair, not two gapped pills — a pair of mutually
  // exclusive views is one control. Only when there is an AI edit to switch to.
  // The quality verdict, brought INTO the dialog — the grid tile's amber flag reasons were
  // never rendered here, so the one screen opened to act on a flag could not show it. Same
  // source as the tile, so the two cannot disagree.
  const verdict = item.cutout ? assessQuality(item) : null;
  const flagged = verdict !== null && verdict.level !== 'ok';
  // Toggle relative to the EFFECTIVE state, not the stored override: pressing F on a
  // heuristically-flagged row should clear it (override 'clear'), and on a clean row flag it.
  // Setting the override back to `undefined` when it would merely restate the computed verdict
  // keeps the item honest — a cleared-then-recomputed row is not pinned to a stale decision.
  const toggleFlag = React.useCallback(() => {
    if (!onSetFlag || !item.cutout) return;
    onSetFlag(item, flagged ? 'clear' : 'flag');
  }, [onSetFlag, item, flagged]);

  React.useEffect(() => {
    if (!onSetFlag) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'f' && event.key !== 'F') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const el = event.target;
      if (
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      toggleFlag();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSetFlag, toggleFlag]);

  const sourceToggle = imported ? (
    <ButtonGroup className="shrink-0">
      <Button
        size="sm"
        variant="outline"
        aria-pressed={showImported}
        className={cn(showImported && 'bg-muted text-foreground')}
        title="The image this row was imported with"
        onClick={() => setShowImported(true)}
      >
        Original
      </Button>
      <Button
        size="sm"
        variant="outline"
        aria-pressed={!showImported}
        className={cn(!showImported && 'bg-muted text-foreground')}
        title="The image the background removal is running on"
        onClick={() => setShowImported(false)}
      >
        {item.source.kind === 'file' && item.source.regenerated ? 'AI edit' : 'Current'}
      </Button>
    </ButtonGroup>
  ) : null;

  return (
    <>
      <div className="shrink-0 border-b px-5 pt-5 pb-4">
      <DialogHeader className="min-w-0 gap-2">
        {/* Title and the file-detail ⓘ on one line; pr-10 keeps a long title clear of the
            close button DialogContent pins absolutely to this corner. The pager moved down to
            the control bar, beside the views it steps between. min-h-8 pins the row to the
            icon-button's height, so a row without the ⓘ is not shorter than one with it. */}
        <div className="flex min-h-8 min-w-0 items-center gap-2 pr-10">
          <DialogTitle className="min-w-0 truncate">{item.name || `Image ${index + 1}`}</DialogTitle>
          {besideLabel && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" />
                }
              >
                <InfoIcon />
                <span className="sr-only">File details</span>
              </TooltipTrigger>
              <TooltipContent className="max-w-80">{besideLabel}</TooltipContent>
            </Tooltip>
          )}
          {/* Flag state, at title level. Amber when the matte tripped a check, a quiet "Clean"
              when it did not — either way the dialog now SAYS whether this cutout is flagged,
              with the reasons on the badge's tooltip. */}
          {verdict && flagged && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Badge
                    variant="chip-warn"
                    className="shrink-0 gap-1 py-0.5"
                    render={onSetFlag ? <button type="button" onClick={toggleFlag} /> : undefined}
                  />
                }
              >
                <FlagIcon className="size-3" />
                Flagged
              </TooltipTrigger>
              <TooltipContent className="max-w-80">
                <ul className="list-disc space-y-0.5 pl-4">
                  {verdict.reasons.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
                {onSetFlag && <p className="mt-1 opacity-70">Press F to unflag.</p>}
              </TooltipContent>
            </Tooltip>
          )}
          {verdict && !flagged && onSetFlag && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Badge
                    variant="chip"
                    className="shrink-0 gap-1 py-0.5"
                    render={<button type="button" onClick={toggleFlag} />}
                  />
                }
              >
                <FlagIcon className="size-3" />
                Clean
              </TooltipTrigger>
              <TooltipContent>Press F to flag this image.</TooltipContent>
            </Tooltip>
          )}
          {verdict && !flagged && !onSetFlag && (
            <span className="shrink-0 text-xs text-muted-foreground">Clean</span>
          )}
        </div>
      </DialogHeader>
      </div>

      {/* The one scroll region. `bg-scroll-slim` keeps its bar out of sight until the pointer is
          over it — nothing to look at while it isn't being used. */}
      <div className="bg-scroll-slim min-h-0 space-y-4 overflow-y-auto px-5 py-4 [scrollbar-gutter:stable]">

      {/* One control bar over the two columns: source toggle, console tabs and paging on a
          single line. It shares the body's grid template so the toggle sits over the left panes
          and the tabs over the console. <Tabs> wraps the bar AND the grid, so the TabsList up
          here and the TabsContent below share one tab context. */}
      <Tabs
        value={activeTab}
        onValueChange={(value) => onFixTabChange(String(value ?? 'recut') as FixTab)}
        className="min-w-0 gap-4"
      >
        <div className="grid min-h-8 min-w-0 items-center gap-4 sm:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <div className="flex min-h-8 min-w-0 items-center">
            {sourceToggle ?? <span className="px-1 text-xs text-muted-foreground">Original</span>}
          </div>
          <div className="flex min-h-8 min-w-0 items-center gap-3">
            {(hasRedo || hasAiEdit) && (
              <TabsList>
                {hasRedo && (
                  <TabsTrigger value="recut">
                    <ImageIcon data-icon="inline-start" />
                    BG removal
                  </TabsTrigger>
                )}
                {hasAiEdit && (
                  <TabsTrigger value="ai">
                    <SparklesIcon data-icon="inline-start" />
                    AI edit
                  </TabsTrigger>
                )}
              </TabsList>
            )}
            <div className="flex-1" />
            {pager}
          </div>
        </div>

      <div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-2">
          <figure className="min-w-0">
            <div
              className="grid max-h-72 w-full place-items-center overflow-hidden rounded-lg border bg-muted/40 p-2"
              style={{ aspectRatio: sourceAspect }}
            >
              {imported && showImported ? (
                <RawSourceImage source={imported} className="max-h-full max-w-full object-contain" />
              ) : (
                <SourceImage item={item} className="max-h-full max-w-full object-contain" />
              )}
            </div>
          </figure>
          <figure className="min-w-0 space-y-1.5">
            <figcaption className="text-xs text-muted-foreground">
              Background removed{background === TRANSPARENT ? '' : ` · on ${background}`}
            </figcaption>
            <div
              className={cn(
                'grid max-h-72 w-full place-items-center overflow-hidden rounded-lg border p-2',
                !item.cutout && 'bg-muted/40',
              )}
              style={{ aspectRatio: sourceAspect, ...(item.cutout ? backdropStyle(background) : null) }}
            >
              {item.cutout ? (
                <CutoutImage itemId={item.id} cutout={item.cutout} max={560} className="max-h-full max-w-full" />
              ) : (
                <EmptyCutout status={item.status} />
              )}
            </div>
          </figure>
        </div>

        {/* The run console body — the tab bar for it lives on the shared control bar above.
            `relative` with no height of its own: the AI-edit tab fills it absolutely so the grid
            row is sized by the image column, and the prompt scrolls WITHIN that height rather
            than growing the dialog. The BG-removal tab flows normally — its tables belong in the
            dialog's own scroll. */}
        <div className="relative min-h-[32rem] min-w-0">
            {hasRedo && (
              <TabsContent value="recut" className="flex min-w-0 flex-col gap-4 data-[state=inactive]:hidden">
                <div className="flex min-w-0 flex-col gap-3 rounded-lg border p-3">
                  <Field>
                    <FieldLabel htmlFor="compare-redo-model">Model</FieldLabel>
                    <Select
                      value={redoModel}
                      onValueChange={(value) => setRedoModel(String(value ?? ''))}
                      disabled={busy}
                    >
                      <SelectTrigger id="compare-redo-model" size="sm" className="w-full">
                        <SelectValue>
                          {(value) => models?.find((m) => m.id === value)?.label ?? 'Model'}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {models?.map((m) => (
                          <SelectItem key={m.id} value={m.id} disabled={m.disabled}>
                            <span className="flex flex-col gap-0.5 py-0.5">
                              <span>{m.label}</span>
                              {m.hint && <span className="text-xs text-muted-foreground">{m.hint}</span>}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <Checkbox
                      checked={redoRefine}
                      disabled={busy}
                      onCheckedChange={(checked) => setRedoRefine(checked === true)}
                    />
                    Refine edges
                  </label>
                  <FieldDescription>
                    Runs background removal on this image again and replaces the cutout. Undo
                    brings the old one back.
                  </FieldDescription>
                  <Button
                    className="self-start"
                    disabled={busy || !redoModel}
                    onClick={() => onRedo?.(item, { model: redoModel, refine: redoRefine })}
                  >
                    <RefreshCwIcon data-icon="inline-start" />
                    Remove again
                  </Button>
                </div>
                {diagnostics && (
                  <div className="flex min-w-0 flex-col gap-4 border-t pt-4">{diagnostics}</div>
                )}
              </TabsContent>
            )}

            {hasAiEdit && aiEdit && (
              <TabsContent value="ai" className="absolute inset-0 flex min-h-0 flex-col data-[state=inactive]:hidden">
                {/* Unchanged inside — the same block Compose and Generate show in their dialogs.
                    Its own title would repeat the tab, so it is dropped here. */}
                <RegenPrompt
                  defaultPrompt={aiEdit.defaultPrompt}
                  rowContext={aiEdit.rowContext}
                  busy={busy}
                  working={item.status === 'editing'}
                  disabled={!aiEdit.ready}
                  hint={aiEdit.hint}
                  source={aiEdit.source}
                  // The tab already says AI edit; the button says the same word rather than
                  // introducing "Regenerate" as a second name for it. Copy is off here — the
                  // prompt is one click from Settings, and the row it took was worth more.
                  actionLabel="AI edit"
                  copyable={false}
                  collapsible={false}
                  fill
                  onRegenerate={(prompt, from) => aiEdit.onEdit(item, prompt, from)}
                />
              </TabsContent>
            )}
            {/* No BG-removal tab to hold them (an archived row can still carry a cutout and its
                report) — so the tables render straight into the console column instead. */}
            {!hasRedo && diagnostics}
        </div>
      </div>
      </Tabs>

      {/* Same tie-to-cutout rule as the tables below: the verdict describes one matte, and it
          is cleared whenever a new one replaces it. */}
      {item.cutout && item.semantic && (
        <p
          className={cn(
            'rounded-md border px-3 py-2 text-xs',
            item.semantic.extra
              ? 'border-destructive/40 bg-destructive/5 text-destructive'
              : 'border-border bg-muted/40 text-muted-foreground',
          )}
        >
          {item.semantic.extra
            ? `Semantic check saw something besides the product${item.semantic.what ? `: ${item.semantic.what}` : ''}`
            : 'Semantic check found nothing besides the product'}
          <span className="ml-1 opacity-60">({item.semantic.model})</span>
        </p>
      )}

      {saveError && <p className="text-xs text-destructive">{saveError}</p>}
      </div>

      {/* One close affordance only — DialogContent's top-right X. The run controls moved into
          the console above, so this row carries only what happens to the cutout that exists. */}
      {/* m-0 kills DialogFooter's own -mx-4 -mb-4 bleed: those were meant for a padded dialog
          and, in this fixed-column layout, pushed the footer 16px past the clipped bottom edge
          (its rounded corners sliced off square). It keeps the base border-t and rounded-b. */}
      {/* bg-transparent kills DialogFooter's own bg-muted/50 fill: the modal reads as ONE
          surface with a hairline seam, not a two-tone panel. m-0 kills its bleed margins. */}
      <DialogFooter className="m-0 shrink-0 flex-wrap items-center gap-2 bg-transparent px-5 py-3">
        {/* Provenance sits with the other things you do to the WHOLE image rather than in the
            header: it is an action pair (copy, open), not a caption, and in the header it made
            the title area two rows tall on every row that had a URL. */}
        {sourceUrl && (
          <ButtonGroup className="mr-auto">
            <ButtonGroupText
              className="h-8 max-w-56 text-xs font-normal"
              title={sourceUrl}
            >
              <span className="truncate">{shortSource(sourceUrl)}</span>
            </ButtonGroupText>
            <Button
              variant="outline"
              size="icon"
              title={urlFromImport ? 'Copy the imported image URL' : 'Copy image URL'}
              onClick={() => void handleCopy()}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
              <span className="sr-only">Copy image URL</span>
            </Button>
            <Button
              variant="outline"
              size="icon"
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
          </ButtonGroup>
        )}
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
