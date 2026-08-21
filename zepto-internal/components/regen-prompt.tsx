'use client';

// The prompt block inside a compare dialog — one implementation for all three products, so
// "what is this row about to be sent?" is answered the same way in Compose, Cleanup and
// Generate rather than three different ways (or, in Compose's case, not at all).
//
// It is editable because a compare dialog is where a single bad result is looked at, and the
// fix for one bad result is almost never a change to the setting every other row shares. The
// draft is per-item and per-opening: mount it under a `key` of the item id so tweaking one row
// can never leak into the next one opened.

import * as React from 'react';
import { RefreshCwIcon, SparklesIcon, ChevronRightIcon, CheckIcon, CopyIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

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

/**
 * Which picture the prompt is sent WITH. A row that has been edited once holds two candidates —
 * what it came in as, and what the last run produced — and the difference decides whether a
 * second instruction compounds on the first or replaces it.
 *
 * 'latest' is the default everywhere: an edit is nearly always a refinement of what was just
 * looked at, and silently re-sending the untouched original would throw away the run the user
 * is standing in front of. 'original' is the escape hatch for when an edit went wrong and the
 * fix is to start over from the source rather than pile a correction on top of a mistake.
 */
export type PromptSource = 'latest' | 'original';

export interface PromptSourceOptions {
  /**
   * What "latest" is called in this product: "Generated tile", "AI edit". Use the product's
   * OWN name for that picture — the one its compare panes already print above the image —
   * never a second synonym coined for this control.
   */
  latestLabel: string;
  /** What "original" is called, under the same rule: "Source images", "Original". */
  originalLabel: string;
  /** There is a generated result to send. False locks the choice to the original. */
  hasLatest: boolean;
  /** The pre-edit source is still reachable. False locks the choice to the latest result. */
  hasOriginal: boolean;
  /** One line under the control saying what each option actually sends. */
  note?: string;
}

/**
 * Resolves a chosen source against what the item actually has. Exported because the pages run
 * the same rule per item inside a batch, where the selection as a whole may offer both but an
 * individual row only has one of them.
 */
export function resolvePromptSource(
  chosen: PromptSource,
  opts: Pick<PromptSourceOptions, 'hasLatest' | 'hasOriginal'>,
): PromptSource {
  if (!opts.hasLatest) return 'original';
  if (!opts.hasOriginal) return 'latest';
  return chosen;
}

function PromptSourcePicker({
  options, value, onChange, disabled,
}: {
  options: PromptSourceOptions;
  value: PromptSource;
  onChange: (value: PromptSource) => void;
  disabled: boolean;
}) {
  // Nothing to choose between — one of the two does not exist for this item, and a control with
  // a single reachable answer is noise. The caller still gets the resolved value.
  if (!options.hasLatest || !options.hasOriginal) return null;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Send with the prompt</span>
        <ToggleGroup
          value={[value]}
          onValueChange={(next) => next[0] && onChange(next[0] as PromptSource)}
          variant="outline"
          size="sm"
          disabled={disabled}
        >
          {/* Original first, then the result derived from it — the same left-to-right order the
              compare panes above put them in. Reading order is part of the vocabulary: a toggle
              that names the same two pictures in the opposite sequence reads as a third pair. */}
          <ToggleGroupItem value="original">{options.originalLabel}</ToggleGroupItem>
          <ToggleGroupItem value="latest">{options.latestLabel}</ToggleGroupItem>
        </ToggleGroup>
      </div>
      {options.note && <p className="text-[11px] text-muted-foreground">{options.note}</p>}
    </div>
  );
}

