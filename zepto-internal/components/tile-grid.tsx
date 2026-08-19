'use client';

// The compositor's queue IS this grid — there is no separate row list. Every CSV row appears
// as a cell the moment it lands: its source product image first, replaced in place by the
// rendered tile once generation finishes, with the row's status underneath and a delete
// control on hover. Clicking a cell opens the compare dialog: source images against the
// generated tile, copy-URL per source, regenerate and download.

import * as React from 'react';
import { CheckIcon, CopyIcon, DownloadIcon, Undo2Icon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { RegenPrompt, type PromptSource } from '@/components/regen-prompt';
import { ResultCell } from '@/components/result-cell';
import { CHECKERBOARD } from '@/components/bg-remover/bg-queue-list';
import { pickSave, saveTo } from '@/lib/bg/batch';
import type { QueueItem, ItemStatus } from '@/lib/types';
import type { TileTemplate } from '@/lib/tile';
import { renderTile, tileToPngBlob } from '@/lib/tile';
import { useTileFontsReady } from '@/hooks/use-tile-fonts';
import { cn } from '@/lib/utils';

/* eslint-disable @next/next/no-img-element */

function fmtKB(n: number) { return (n / 1024).toFixed(1) + ' KB'; }

const STATUS_TEXT: Record<ItemStatus, string> = {
  'ready': 'ready',
  'no-images': 'no image URLs',
  'fetching': 'fetching…',
  'generating': 'generating…',
  'removing-bg': 'removing bg…',
  'done': '✓ done',
  'error': 'error',
};

/** The old queue row's badge and info line folded into one string, like the BG remover's. */
function statusLine(item: QueueItem): { text: string; error: boolean } {
  if (item.status === 'error') return { text: item.errorMsg || 'Failed', error: true };
  if (item.status === 'no-images') return { text: STATUS_TEXT[item.status], error: true };
  if (item.status === 'done' && item.compressed) {
    return {
      text: `✓ done · ${fmtKB(item.compressed.inputSize)} → ${fmtKB(item.compressed.data.length)}`,
      error: false,
    };
  }
  return { text: STATUS_TEXT[item.status], error: false };
}

function proxied(url: string): string {
  return '/api/fetch-image?url=' + encodeURIComponent(url);
}

/** The batch-wide text a row falls back on when its own cells are blank. */
export interface TileTextRules {
  fallbackTitle: string;
  fallbackOffer: string;
  offerToggle: boolean;
  hasOfferCol: boolean;
}

/**
 * What one row renders as. Stated once and read by the grid cell, the compare dialog and the
 * export — three places that have to agree, since the whole promise of the grid is that the
 * tile you looked at is the tile you get.
 *
 * Note the offer rule: where an offer column IS mapped, a row with a blank cell renders with no
 * bar rather than falling back. The fallback is for sheets with no offer column at all, where one
 * offer applies to every tile.
 */
export function tileOptsFor(item: QueueItem, rules: TileTextRules) {
  return {
    title: item.title || rules.fallbackTitle,
    offerText: item.offer || rules.fallbackOffer,
    offerVisible: rules.offerToggle && (!!item.offer.trim() || !rules.hasOfferCol),
  };
}

/** Renders the composited tile — shared by the grid cell and the dialog's "after" pane. */
function TileCanvas({
  image,
  extraImages,
  template,
  title,
  offerText,
  offerVisible,
  className,
  style,
}: {
  /** null draws the template's own "image" placeholder — the tile minus its picture. */
  image: HTMLImageElement | (HTMLImageElement | null)[] | null;
  /** Sources past the four the image box can hold; drawn as a "+N" chip. */
  extraImages?: number;
  template: TileTemplate;
  title: string;
  offerText: string;
  offerVisible: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  const fontsReady = useTileFontsReady();

  React.useEffect(() => {
    if (!ref.current) return;
    renderTile(ref.current, { title, offerText, offerVisible, image, extraImages }, template);
  }, [image, extraImages, template, title, offerText, offerVisible, fontsReady]);

  return <canvas ref={ref} className={className} style={style} />;
}

/** Cells the image box packs into. A fifth source and beyond are counted in the last one. */
const PREVIEW_CELLS = 4;

/**
 * The cell before its tile exists: the same template drawn around the row's OWN source photos,
 * so a sheet reads as tiles — title, offer bar, frame — from the moment it lands rather than
 * only once Azure has answered. Every image column the row fills is packed into the image box,
 * which makes it the one place that shows what the model is actually being handed for that row.
 * Never registered for export; only a generated tile ships.
 *
 * The <img> elements are what do the fetching. They stay in the layout at zero opacity so
 * `loading="lazy"` still defers a thousand-row sheet to what is actually on screen, and their
 * load events hand the decoded elements to the canvas. Mounted under a `key` of the URLs
 * upstream, so remapping the image columns starts a clean load rather than leaving stale photos.
 */
function SourceTilePreview({
  urls, template, title, offerText, offerVisible, className, style,
}: {
  urls: string[];
  template: TileTemplate;
  title: string;
  offerText: string;
  offerVisible: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  // Four sources fill four cells; more than that and the fourth cell becomes the count, so the
  // three that fit are the ones drawn. Nothing is dropped without saying so.
  const shown = urls.length > PREVIEW_CELLS ? urls.slice(0, PREVIEW_CELLS - 1) : urls;
  // One slot per source, held from the first render: the pack is laid out by slot count, so a
  // photo arriving late drops into a cell that was already reserved for it.
  const [images, setImages] = React.useState<(HTMLImageElement | null)[]>(
    () => shown.map(() => null),
  );
  const mark = (i: number, el: HTMLImageElement) =>
    setImages((prev) => (prev[i] === el ? prev : prev.map((x, n) => (n === i ? el : x))));

  return (
    <>
      <TileCanvas
        image={images}
        extraImages={urls.length - shown.length}
        template={template}
        title={title}
        offerText={offerText}
        offerVisible={offerVisible}
        className={className}
        style={style}
      />
      {shown.map((url, i) => (
        <img
          key={url}
          src={url}
          alt=""
          aria-hidden
          loading="lazy"
          // A photo already in the browser cache can finish before React attaches onLoad, which
          // would leave its cell stuck empty; the ref catches that case on commit.
          ref={(el) => { if (el?.complete && el.naturalWidth) mark(i, el); }}
          onLoad={(e) => mark(i, e.currentTarget)}
          className="pointer-events-none absolute inset-0 size-full opacity-0"
        />
      ))}
    </>
  );
}

/** The frame's own corner radius, so transparent corners don't read as extra space. */
function frameRadius(template: TileTemplate): string {
  const r = template.frame;
  return `${(r.radius / r.width) * 100}% / ${(r.radius / r.height) * 100}%`;
}

function TileCell({
  item,
  template,
  title,
  offerText,
  offerVisible,
  running,
  checked,
  selectionActive,
  onOpen,
  onRemove,
  onToggleSelect,
}: {
  item: QueueItem;
  template: TileTemplate;
  title: string;
  offerText: string;
  offerVisible: boolean;
  running: boolean;
  checked: boolean;
  selectionActive: boolean;
  onOpen: (item: QueueItem) => void;
  onRemove: (item: QueueItem) => void;
  onToggleSelect: (id: number, shiftKey: boolean) => void;
}) {
  const working =
    item.status === 'fetching' || item.status === 'generating' || item.status === 'removing-bg';
  const r = template.frame;
  return (
    <ResultCell
      label={item.title || `Row ${item.row}`}
      status={statusLine(item)}
      checked={checked}
      selectionActive={selectionActive}
      onSelect={() => onOpen(item)}
      onToggleSelect={(shiftKey) => onToggleSelect(item.id, shiftKey)}
      onRemove={() => onRemove(item)}
      removeDisabled={running}
    >
      <div className="relative" style={{ aspectRatio: `${r.width} / ${r.height}` }}>
        {item.resultImage ? (
          // The canvas stays mounted for export even while a regenerate is in flight.
          <TileCanvas
            image={item.resultImage}
            template={template}
            title={title}
            offerText={offerText}
            offerVisible={offerVisible}
            className="block w-full"
            style={{ borderRadius: frameRadius(template) }}
          />
        ) : item.urls.length ? (
          // The source products stand in until the tile replaces them — a cell shows the tile it
          // is going to be from the moment the CSV lands, not only once generation finishes.
          // The ring is the tell that this one is a stand-in: a generated tile has no edge.
          <SourceTilePreview
            key={item.urls.join('|')}
            urls={item.urls.map(proxied)}
            template={template}
            title={title}
            offerText={offerText}
            offerVisible={offerVisible}
            className="block w-full ring-1 ring-border"
            style={{ borderRadius: frameRadius(template) }}
          />
        ) : (
          <div className="grid size-full place-items-center overflow-hidden rounded-lg border bg-muted/30 p-2">
            <span className="px-2 text-center text-xs text-muted-foreground">
              No image URLs in this row
            </span>
          </div>
        )}
        {working && (
          <div className="absolute inset-0 grid place-items-center rounded-lg bg-background/70">
            <Spinner className="size-5 text-primary" />
          </div>
        )}
      </div>
    </ResultCell>
  );
}

interface TileGridProps {
  items: QueueItem[];
  template: TileTemplate;
  fallbackTitle: string;
  fallbackOffer: string;
  offerToggle: boolean;
  hasOfferCol: boolean;
  running: boolean;
  selected: ReadonlySet<number>;
  onOpen: (item: QueueItem) => void;
  onRemove: (item: QueueItem) => void;
  onToggleSelect: (id: number, shiftKey: boolean) => void;
  /**
   * Fixed tiles-per-row, for a Banner grid band whose columns are part of the design. Omitted
   * (the default queue view) keeps the responsive 3/4-up grid.
   */
  columns?: number;
}

export function TileGrid({
  items, template, fallbackTitle, fallbackOffer, offerToggle, hasOfferCol,
  running, selected, onOpen, onRemove, onToggleSelect, columns,
}: TileGridProps) {
  return (
    <div
      className={columns ? 'grid gap-3.5' : 'grid grid-cols-3 gap-3.5 xl:grid-cols-4'}
      style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}
    >
      {items.map((item) => (
        <TileCell
          key={item.id}
          item={item}
          template={template}
          {...tileOptsFor(item, { fallbackTitle, fallbackOffer, offerToggle, hasOfferCol })}
          running={running}
          checked={selected.has(item.id)}
          selectionActive={selected.size > 0}
          onOpen={onOpen}
          onRemove={onRemove}
          onToggleSelect={onToggleSelect}
        />
      ))}
    </div>
  );
}

/**
 * The shape a band is going to take, before anything is in it: one grey tile per slot, in the
 * same grid TileGrid lays out, at the chosen preset's own ratio.
 *
 * An empty dashed box cannot answer the two questions that picking a ratio is FOR — how many
 * tiles this row holds and what shape they are. This does, and because it reuses TileGrid's
 * columns, gap and frame radius, the tiles that arrive land exactly where the grey ones were.
 */
export function TileGridSkeleton({
  template,
  columns,
  count,
  className,
}: {
  template: TileTemplate;
  columns: number;
  count: number;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={cn('grid w-full gap-3.5', className)}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: Math.max(0, count) }, (_, i) => (
        <div
          key={i}
          className="bg-muted-foreground/15"
          style={{
            aspectRatio: `${template.frame.width} / ${template.frame.height}`,
            borderRadius: frameRadius(template),
          }}
        />
      ))}
    </div>
  );
}

