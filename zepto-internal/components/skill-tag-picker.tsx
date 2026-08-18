'use client';

// Picking a skill's tag — @shadcn/combobox (Base UI), the same primitive the CSV column picker
// and the prompt switcher use.
//
// A plain text input made every tag a fresh act of typing, which is how one tag becomes
// "banner", "Banner" and "banners" — three chips that look like three groups and are one. The
// tags already in use are therefore the list, and typing is the fallback rather than the
// default: reuse costs one click, and creating still costs only what typing cost before.
//
// The creatable row follows Base UI's own pattern: a synthetic item carrying the typed text is
// appended to `items` whenever nothing matches exactly, and picking it is caught in
// onValueChange. The search field sits inside the popup because the closed state has to show a
// coloured pill rather than text.

import * as React from 'react';
import { PlusIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { TAG_DOTS } from '@/components/ui/badge';
import {
  Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList,
  ComboboxTrigger,
} from '@/components/ui/combobox';
import { SkillTagBadge } from '@/components/md-file-tile';
import { TAG_COLORS, type SkillTag, type TagColor } from '@/lib/skills';
import { cn } from '@/lib/utils';

/** A row in the list: either a tag in use, or the "create this" row carrying the typed text. */
type TagOption = SkillTag & { creatable?: string };

/**
 * Every tag in use, deduped by label (case-insensitively — first spelling wins, so the list
 * cannot show "Banner" and "banner" as two things). Sorted, because a combobox's list is read.
 */
export function tagsInUse(tagged: { tag?: SkillTag }[]): SkillTag[] {
  const seen = new Map<string, SkillTag>();
  for (const item of tagged) {
    const label = item.tag?.label.trim();
    if (!label || !item.tag) continue;
    const key = label.toLowerCase();
    if (!seen.has(key)) seen.set(key, { label, color: item.tag.color });
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function SkillTagPicker({
  value,
  options,
  onChange,
  id,
  disabled,
  className,
}: {
  /** The draft's tag. A blank label counts as no tag, same rule as saving. */
  value?: SkillTag;
  /** Suggestions — normally tagsInUse() over every skill. */
  options: SkillTag[];
  onChange: (tag: SkillTag | undefined) => void;
  id?: string;
  disabled?: boolean;
  /** Lets a caller strip the trigger's own chrome when it sits inside an InputGroup. */
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const label = value?.label.trim() ?? '';
  const typed = query.trim();
  const exists = options.some((t) => t.label.toLowerCase() === typed.toLowerCase());

  /**
   * A brand-new tag opens on a colour nothing else is wearing, so tags come out of the box
   * telling each other apart — which is the entire point of colouring them. Once every colour
   * is spoken for it falls back to the palette's first, and the swatches override either way.
   */
  const freshColor = (): TagColor => {
    if (value?.color) return value.color;
    const used = new Set(options.map((t) => t.color));
    return TAG_COLORS.find((c) => !used.has(c)) ?? TAG_COLORS[0];
  };

  // The creatable row's label IS the typed text, so the filter always keeps it — and so typing
  // "ban" offers both Create "ban" and the existing "banner".
  const items: TagOption[] =
    typed && !exists ? [...options, { label: typed, color: freshColor(), creatable: typed }] : options;

  function commit(next: TagOption | null) {
    setQuery('');
    setOpen(false);
    if (!next) return onChange(undefined);
    // Picking an existing tag takes its colour too: the same tag rendering in two colours
    // across two skills would undo what the colour is for.
    onChange({ label: next.creatable ?? next.label, color: next.color });
  }

  return (
    <Combobox
      items={items}
      value={value ?? null}
      onValueChange={commit}
      inputValue={query}
      onInputValueChange={setQuery}
      itemToStringLabel={(tag: TagOption) => tag.label}
      isItemEqualToValue={(a: TagOption, b: TagOption) =>
        a.label.toLowerCase() === b.label.toLowerCase()
      }
      open={open}
      onOpenChange={setOpen}
      disabled={disabled}
    >
      {/* The trigger shows the pill itself, not the tag's name in body text — what is being
          chosen here is a coloured chip, so the closed state should be that chip. */}
      <ComboboxTrigger
        id={id}
        render={
          <Button
            type="button"
            variant="outline"
            className={cn('w-full justify-between font-normal', className)}
          />
        }
      >
        {label && value ? (
          <SkillTagBadge tag={value} />
        ) : (
          <span className="truncate text-muted-foreground">No tag</span>
        )}
      </ComboboxTrigger>
      <ComboboxContent align="start">
        <ComboboxInput placeholder="Find or create a tag…" showTrigger={false} />
        <ComboboxEmpty>Type to create a tag.</ComboboxEmpty>
        <ComboboxList>
          {(tag: TagOption) => (
            <ComboboxItem key={tag.creatable ? '__create__' : tag.label} value={tag}>
              {tag.creatable ? (
                <>
                  <PlusIcon className="shrink-0" />
                  <span className="truncate">Create &ldquo;{tag.creatable}&rdquo;</span>
                </>
              ) : (
                <>
                  <span className={cn('size-2.5 shrink-0 rounded-full', TAG_DOTS[tag.color])} />
                  <span className="truncate">{tag.label}</span>
                </>
              )}
            </ComboboxItem>
          )}
        </ComboboxList>
        {/* Clearing is a footer, not a list row: a row saying "No tag" would be filtered away
            by typing, which is exactly when someone might want it. */}
        {label && (
          <div className="flex border-t p-1">
            <Button size="xs" variant="ghost" onClick={() => commit(null)}>
              No tag
            </Button>
          </div>
        )}
      </ComboboxContent>
    </Combobox>
  );
}