export interface RegenPromptProps {
  /**
   * What this row would be sent right now, assembled — the seed for an unrun row, and always
   * what Reset returns to. Editing the product's own prompt panel moves this.
   */
  defaultPrompt: string;
  /**
   * What actually went out last time, when the product records it. Preferred as the seed, so a
   * row generated before the prompt was edited shows what it was really built from.
   */
  sentPrompt?: string;
  /**
   * Read-only text the page appends to whatever is typed — the row's CSV cells. Shown but not
   * editable: those cells come from the sheet, and editing them here would edit one send
   * instead of the column mapping that produced them.
   */
  rowContext?: string;
  /** Section label. "AI edit" where the prompt drives an edit rather than the generation. */
  title?: string;
  /** Whole-app busy: a batch is running, so nothing single-row may start. */
  busy?: boolean;
  /** This row is in flight right now — the button becomes its own progress. */
  working?: boolean;
  /** Extra reason the action cannot run (missing credentials, no source image). */
  disabled?: boolean;
  /** Title text for the action, e.g. why it is unavailable. */
  hint?: string;
  /**
   * Offers the original/last-generated choice. Omit in products where the prompt only ever has
   * one picture to travel with — the callback then always receives 'latest'.
   */
  source?: PromptSourceOptions;
  /**
   * The action's own verb. Products that RE-run a generation keep "Regenerate"; where the block
   * is one method among several (Cleanup's console tabs it against BG removal) the button is
   * named for the method instead, so the tab and its button do not use two different words for
   * one act.
   */
  actionLabel?: string;
  /**
   * Copy-the-whole-prompt button. Off where the prompt is already one click from the product's
   * own prompt panel and the row it would occupy is worth more than the shortcut.
   */
  copyable?: boolean;
  /**
   * Whether the block collapses behind its own header. Off where something else already owns
   * the disclosure — Cleanup's console tabs it against BG removal, so the tab IS the toggle and
   * a second one just hides the panel the tab was clicked to show.
   */
  collapsible?: boolean;
  /**
   * Grow to fill the height its container gives it, textarea taking the slack. Non-collapsible
   * case only — it lets the prompt panel match a taller neighbouring column instead of leaving
   * dead space under a fixed-height box.
   */
  fill?: boolean;
  onRegenerate: (prompt: string, source: PromptSource) => void;
}

