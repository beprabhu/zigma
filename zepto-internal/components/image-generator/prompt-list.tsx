'use client';

// Generate's typed row source: a prompt box where a numbered list means several requests.
//
// The brief answers "how should these look"; this answers "what are they OF". Keeping them
// apart is the point — one skill, many subjects, one request each — and it is why the list is
// not just extra text appended to the brief.
//
// The editing rule lives in lib/prompt-list.ts. This file is only the textarea that applies it
// and puts the caret back afterwards.

import * as React from 'react';

import { Textarea } from '@/components/ui/textarea';
import { listBackspace, listEnter } from '@/lib/prompt-list';
import { cn } from '@/lib/utils';

export function PromptListInput({
  value,
  onChange,
  disabled,
  id,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  // Set by the key handlers, applied after React has painted the new value: assigning
  // selectionStart before the DOM holds that text would clamp it to the OLD length.
  const caretRef = React.useRef<number | null>(null);

  React.useLayoutEffect(() => {
    const caret = caretRef.current;
    if (caret === null || !ref.current) return;
    caretRef.current = null;
    ref.current.setSelectionRange(caret, caret);
  }, [value]);

  const apply = (edit: { text: string; caret: number } | null) => {
    if (!edit) return false;
    caretRef.current = edit.caret;
    onChange(edit.text);
    return true;
  };

  return (
    <Textarea
      id={id}
      ref={ref}
      value={value}
      disabled={disabled}
      spellCheck={false}
      rows={5}
      placeholder={'1. a brass diya on a marble ledge\n2. the same diya, lit, at dusk'}
      // text-xs, no font override: every other prompt surface in the suite — the brief editor,
      // Compose's prompt, Cleanup's AI edit — is the app's sans at this size, and a monospace
      // box for the sake of aligning "1." markers would make this the one screen that looks
      // like a code editor.
      className={cn('max-h-64 min-h-24 text-xs leading-relaxed', className)}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        const el = e.currentTarget;
        if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
          if (apply(listEnter(el.value, el.selectionStart, el.selectionEnd))) e.preventDefault();
          return;
        }
        if (e.key === 'Backspace') {
          if (apply(listBackspace(el.value, el.selectionStart, el.selectionEnd))) e.preventDefault();
        }
      }}
    />
  );
}
