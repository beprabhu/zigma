'use client';

// The Image Generator's queue IS its results grid, same as the other two products. A row shows
// its assembled prompt on a muted card until the generated image replaces it — there is no
// source image to stand in, because rows are text. Clicking a cell opens the prompt beside the
// result, which is the only place the exact string sent to Azure can be read back.

import * as React from 'react';
import { DownloadIcon, Undo2Icon } from 'lucide-react';

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
import { pickSave, saveTo } from '@/lib/bg/batch';
import { GEN_ASPECT, genFileStem, type GenItem, type GenSize, type GenStatus } from '@/lib/gen';
import { cn } from '@/lib/utils';

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

const GenCell = React.memo(function GenCell({
  item,
  prompt,
  size,
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
  /** The panel's output size — the cell reserves that shape before anything is generated. */
  size: GenSize;
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
      {/* The frame follows the panel's output size, so a landscape run reads as landscape
          cells before a single image exists — and the prompt sitting in an empty cell is
          already occupying the space its image will. Changing the size re-shapes the whole
          grid, including rows already generated: object-contain letterboxes those rather than
          distorting them, which is the visible signal that they came from a different shape. */}
      <div className={cn('relative grid place-items-center overflow-hidden rounded-lg border bg-muted/30 p-2', GEN_ASPECT[size])}>
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
  size,
  running,
  selected,
  onOpen,
  onRemove,
  onToggleSelect,
}: {
  items: GenItem[];
  promptFor: (item: GenItem) => string;
  size: GenSize;
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
          size={size}
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
 * before the brief was edited still shows what it was actually built from — RegenPrompt applies
 * that rule, and the same block appears in Compose's and Cleanup's dialogs.
 */
export function GenDialog({
  item,
  previewPrompt,
  size,
  running,
  onClose,
  onRegenerate,
  onUndo,
}: {
  item: GenItem | null;
  previewPrompt: string;
  size: GenSize;
  running: boolean;
  onClose: () => void;
  onRegenerate: (id: number, promptOverride?: string, from?: PromptSource) => void;
  /** Restores the result the last regenerate replaced. Shown only while item.prev exists. */
  onUndo: (id: number) => void;
}) {
  const [saving, setSaving] = React.useState(false);

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

            {/* There is no "before" image in a text-to-image product, so the result gets the
                middle on its own and the prompt sits under it — the same place Compose and
                Cleanup put theirs. */}
            <div className="mx-auto w-full max-w-sm space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">Generated image</div>
              <div className={cn('grid place-items-center overflow-hidden rounded-lg border bg-muted/30 p-2', GEN_ASPECT[size])}>
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

            {/* Keyed by row: a prompt tweaked for one image never opens on the next. */}
            {/* Generate is the one product where the two sources are not two pictures: this row
                has no input image, only whatever it produced last. So the choice is edit that
                result, or re-run the prompt with no image at all — and the picker hides itself
                on a row that has never generated, where only the second exists. */}
            <RegenPrompt
              key={item.id}
              defaultPrompt={previewPrompt}
              sentPrompt={item.sentPrompt}
              busy={running}
              working={item.status === 'generating'}
              hint="Send this row to Azure again"
              source={{
                latestLabel: 'Generated image',
                originalLabel: 'Text only',
                hasLatest: !!item.image,
                hasOriginal: true,
                note: 'The image is sent to be edited; text only re-runs the prompt from scratch.',
              }}
              onRegenerate={(p, from) => onRegenerate(item.id, p, from)}
            />

            <DialogFooter className="flex-wrap gap-2">
              {item.prev && (
                <Button
                  variant="outline"
                  className="mr-auto"
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