export function RegenPrompt({
  defaultPrompt,
  sentPrompt,
  rowContext,
  title = 'Prompt',
  busy = false,
  working = false,
  disabled = false,
  hint,
  source,
  actionLabel = 'Regenerate',
  copyable = true,
  collapsible = true,
  fill = false,
  onRegenerate,
}: RegenPromptProps) {
  const seed = sentPrompt ?? defaultPrompt;
  const [draft, setDraft] = React.useState(seed);
  // Last generated by default — see PromptSource. Per-item and per-opening like the draft: the
  // component is mounted under the item's id, so a one-off "from the original" never carries
  // into the next row opened.
  const [pick, setPick] = React.useState<PromptSource>('latest');
  const picked = source ? resolvePromptSource(pick, source) : 'latest';
  const edited = draft.trim() !== defaultPrompt.trim();
  // The row ran on something the current settings no longer produce. Worth saying plainly:
  // otherwise the obvious reading of an unexpected result is that the prompt is being ignored.
  const stale = !!sentPrompt && sentPrompt.trim() !== defaultPrompt.trim();
  const locked = busy || working;

  const content = (
    <div
      className={cn(
        'space-y-2 p-3 pb-0',
        collapsible && 'border-t',
        // overflow-y-auto is the safety valve, not the plan: the panel is a FIXED height and the
        // row block is unbounded (a sheet with twenty columns prints twenty lines). Without it
        // the wrapper's overflow-hidden — there for the rounded corners — cut the overflow
        // through the middle of a line. The floors below are sized so the common case never
        // reaches this.
        fill && 'flex min-h-0 flex-1 flex-col gap-2 space-y-0 overflow-y-auto',
      )}
    >
        {copyable && (
          <div className="flex items-center justify-end">
            <CopyButton
              text={rowContext ? `${draft}\n\n${rowContext}` : draft}
              title="Copy the full prompt"
            />
          </div>
        )}
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={fill ? undefined : 6}
          disabled={locked}
          aria-label={`${title} for this row`}
          className={cn(
            'overflow-y-auto text-xs',
            fill ? 'min-h-48 flex-1 resize-none' : 'max-h-64',
          )}
        />
        {/* One group for everything sent to Azure ALONGSIDE the prompt text: the source-image
            choice and the row's CSV fields. The picker carries the "Send with the prompt"
            heading when there is an image choice to make; otherwise it is stated once above the
            details. The nested radii step in (outer rounded-lg, inner rounded-md) so the two
            read as a card and its content, not two stacked boxes. */}
        {(rowContext || (source && source.hasLatest && source.hasOriginal)) && (
          <div className="shrink-0 space-y-2 rounded-lg border bg-muted/30 p-2.5">
            {source && source.hasLatest && source.hasOriginal ? (
              <PromptSourcePicker
                options={source}
                value={picked}
                onChange={setPick}
                disabled={locked || disabled}
              />
            ) : (
              <span className="text-xs font-medium text-muted-foreground">Send with the prompt</span>
            )}
            {/* Two things keep this from slicing a line in half. leading-4 pins the line box to
                1rem, and max-h-40 minus p-2 leaves exactly 9 of them — left to the font's own
                15.7px, the old 7rem box held 6.43 lines and cut the last through the glyphs.
                8 lines also clears a typical row (keyword, attribute, id, value, treatment)
                outright, so the common case has nothing hidden rather than one line short —
                and the whole panel then fits its floor without a 10px sliver of scroll. */}
            {rowContext && (
              <pre className="max-h-36 overflow-auto rounded-md bg-muted/40 p-2 text-[11px] leading-4 whitespace-pre-wrap text-muted-foreground">
                {rowContext}
              </pre>
            )}
          </div>
        )}
        {stale && (
          <p className="text-[11px] text-muted-foreground">
            This ran on a different prompt than the current default — regenerate to use what is
            in the box.
          </p>
        )}
        {/* The action bar, pinned to the bottom of the scroll. The caveat lives HERE rather than
            as its own row above: same words, one line less of this panel's fixed height, and it
            reads as a note on the button instead of a footnote to the prompt. Sticky against the
            dialog's own scroller; -mx-3 pulls it out to the panel's edges, which p-3 insets. */}
        <div className="sticky bottom-0 -mx-3 flex flex-wrap items-center gap-2 border-t bg-popover px-3 py-2.5">
          <p className="mr-auto text-[11px] text-muted-foreground">
            Prompt edits only apply to this image.
          </p>
          {edited && (
            <Button
              variant="ghost"
              size="sm"
              disabled={locked}
              onClick={() => setDraft(defaultPrompt)}
            >
              Reset
            </Button>
          )}
          <Button
            size="sm"
            disabled={locked || disabled || !draft.trim()}
            title={hint}
            onClick={() => onRegenerate(draft, picked)}
          >
            {working ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
            {actionLabel}
          </Button>
        </div>
    </div>
  );

  // No disclosure of its own: whatever placed this block already decided it should be visible.
  if (!collapsible) {
    return (
      <div className={cn('overflow-hidden rounded-lg border', fill && 'flex min-h-0 flex-1 flex-col')}>
        {content}
      </div>
    );
  }

  return (
    // Open by default: this dialog is opened to inspect one row, and a prompt behind a click is
    // a prompt nobody reads. The trigger still collapses it out of the way.
    <Collapsible defaultOpen className="overflow-hidden rounded-lg border">
      {/* Chevron rotation: a static rule in base.css keys off Base UI's data-panel-open. */}
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium transition-colors outline-none hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset">
        <ChevronRightIcon className="size-4 transition-transform" />
        <SparklesIcon className="size-4 text-primary" />
        {title}
        <span className="ml-auto text-xs font-normal text-muted-foreground">
          {working ? 'Regenerating…' : edited ? 'Custom prompt' : 'Default prompt'}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>{content}</CollapsibleContent>
    </Collapsible>
  );
}

/**
 * The same prompt edit, for a selection instead of one row. Pressing the wand does not fire a
 * batch at Azure on the spot: it opens this, so the one thing a bulk send needs — a chance to
 * say what the send is FOR — is asked for before N requests are spent rather than after.
 *
 * It is deliberately the plainest possible dialog: what will be touched, the instruction, run
 * or cancel. Anything the selection cannot be run on is named in `excludedNote`, so a count in
 * the button never quietly disagrees with what the toolbar said was selected.
 */
export function BatchPromptDialog({
  open,
  onOpenChange,
  defaultPrompt,
  count,
  noun,
  actionLabel = 'AI edit',
  excludedNote,
  busy = false,
  source,
  onRun,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The product's shared prompt — the seed, and what Reset returns to. */
  defaultPrompt: string;
  /**
   * How many items the run will actually touch. A function where the answer depends on the
   * source: sending the original can reach rows that have no generated result yet, and a count
   * fixed before that choice is made would put a number in the button the run does not honour.
   */
  count: number | ((source: PromptSource) => number);
  /** Singular noun for those items: "tile", "image", "row". */
  noun: string;
  actionLabel?: string;
  /** Named skips, e.g. "2 selected rows have no finished tile yet and are left out." */
  excludedNote?: string | ((source: PromptSource) => string | undefined);
  busy?: boolean;
  /** Same choice as the single-item block, applied to every item in the run. */
  source?: PromptSourceOptions;
  onRun: (prompt: string, source: PromptSource) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {/* Keyed on `open`: every opening starts from the shared prompt again, so last time's
            one-off wording is never re-sent by someone who did not expect it to persist. */}
        {open && (
          <BatchPromptBody
            key={String(open)}
            defaultPrompt={defaultPrompt}
            noun={noun}
            count={count}
            actionLabel={actionLabel}
            excludedNote={excludedNote}
            busy={busy}
            source={source}
            onRun={onRun}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function BatchPromptBody({
  defaultPrompt, noun, count, actionLabel, excludedNote, busy, source, onRun, onClose,
}: {
  defaultPrompt: string;
  noun: string;
  count: number | ((source: PromptSource) => number);
  actionLabel: string;
  excludedNote?: string | ((source: PromptSource) => string | undefined);
  busy: boolean;
  source?: PromptSourceOptions;
  onRun: (prompt: string, source: PromptSource) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = React.useState(defaultPrompt);
  const [pick, setPick] = React.useState<PromptSource>('latest');
  // The selection as a whole decides what the control offers; each item is resolved again at
  // send time, because a run can contain a row that has only one of the two.
  const picked = source ? resolvePromptSource(pick, source) : 'latest';
  // Both re-read on every switch of the toggle, so the count in the button and the list of what
  // is left out always describe the run the button would actually start.
  const total = typeof count === 'function' ? count(picked) : count;
  const skipped = typeof excludedNote === 'function' ? excludedNote(picked) : excludedNote;
  const plural = `${total} ${noun}${total === 1 ? '' : 's'}`;
  const edited = draft.trim() !== defaultPrompt.trim();
  // Blanking a prompt the product HAS would send an empty instruction, so that is blocked. But
  // a product whose shared prompt is legitimately empty (Generate with no brief — the row's own
  // cells carry it) must still be runnable: there, an empty box simply means "no override".
  const blocked = defaultPrompt.trim().length > 0 && !draft.trim();
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <SparklesIcon className="size-4 text-primary" />
          {actionLabel} {plural}
        </DialogTitle>
        <DialogDescription>
          Sent with each of them. Applies to this run only — the shared prompt in the panel stays
          unchanged.
          {skipped ? ` ${skipped}` : ''}
        </DialogDescription>
      </DialogHeader>
      {source && (
        <PromptSourcePicker
          options={source}
          value={picked}
          onChange={setPick}
          disabled={busy}
        />
      )}
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={14}
        disabled={busy}
        aria-label={`${actionLabel} prompt`}
        className="max-h-[50dvh] min-h-40 overflow-y-auto text-xs"
      />
      <DialogFooter>
        {edited && (
          <Button variant="ghost" className="mr-auto" disabled={busy} onClick={() => setDraft(defaultPrompt)}>
            Reset
          </Button>
        )}
        <Button variant="outline" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={busy || total === 0 || blocked}
          onClick={() => { onClose(); onRun(draft, picked); }}
        >
          <SparklesIcon data-icon="inline-start" />
          {actionLabel} {plural}
        </Button>
      </DialogFooter>
    </>
  );
}
