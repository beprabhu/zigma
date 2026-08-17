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
  onRegenerate: (prompt: string) => void;
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
  onRegenerate,
}: RegenPromptProps) {
  const seed = sentPrompt ?? defaultPrompt;
  const [draft, setDraft] = React.useState(seed);
  const edited = draft.trim() !== defaultPrompt.trim();
  // The row ran on something the current settings no longer produce. Worth saying plainly:
  // otherwise the obvious reading of an unexpected result is that the prompt is being ignored.
  const stale = !!sentPrompt && sentPrompt.trim() !== defaultPrompt.trim();
  const locked = busy || working;

  return (
    // Open by default: this dialog is opened to inspect one row, and a prompt behind a click is
    // a prompt nobody reads. The trigger still collapses it out of the way.
    <Collapsible defaultOpen className="rounded-lg border">
      {/* Chevron rotation: a static rule in base.css keys off Base UI's data-panel-open. */}
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium">
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
              onClick={() => onRegenerate(draft)}
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
  onRun,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The product's shared prompt — the seed, and what Reset returns to. */
  defaultPrompt: string;
  /** How many items the run will actually touch. */
  count: number;
  /** Singular noun for those items: "tile", "image", "row". */
  noun: string;
  actionLabel?: string;
  /** Named skips, e.g. "2 selected rows have no finished tile yet and are left out." */
  excludedNote?: string;
  busy?: boolean;
  onRun: (prompt: string) => void;
}) {
  const plural = `${count} ${noun}${count === 1 ? '' : 's'}`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {/* Keyed on `open`: every opening starts from the shared prompt again, so last time's
            one-off wording is never re-sent by someone who did not expect it to persist. */}
        {open && (
          <BatchPromptBody
            key={String(open)}
            defaultPrompt={defaultPrompt}
            plural={plural}
            actionLabel={actionLabel}
            excludedNote={excludedNote}
            busy={busy}
            disabled={count === 0}
            onRun={onRun}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function BatchPromptBody({
  defaultPrompt, plural, actionLabel, excludedNote, busy, disabled, onRun, onClose,
}: {
  defaultPrompt: string;
  plural: string;
  actionLabel: string;
  excludedNote?: string;
  busy: boolean;
  disabled: boolean;
  onRun: (prompt: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = React.useState(defaultPrompt);
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
          {excludedNote ? ` ${excludedNote}` : ''}
        </DialogDescription>
      </DialogHeader>
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
          disabled={busy || disabled || blocked}
          onClick={() => { onClose(); onRun(draft); }}
        >
          <SparklesIcon data-icon="inline-start" />
          {actionLabel} {plural}
        </Button>
      </DialogFooter>
    </>
  );
}
