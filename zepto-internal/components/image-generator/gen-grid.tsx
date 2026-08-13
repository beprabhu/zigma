'use client';

// The Image Generator's queue IS its results grid, same as the other two products. A row shows
// its assembled prompt on a muted card until the generated image replaces it — there is no
// source image to stand in, because rows are text. Clicking a cell opens the prompt beside the
// result, which is the only place the exact string sent to Azure can be read back.

import * as React from 'react';
import { CheckIcon, CopyIcon, DownloadIcon, RefreshCwIcon, Undo2Icon } from 'lucide-react';

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
import { pickSave, saveTo } from '@/lib/bg/batch';
import { genFileStem, type GenItem, type GenStatus } from '@/lib/gen';

/* eslint-disable @next/next/no-img-element */

const STATUS_TEXT: Record<GenStatus, string> = {
  ready: 'ready',
  generating: 'generating…',
  done: '✓ done',
  error: 'error',
};

export function genStatusLine(item: GenItem): { text: string; error: boolean } {
  if (item.status === 'error') return { text: item.errorMsg || 'Failed', error: true };
  if (item.status === 'done' && item.durationMs !== undefined) {
    return { text: `✓ done in ${(item.durationMs / 1000).toFixed(1)} s`, error: false };
  }
  return { text: STATUS_TEXT[item.status], error: false };
}

/** One-click copy with the async-clipboard + execCommand fallback the suite uses everywhere. */
export function CopyButton({ text, title }: { text: string; title: string }) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const field = document.createElement('textarea');
      field.value = text;
      document.body.appendChild(field);
      field.select();
      document.execCommand('copy');
      field.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Button variant="ghost" size="icon-sm" title={title} onClick={copy}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}

const GenCell = React.memo(function GenCell({
  item,
  prompt,
  running,
  checked,
  selectionActive,
  onOpen,
  onRemove,
  onToggleSelect,
}: {
  item: GenItem;
  /** Live preview of what this row would send; the sent prompt wins once it exists. */
  prompt: string;
  running: boolean;
  checked: boolean;
  selectionActive: boolean;
  onOpen: (id: number) => void;
  onRemove: (id: number) => void;
  onToggleSelect: (id: number, shiftKey: boolean) => void;
}) {
  const src = item.image?.src;
  return (
    <ResultCell
      label={item.name}
      status={genStatusLine(item)}
      checked={checked}
      selectionActive={selectionActive}
      onSelect={() => onOpen(item.id)}
      onToggleSelect={(shiftKey) => onToggleSelect(item.id, shiftKey)}
      onRemove={() => onRemove(item.id)}
      removeDisabled={running}
    >
      <div className="relative grid aspect-square place-items-center overflow-hidden rounded-lg border bg-muted/30 p-2">
        {src ? (
          <img src={src} alt="" className="max-h-full max-w-full min-h-0 min-w-0 object-contain" />
        ) : (
          // Text rows have nothing to preview but themselves, so the cell shows the prompt.
          <p className="line-clamp-6 px-1 text-[11px] leading-snug text-muted-foreground">
            {prompt || 'Nothing to send — every column is excluded and the brief is empty.'}
          </p>
        )}
        {item.status === 'generating' && (
          <div className="absolute inset-0 grid place-items-center bg-background/70">
            <Spinner className="size-5 text-primary" />
          </div>
        )}
      </div>
    </ResultCell>
  );
});

export function GenGrid({
  items,
  promptFor,
  running,
  selected,
  onOpen,
  onRemove,
  onToggleSelect,
}: {
  items: GenItem[];
  promptFor: (item: GenItem) => string;
  running: boolean;
  selected: ReadonlySet<number>;
  onOpen: (id: number) => void;
  onRemove: (id: number) => void;
  onToggleSelect: (id: number, shiftKey: boolean) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3.5 md:grid-cols-3 xl:grid-cols-4">
      {items.map((item) => (
        <GenCell
          key={item.id}
          item={item}
          prompt={promptFor(item)}
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
 * Prompt against result. `sentPrompt` is preferred over the live preview so a row generated
 * before the brief was edited still shows what it was actually built from.
 */
export function GenDialog({
  item,
  previewPrompt,
  running,
  onClose,
  onRegenerate,
  onUndo,
}: {
  item: GenItem | null;
  previewPrompt: string;
  running: boolean;
  onClose: () => void;
  onRegenerate: (id: number) => void;
  /** Restores the result the last regenerate replaced. Shown only while item.prev exists. */
  onUndo: (id: number) => void;
}) {
  const [saving, setSaving] = React.useState(false);
  const shown = item?.sentPrompt ?? previewPrompt;
  const stale = !!item?.sentPrompt && item.sentPrompt !== previewPrompt;

  async function handleDownload() {
    if (!item?.image) return;
    const fileName = `${genFileStem(item.name, `row-${item.id + 1}`)}.png`;
    const dest = await pickSave(fileName);
    if (dest === 'cancelled') return;
    setSaving(true);
    try {
      const res = await fetch(item.image.src);
      await saveTo(dest, await res.blob(), fileName);
    } finally {
      setSaving(false);
    }
  }

  const line = item ? genStatusLine(item) : null;
  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85dvh] w-full overflow-x-hidden overflow-y-auto sm:max-w-3xl">
        {item && (
          <>
            <DialogHeader className="min-w-0">
              <DialogTitle className="truncate" title={item.name}>{item.name}</DialogTitle>
              <DialogDescription className={line?.error ? 'text-destructive' : undefined}>
                {line?.text}
              </DialogDescription>
            </DialogHeader>

            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              <div className="min-w-0 space-y-1.5">
                <div className="flex items-center gap-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    {item.sentPrompt ? 'Prompt sent' : 'Prompt to send'}
                  </span>
                  <CopyButton text={shown} title="Copy the full prompt" />
                </div>
                <pre className="max-h-64 min-w-0 overflow-auto rounded-lg bg-muted/40 p-3 text-[11px] leading-snug whitespace-pre-wrap">
                  {shown || 'Nothing to send.'}
                </pre>
                {stale && (
                  <p className="text-[11px] text-muted-foreground">
                    The brief or columns changed since this ran — regenerate to use the current
                    prompt.
                  </p>
                )}
              </div>

              <div className="min-w-0 space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">Generated image</div>
                <div className="grid aspect-square place-items-center overflow-hidden rounded-lg border bg-muted/30 p-2">
                  {item.image ? (
                    <img
                      src={item.image.src}
                      alt=""
                      className="max-h-full max-w-full min-h-0 min-w-0 object-contain"
                    />
                  ) : item.status === 'generating' ? (
                    <Spinner className="size-5 text-primary" />
                  ) : (
                    <span className="text-xs text-muted-foreground">Not generated yet</span>
                  )}
                </div>
              </div>
            </div>

            <DialogFooter className="flex-wrap gap-2">
              <Button
                variant="outline"
                className="mr-auto"
                disabled={running}
                title="Send this row to Azure again"
                onClick={() => onRegenerate(item.id)}
              >
                <RefreshCwIcon data-icon="inline-start" />
                Regenerate
              </Button>
              {item.prev && (
                <Button
                  variant="outline"
                  disabled={running}
                  title="Restore the image the last regenerate replaced"
                  onClick={() => onUndo(item.id)}
                >
                  <Undo2Icon data-icon="inline-start" />
                  Undo
                </Button>
              )}
              <Button disabled={!item.image || saving} onClick={handleDownload}>
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
