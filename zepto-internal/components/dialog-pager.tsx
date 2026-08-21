'use client';

// Step through a queue without closing the dialog you are in — Cleanup, Compose and Generate
// all open one row at a time out of a list, so all three want the same control and the same
// keys. It lives here rather than in one of them because a second copy is where the two would
// start to disagree about bounds, labels or which keys are safe to take.

import * as React from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ButtonGroup, ButtonGroupText } from '@/components/ui/button-group';
import { cn } from '@/lib/utils';

export interface DialogPagerPosition {
  /** 1-based, for the label. */
  index: number;
  total: number;
}

export interface DialogPagerProps {
  /** Omit to hide the pager — a dialog opened on something that is not a list has nowhere to go. */
  onNavigate?: (delta: 1 | -1) => void;
  position?: DialogPagerPosition;
  /** What the buttons call the thing being stepped through: "image", "tile", "row". */
  noun?: string;
  className?: string;
}

/**
 * ← / → step through the queue. Bound on the window because there is nothing sensible to focus
 * first, and scoped by what the key is currently FOR: inside a text field the arrows move the
 * caret, and inside a listbox, menu, tablist or slider they move the selection. Stealing them
 * there would break editing the prompt these dialogs all contain.
 */
export function useDialogPagerKeys(onNavigate?: (delta: 1 | -1) => void) {
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
}

/** Renders nothing when there is nowhere to go, so callers need no guard of their own. */
export function DialogPager({ onNavigate, position, noun = 'image', className }: DialogPagerProps) {
  if (!onNavigate || !position || position.total <= 1) return null;
  return (
    <ButtonGroup className={cn('shrink-0', className)}>
      <Button
        variant="outline"
        size="icon-sm"
        disabled={position.index <= 1}
        title={`Previous ${noun}`}
        onClick={() => onNavigate(-1)}
      >
        <ChevronLeftIcon />
        <span className="sr-only">Previous {noun}</span>
      </Button>
      <ButtonGroupText className="h-7 rounded-[min(var(--radius-md),12px)] px-2 text-xs font-normal tabular-nums">
        <span aria-live="polite">
          {position.index} / {position.total}
        </span>
      </ButtonGroupText>
      <Button
        variant="outline"
        size="icon-sm"
        disabled={position.index >= position.total}
        title={`Next ${noun}`}
        onClick={() => onNavigate(1)}
      >
        <ChevronRightIcon />
        <span className="sr-only">Next {noun}</span>
      </Button>
    </ButtonGroup>
  );
}