/** One-click copy with the same async-clipboard + execCommand fallback the BG remover uses. */
function CopyUrlButton({ url }: { url: string }) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const field = document.createElement('textarea');
      field.value = url;
      document.body.appendChild(field);
      field.select();
      document.execCommand('copy');
      field.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Button variant="ghost" size="icon-sm" title="Copy image URL" onClick={copy}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}

export interface TileDialogProps {
  /** null keeps the dialog closed. */
  item: QueueItem | null;
  template: TileTemplate;
  fallbackTitle: string;
  fallbackOffer: string;
  offerToggle: boolean;
  hasOfferCol: boolean;
  running: boolean;
  /** The composite prompt every row shares — the seed and Reset target for this row's copy. */
  prompt: string;
  /** Export multiplier, so a single Download PNG matches what the ZIP would contain. */
  exportScale: number;
  onClose: () => void;
  onRegenerate: (item: QueueItem, promptOverride?: string, source?: PromptSource) => void;
  /** Restores the tile the last regenerate replaced. Shown only while item.prev exists. */
  onUndo: (item: QueueItem) => void;
}

/**
 * Source images against the generated tile — the compositor's version of the BG remover's
 * before/after dialog. Held by id upstream, so the view updates live while a regenerate runs.
 */
export function TileDialog({
  item, template, fallbackTitle, fallbackOffer, offerToggle, hasOfferCol,
  running, prompt, exportScale, onClose, onRegenerate, onUndo,
}: TileDialogProps) {
  const [saving, setSaving] = React.useState(false);

  async function handleDownload() {
    if (!item?.resultImage) return;
    const fileName = `${(item.title || `row-${item.row}`).replace(/[^\w.-]+/g, '-')}.png`;
    // Dialog first, while the click is fresh — it names the file before it lands.
    const dest = await pickSave(fileName);
    if (dest === 'cancelled') return;
    setSaving(true);
    try {
      const canvas = document.createElement('canvas');
      renderTile(
        canvas,
        {
          ...tileOptsFor(item, { fallbackTitle, fallbackOffer, offerToggle, hasOfferCol }),
          image: item.resultImage,
        },
        template,
        exportScale,
      );
      const blob = await tileToPngBlob(canvas);
      await saveTo(dest, blob, fileName);
    } finally {
      setSaving(false);
    }
  }

  const line = item ? statusLine(item) : null;
  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85dvh] w-full overflow-x-hidden overflow-y-auto sm:max-w-3xl">
        {item && (
          <>
            <DialogHeader className="min-w-0">
              <DialogTitle className="truncate" title={item.title || undefined}>
                {item.title || `Row ${item.row}`}
              </DialogTitle>
              <DialogDescription className={line?.error ? 'text-destructive' : undefined}>
                {line?.text}
                {item.offer ? ` · offer: ${item.offer}` : ''}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="min-w-0 space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">
                  Source image{item.urls.length === 1 ? '' : 's'}
                </div>
                {item.urls.length ? (
                  item.urls.map((url, i) => (
                    <div key={i} className="space-y-1">
                      <div
                        className="grid place-items-center overflow-hidden rounded-lg border p-2"
                        style={CHECKERBOARD}
                      >
                        <img
                          src={proxied(url)}
                          loading="lazy"
                          alt=""
                          className="max-h-56 max-w-full min-h-0 min-w-0 object-contain"
                        />
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={url}>
                          {url}
                        </span>
                        <CopyUrlButton url={url} />
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground">This row has no image URLs.</p>
                )}
              </div>

              <div className="min-w-0 space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">Generated tile</div>
                {item.resultImage ? (
                  <TileCanvas
                    image={item.resultImage}
                    template={template}
                    {...tileOptsFor(item, { fallbackTitle, fallbackOffer, offerToggle, hasOfferCol })}
                    className="block w-full"
                    style={{ borderRadius: frameRadius(template) }}
                  />
                ) : (
                  <div
                    className="grid place-items-center rounded-lg border text-xs text-muted-foreground"
                    style={{ aspectRatio: `${template.frame.width} / ${template.frame.height}` }}
                  >
                    {item.status === 'fetching' || item.status === 'generating' || item.status === 'removing-bg' ? (
                      <Spinner className="size-5 text-primary" />
                    ) : (
                      'Not generated yet'
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Keyed by row: a prompt tweaked for one tile never opens on the next. */}
            <RegenPrompt
              key={item.id}
              defaultPrompt={prompt}
              busy={running}
              working={
                item.status === 'fetching' ||
                item.status === 'generating' ||
                item.status === 'removing-bg'
              }
              disabled={!item.urls.length && !item.resultImage}
              hint={
                item.urls.length || item.resultImage
                  ? 'Run this row through Azure again'
                  : 'This row has no image URLs to send'
              }
              source={{
                latestLabel: 'Generated tile',
                originalLabel: 'Source images',
                hasLatest: !!item.resultImage,
                hasOriginal: item.urls.length > 0,
                note: 'The tile edits what is already there; the source images rebuild it from scratch.',
              }}
              onRegenerate={(p, from) => onRegenerate(item, p, from)}
            />

            <DialogFooter className="flex-wrap gap-2">
              {item.prev && (
                <Button
                  variant="outline"
                  className="mr-auto"
                  disabled={running}
                  title="Restore the tile the last regenerate replaced"
                  onClick={() => onUndo(item)}
                >
                  <Undo2Icon data-icon="inline-start" />
                  Undo
                </Button>
              )}
              <Button disabled={!item.resultImage || saving} onClick={handleDownload}>
                {saving ? <Spinner data-icon="inline-start" /> : <DownloadIcon data-icon="inline-start" />}
                Download PNG
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
