'use client';

// The compositor's queue IS this grid — there is no separate row list. Every CSV row appears
// as a cell the moment it lands: its source product image first, replaced in place by the
// rendered tile once generation finishes, with the row's status underneath and a delete
// control on hover. Clicking a cell opens the compare dialog: source images against the
// generated tile, copy-URL per source, regenerate and download.

import * as React from 'react';
import { CheckIcon, CopyIcon, DownloadIcon, RefreshCwIcon } from 'lucide-react';

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
import { ResultCell } from '@/components/result-cell';
import { CHECKERBOARD } from '@/components/bg-remover/bg-queue-list';
import { pickSave, saveTo } from '@/lib/bg/batch';
import type { QueueItem, ItemStatus } from '@/lib/types';
import type { TileTemplate } from '@/lib/tile';
import { renderTile, tileToPngBlob } from '@/lib/tile';
import { useTileFontsReady } from '@/hooks/use-tile-fonts';

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

/** Renders the composited tile — shared by the grid cell and the dialog's "after" pane. */
function TileCanvas({
  item,
  template,
  title,
  offerText,
  offerVisible,
  registerCanvas,
  className,
  style,
}: {
  item: QueueItem;
  template: TileTemplate;
  title: string;
  offerText: string;
  offerVisible: boolean;
  registerCanvas?: (id: number, canvas: HTMLCanvasElement | null) => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  const fontsReady = useTileFontsReady();

  React.useEffect(() => {
    if (!registerCanvas) return;
    registerCanvas(item.id, ref.current);
    return () => registerCanvas(item.id, null);
  }, [item.id, registerCanvas]);

  React.useEffect(() => {
    if (!ref.current) return;
    renderTile(ref.current, { title, offerText, offerVisible, image: item.resultImage }, template);
  }, [item.resultImage, template, title, offerText, offerVisible, fontsReady]);

  return <canvas ref={ref} className={className} style={style} />;
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
  registerCanvas,
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
  registerCanvas: (id: number, canvas: HTMLCanvasElement | null) => void;
  onOpen: (item: QueueItem) => void;
  onRemove: (item: QueueItem) => void;
  onToggleSelect: (id: number, shiftKey: boolean) => void;
}) {
  const working =
    item.status === 'fetching' || item.status === 'generating' || item.status === 'removing-bg';
  const r = template.frame;
  return (
    <ResultCell
      label={item.title || `Row ${item.id + 1}`}
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
            item={item}
            template={template}
            title={title}
            offerText={offerText}
            offerVisible={offerVisible}
            registerCanvas={registerCanvas}
            className="block w-full"
            style={{ borderRadius: frameRadius(template) }}
          />
        ) : (
          // The source product stands in until its tile replaces it — a cell is visible from
          // the moment the CSV lands, not only once generation finishes.
          <div className="grid size-full place-items-center overflow-hidden rounded-lg border bg-muted/30 p-2">
            {item.urls.length ? (
              <img
                src={proxied(item.urls[0])}
                loading="lazy"
                alt=""
                className="max-h-full max-w-full min-h-0 min-w-0 object-contain"
              />
            ) : (
              <span className="px-2 text-center text-xs text-muted-foreground">
                No image URLs in this row
              </span>
            )}
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
  registerCanvas: (id: number, canvas: HTMLCanvasElement | null) => void;
  onOpen: (item: QueueItem) => void;
  onRemove: (item: QueueItem) => void;
  onToggleSelect: (id: number, shiftKey: boolean) => void;
}

export function TileGrid({
  items, template, fallbackTitle, fallbackOffer, offerToggle, hasOfferCol,
  running, selected, registerCanvas, onOpen, onRemove, onToggleSelect,
}: TileGridProps) {
  return (
    <div className="grid grid-cols-3 gap-3.5 xl:grid-cols-4">
      {items.map((item) => (
        <TileCell
          key={item.id}
          item={item}
          template={template}
          title={item.title || fallbackTitle}
          offerText={item.offer || fallbackOffer}
          offerVisible={offerToggle && (!!item.offer.trim() || !hasOfferCol)}
          running={running}
          checked={selected.has(item.id)}
          selectionActive={selected.size > 0}
          registerCanvas={registerCanvas}
          onOpen={onOpen}
          onRemove={onRemove}
          onToggleSelect={onToggleSelect}
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
  onClose: () => void;
  onRegenerate: (item: QueueItem) => void;
}

/**
 * Source images against the generated tile — the compositor's version of the BG remover's
 * before/after dialog. Held by id upstream, so the view updates live while a regenerate runs.
 */
export function TileDialog({
  item, template, fallbackTitle, fallbackOffer, offerToggle, hasOfferCol,
  running, onClose, onRegenerate,
}: TileDialogProps) {
  const [saving, setSaving] = React.useState(false);

  async function handleDownload() {
    if (!item?.resultImage) return;
    const fileName = `${(item.title || `row-${item.id + 1}`).replace(/[^\w.-]+/g, '-')}.png`;
    // Dialog first, while the click is fresh — it names the file before it lands.
    const dest = await pickSave(fileName);
    if (dest === 'cancelled') return;
    setSaving(true);
    try {
      const canvas = document.createElement('canvas');
      renderTile(
        canvas,
        {
          title: item.title || fallbackTitle,
          offerText: item.offer || fallbackOffer,
          offerVisible: offerToggle && (!!item.offer.trim() || !hasOfferCol),
          image: item.resultImage,
        },
        template,
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
            <DialogHeader>
              <DialogTitle>{item.title || `Row ${item.id + 1}`}</DialogTitle>
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
                    item={item}
                    template={template}
                    title={item.title || fallbackTitle}
                    offerText={item.offer || fallbackOffer}
                    offerVisible={offerToggle && (!!item.offer.trim() || !hasOfferCol)}
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

            <DialogFooter showCloseButton className="flex-wrap gap-2">
              <Button
                variant="outline"
                className="mr-auto"
                disabled={running || !item.urls.length}
                title="Run this row through Azure again"
                onClick={() => onRegenerate(item)}
              >
                <RefreshCwIcon data-icon="inline-start" />
                Regenerate
              </Button>
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
