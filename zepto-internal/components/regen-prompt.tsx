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
  /** What "latest" is called in this product: "Generated tile", "Last AI result". */
  latestLabel: string;
  /** What "original" is called: "Source photos", "Imported image". */
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
          <ToggleGroupItem value="latest">{options.latestLabel}</ToggleGroupItem>
          <ToggleGroupItem value="original">{options.originalLabel}</ToggleGroupItem>
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
      <CollapsibleContent>
        <div className="space-y-2 border-t p-3">
          <div className="flex items-center justify-end">
            <CopyButton
              text={rowContext ? `${draft}\n\n${rowContext}` : draft}
              title="Copy the full prompt"
            />
          </div>
          {source && (
            <PromptSourcePicker
              options={source}
              value={picked}
              onChange={setPick}
              disabled={locked || disabled}
            />
          )}
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
            disabled={locked}
            aria-label={`${title} for this row`}
            className="max-h-64 overflow-y-auto text-xs"
          />
          {rowContext && (
            <pre className="max-h-28 overflow-auto rounded-md bg-muted/50 p-2 text-[11px] whitespace-pre-wrap text-muted-foreground">
              {rowContext}
            </pre>
          )}
          {stale && (
            <p className="text-[11px] text-muted-foreground">
              This ran on a different prompt than the current default — regenerate to use what is
              in the box.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <p className="mr-auto text-xs text-muted-foreground">
              Applies to this row only — the shared prompt stays unchanged.
              {rowContext ? ' The CSV row above is appended to it.' : ''}
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
              Regenerate
            </Button>
          </div>
        </div>
      </CollapsibleContent>
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
