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
import { proxiedImageUrl } from '@/lib/pipeline';
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
  references,
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
  /** Image URLs this row will be generated from — empty unless a picked column holds links. */
  references: readonly string[];
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
        ) : references.length ? (
          // What this row will be built FROM. Shown in place of the prompt because it answers the
          // question the prompt cannot: whether the RIGHT product is attached. Getting that wrong
          // is invisible in the text — every row's prompt looks correct while pointing at another
          // row's picture — and only becomes obvious once a few hundred images have been paid for.
          <ReferenceImages urls={references} />
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


/**
 * The pictures a row will be generated FROM, when a picked column holds image links.
 *
 * Pointed straight at the proxy rather than fetched into blobs, so the browser handles caching
 * and `loading="lazy"` keeps a 3,000-row sheet from requesting 3,000 images to show four of them.
 *
 * A reference that will not load renders as nothing rather than as a broken-image glyph, and the
 * cell falls back to its prompt — the run itself reports a bad URL as a row error, which is the
 * right place for it; a preview is not the thing that should be raising the alarm.
 */
function ReferenceImages({ urls, className }: { urls: readonly string[]; className?: string }) {
  const [broken, setBroken] = React.useState<ReadonlySet<string>>(() => new Set());
  const usable = urls.filter((url) => !broken.has(url));
  if (!usable.length) return null;
  return (
    // Absolutely filling a positioned parent, NOT `h-full`: both places this is used centre their
    // child, which leaves that child's height content-based — so `max-h-full` had nothing definite
    // to resolve against and a 500px source rendered at 263px inside an 86px box, cropped rather
    // than fitted. inset-0 gives every image a definite height to be contained within.
    <div className={cn('absolute inset-0 flex items-center justify-center gap-1 p-2', className)}>
      {usable.map((url) => (
        <img
          key={url}
          src={proxiedImageUrl(url)}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setBroken((prev) => new Set(prev).add(url))}
          className="h-full min-h-0 w-full min-w-0 flex-1 object-contain"
        />
      ))}
    </div>
  );
}

export function GenGrid({
  items,
  promptFor,
  referencesFor,
  size,
  running,
  selected,
  onOpen,
  onRemove,
  onToggleSelect,
}: {
  items: GenItem[];
  promptFor: (item: GenItem) => string;
  referencesFor: (item: GenItem) => string[];
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
          references={referencesFor(item)}
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
  defaultPrompt,
  rowContext,
  references,
  size,
  running,
  onClose,
  onRegenerate,
  onUndo,
}: {
  item: GenItem | null;
  /** The BRIEF — the editable half. The row's own block arrives separately as rowContext. */
  defaultPrompt: string;
  /** Read-only row/subject block shown under "Send with the prompt", like Cleanup's CSV. */
  rowContext?: string;
  /** Image URLs sent with this row's prompt — empty unless a picked column holds links. */
  references?: readonly string[];
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
  const refs = references ?? [];
  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      {/* Cleanup's shell, verbatim: a fixed-height flex column — pinned header, one scrolling
          middle, pinned footer — at the same 4xl width, so the two products' dialogs read as
          the same surface. */}
      <DialogContent className="flex max-h-[85dvh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        {item && (
          <>
            <div className="shrink-0 border-b px-5 pt-5 pb-4">
              <DialogHeader className="min-w-0 gap-2">
                <div className="flex min-h-8 min-w-0 items-center gap-2 pr-10">
                  <DialogTitle className="min-w-0 truncate" title={item.name}>{item.name}</DialogTitle>
                  <DialogDescription
                    className={cn('shrink-0 text-xs', line?.error && 'text-destructive')}
                  >
                    {line?.text}
                  </DialogDescription>
                </div>
              </DialogHeader>
            </div>

            <div className="bg-scroll-slim min-h-0 space-y-4 overflow-y-auto px-5 py-4 [scrollbar-gutter:stable]">
              {/* Image LEFT, console right — Cleanup's split. One pane only: a text-to-image row
                  has no "original" picture, so the left column is the result alone at the
                  panel's chosen output shape. */}
              <div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="text-xs text-muted-foreground">Generated image</div>
                  <div className={cn('grid w-full place-items-center overflow-hidden rounded-lg border bg-muted/30 p-2', GEN_ASPECT[size])}>
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
                  {/* Kept visible even once the result exists, which the cell does not do: this is
                      the one screen where the two can be compared, and "did it actually follow the
                      product?" is the question a generated set gets judged on. */}
                  {refs.length > 0 && (
                    <>
                      <div className="mt-1.5 text-xs text-muted-foreground">
                        Reference{refs.length === 1 ? '' : 's'} sent with the prompt
                      </div>
                      <div className="relative h-24 w-full overflow-hidden rounded-lg border bg-muted/30">
                        <ReferenceImages urls={refs} />
                      </div>
                    </>
                  )}
                </div>

                {/* Same trick as Cleanup's AI tab: a relative cell the console fills absolutely,
                    so the prompt scrolls INSIDE the row rather than growing the dialog. min-h is
                    the floor — without it the row is whatever the image happens to be, and a
                    square thumbnail left the textarea pinned at its 115px minimum under the
                    send-with card. The row is now max(image, 24rem), so the modal sizes to
                    content and only scrolls once it hits the dialog's own 85dvh cap. */}
                <div className="relative min-h-[32rem] min-w-0">
                  <div className="absolute inset-0 flex min-h-0 flex-col">
                    {/* Keyed by row: a prompt tweaked for one image never opens on the next.
                        defaultPrompt is the brief alone with the row attached read-only — the
                        split Cleanup's AI edit makes; the page re-joins the two at send time.
                        sentPrompt is deliberately not seeded: it records the assembled string,
                        and seeding it into a brief-only editor would double the row block. */}
                    <RegenPrompt
                      key={item.id}
                      defaultPrompt={defaultPrompt}
                      rowContext={rowContext}
                      busy={running}
                      working={item.status === 'generating'}
                      disabled={false}
                      hint="Send this row to Azure again"
                      source={{
                        latestLabel: 'Generated image',
                        originalLabel: 'Text only',
                        hasLatest: !!item.image,
                        hasOriginal: true,
                        note: 'The image is sent to be edited; text only re-runs the prompt from scratch.',
                      }}
                      actionLabel="Regenerate"
                      copyable={false}
                      collapsible={false}
                      fill
                      onRegenerate={(p, from) => onRegenerate(item.id, p, from)}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* m-0 neutralises DialogFooter's -mx-4 -mb-4 bleed; bg-transparent its muted/50
                fill — one surface with a hairline seam, same as Cleanup's footer. */}
            <DialogFooter className="m-0 shrink-0 flex-wrap items-center gap-2 bg-transparent px-5 py-3">
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
