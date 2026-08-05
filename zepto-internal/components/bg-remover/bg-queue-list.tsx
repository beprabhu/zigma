'use client';

// BG Remover queue building blocks. The queue itself IS the results grid on the product page —
// there is no separate list any more — so this file holds what the grid's tiles and the
// before/after Dialog are built from: the transparency backdrop, the downscaled preview
// canvases, the original-image element, the status vocabulary, and the CompareDialog.

import * as React from 'react';
import { CheckIcon, CopyIcon, DownloadIcon, RefreshCwIcon, SparklesIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
  type BgCutout,
  type BgItem,
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
  'cancelled': { variant: 'outline', text: 'cancelled' },
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
 * The item's original image: the proxy URL for a remote image (same bytes the engine will see,
 * and same-origin so nothing taints a canvas), the decoded element's own object URL for a local
 * file that a run has already touched, or a temporary object URL for one that has not.
 * src is assigned imperatively so the object URL has a real lifetime to be revoked against.
 *
 * The url branch comes FIRST on purpose: lib/pipeline.ts's loadImageFromUrl revokes its object
 * URL inside onload, so a remote item's `original.src` is a dead blob: URL by the time this runs.
 */
export function SourceImage({ item, className }: { item: BgItem; className?: string }) {
  const ref = React.useRef<HTMLImageElement>(null);
  const { original, source } = item;

  React.useEffect(() => {
    const img = ref.current;
    if (!img) return;
    if (source.kind === 'url') {
      img.src = `/api/fetch-image?url=${encodeURIComponent(source.url)}`;
      return;
    }
    if (original) {
      img.src = original.src;
      return;
    }
    if (source.kind === 'file') {
      const url = URL.createObjectURL(source.file);
      img.src = url;
      return () => URL.revokeObjectURL(url);
    }
  }, [original, source]);

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
 * Why each region survived or was dropped. A heuristic that cannot be inspected cannot be
 * tuned — and these numbers are what a bug report needs to be actionable.
 */
function RegionTable({ regions }: { regions: RegionReport[] }) {
  if (!regions.length) return null;
  const sorted = [...regions].sort((a, b) => b.area - a.area).slice(0, 8);
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="text-xs font-medium">Product-only analysis</div>
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
                <td className={cn('py-1', r.removed ? 'text-destructive' : 'text-muted-foreground')}>
                  {r.removed ? 'removed' : 'kept'}
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

function sourceLabel(item: BgItem): string {
  if (item.source.kind === 'file') return item.source.file.name;
  if (item.source.kind === 'url') return item.source.url;
  return `restored · ${item.source.label}`;
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
  /**
   * Send this image to Azure GPT-Image with the product's default prompt; the result replaces
   * the item's source. Omitted (or ready=false) hides/disables the button.
   */
  aiEdit?: { ready: boolean; hint: string; onEdit: (item: BgItem) => void };
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
  aiEdit?: { ready: boolean; hint: string; onEdit: (item: BgItem) => void };
  busy?: boolean;
}) {
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  // A one-off choice: redoing from here must not rewrite the global model setting. CompareView
  // is keyed by item id, so opening a different image remounts this and the picker resets to the
  // current global model — no effect needed to sync it.
  const [redoModel, setRedoModel] = React.useState<string>(defaultModel ?? models?.[0]?.id ?? '');
  const [redoRefine, setRedoRefine] = React.useState<boolean>(defaultRefine ?? false);

  const sourceUrl = item.source.kind === 'url' ? item.source.url : null;

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
          <DialogDescription className="min-w-0 truncate" title={sourceLabel(item)}>
            {item.durationMs !== undefined
              ? `Cut out in ${formatDuration(item.durationMs)} · ${sourceLabel(item)}`
              : sourceLabel(item)}
          </DialogDescription>
          {sourceUrl && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              title="Copy image URL"
              onClick={() => void handleCopy()}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
              <span className="sr-only">Copy image URL</span>
            </Button>
          )}
        </div>
      </DialogHeader>

      {/* min-w-0 on the grid AND its children: without it a grid item's automatic minimum size
          is its content, so the region table below widens the whole dialog instead of scrolling
          inside its own container. */}
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <figure className="min-w-0 space-y-1.5">
          <figcaption className="text-xs text-muted-foreground">Original</figcaption>
          <div className="grid h-64 place-items-center overflow-hidden rounded-lg border bg-muted/40 p-2">
            <SourceImage item={item} className="max-h-full max-w-full object-contain" />
          </div>
        </figure>
        <figure className="min-w-0 space-y-1.5">
          <figcaption className="text-xs text-muted-foreground">
            Background removed{background === TRANSPARENT ? '' : ` · on ${background}`}
          </figcaption>
          <div
            className="grid h-64 place-items-center overflow-hidden rounded-lg border p-2"
            style={backdropStyle(background)}
          >
            <CutoutImage itemId={item.id} cutout={item.cutout} max={560} className="max-h-full max-w-full" />
          </div>
        </figure>
      </div>

      {item.regionReport && item.regionReport.length > 0 && (
        <RegionTable regions={item.regionReport} />
      )}

      {saveError && <p className="text-xs text-destructive">{saveError}</p>}

      <DialogFooter showCloseButton className="flex-wrap gap-2">
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
        {aiEdit && canRetry(item) && (
          <Button
            variant="outline"
            disabled={busy || !aiEdit.ready || item.status === 'editing'}
            title={aiEdit.hint}
            onClick={() => aiEdit.onEdit(item)}
          >
            {item.status === 'editing' ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <SparklesIcon data-icon="inline-start" />
            )}
            AI edit
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
