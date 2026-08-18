'use client';

// Compact "markdown file" card for prompt-like text that is configuration, not a per-run
// control: panels show this tile (name, first line, status badge) and the editing surface
// lives in a roomy modal. Shared by Compose (composite prompt), Cleanup (default AI-edit
// prompt) and Generate (brief) so the three products present prompts identically.
//
// With `skills` set, the tile also carries the prompt switcher: a caret button opening a
// searchable list of the skills managed in Settings → Skills. Picking one hands the skill to
// the owner, which copies its content into the surface's own prompt state — selection stays
// content-derived (matchSkill), preset-style, exactly like Compose pioneered.
//
// Composed from the shadcn Item primitive. Without `skills` the whole tile is a <button>
// (via Base UI's render prop); with `skills` the tile is a div holding two siblings — the
// clickable body and the switcher — because button-in-button is invalid HTML.

import * as React from 'react';

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge, TAG_TONES } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList,
  ComboboxTrigger,
} from '@/components/ui/combobox';
import {
  Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle,
} from '@/components/ui/item';
import { CUSTOM_SKILL_ID, type PromptSkill, type SkillTag } from '@/lib/skills';
import { cn } from '@/lib/utils';

/** A skill's tag, wherever skills are listed: Settings, the switcher menu, the panel tile. */
export function SkillTagBadge({ tag, className }: { tag: SkillTag; className?: string }) {
  return (
    <Badge variant="chip" className={cn('shrink-0', TAG_TONES[tag.color], className)}>
      {tag.label}
    </Badge>
  );
}

/** Markdown-mark file icon (the "M↓" badge) — lucide has no markdown glyph, so this matches
    its stroke style and is shared everywhere a .md file is represented. */
export function MdFileIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="2" y="5" width="20" height="14" rx="2.5" />
      <path d="M6 15v-5.5l2.75 2.75 2.75-2.75V15" />
      <path d="M16.75 9.5V15m0 0-2.25-2.25M16.75 15 19 12.75" />
    </svg>
  );
}

export interface SkillSwitch {
  /** Built-ins first, then custom — the order useSkills() returns. */
  list: PromptSkill[];
  /** The matched skill id, or CUSTOM_SKILL_ID when the text equals none of them. */
  activeId: string;
  /** Copy this skill's content into the surface's prompt state. */
  onSelect: (skill: PromptSkill) => void;
}

export function MdFileTile({
  name,
  text,
  badge,
  onClick,
  disabled = false,
  skills,
  className,
}: {
  /** File-style display name, e.g. "ai-edit-prompt.md" or the uploaded brief's name. */
  name: string;
  /** Full text; the tile previews its first non-empty line. */
  text: string;
  /**
   * Short status chip for something the tile cannot work out for itself — Generate's character
   * count, say. Omit it: naming the active skill "Skill" only restated the section it sits in,
   * and that slot is worth more carrying the skill's own tag.
   */
  badge?: string;
  onClick: () => void;
  disabled?: boolean;
  /** Enables the skill-switcher caret; omit for a plain click-to-edit tile. */
  skills?: SkillSwitch;
  className?: string;
}) {
  // A skill picked while the text is in the unsaved Edited state waits here for the
  // overwrite confirm; null whenever no confirm is pending.
  const [pendingSkill, setPendingSkill] = React.useState<PromptSkill | null>(null);
  const [switcherOpen, setSwitcherOpen] = React.useState(false);
  const preview = text.split('\n').find((line) => line.trim()) ?? '';

  // What the tile puts in its chip slot, derived rather than passed: the active skill's tag
  // when it has one, then whatever the owner asked for, and failing both the one state the
  // owner could not see for itself — text that matches no saved skill.
  const activeSkill = skills?.list.find((sk) => sk.id === skills.activeId);
  const chips = (
    <>
      {activeSkill?.tag?.label.trim() && <SkillTagBadge tag={activeSkill.tag} />}
      {badge ? (
        <Badge variant="chip" className="shrink-0">{badge}</Badge>
      ) : skills?.activeId === CUSTOM_SKILL_ID ? (
        <Badge variant="chip" className="shrink-0">Edited</Badge>
      ) : null}
    </>
  );
  const body = (
    <>
      <ItemMedia variant="icon">
        <MdFileIcon className="text-muted-foreground" />
      </ItemMedia>
      <ItemContent className="min-w-0 gap-0">
        <ItemTitle className="w-full truncate">{name}</ItemTitle>
        <ItemDescription className="truncate text-xs">{preview}</ItemDescription>
      </ItemContent>
    </>
  );

  if (!skills) {
    return (
      <Item
        variant="outline"
        render={<button type="button" onClick={onClick} disabled={disabled} />}
        className={cn(
          'cursor-pointer text-left hover:bg-accent disabled:pointer-events-none disabled:opacity-50',
          className,
        )}
      >
        {body}
        <ItemActions>{chips}</ItemActions>
      </Item>
    );
  }

  function choose(skill: PromptSkill) {
    setSwitcherOpen(false);
    // Edited text matches no skill, so switching would overwrite work that is saved nowhere —
    // that one deserves a confirm. Skill-to-skill is lossless (the current text IS a skill)
    // and applies immediately.
    if (skills!.activeId === CUSTOM_SKILL_ID && text.trim()) setPendingSkill(skill);
    else skills!.onSelect(skill);
  }

  return (
    <Item
      variant="outline"
      className={cn('flex-nowrap gap-0 p-0', disabled && 'pointer-events-none opacity-50', className)}
    >
      {/* Everything except the caret opens the editor — same target the plain tile had,
          including the badge, so muscle memory from before the switcher still works. */}
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 self-stretch rounded-l-lg py-2.5 pl-3 pr-1.5 text-left transition-colors duration-100 outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {body}
        {chips}
      </button>
      <ItemActions className="shrink-0 gap-0 pr-1.5">
        {/* A searchable list, not a menu: skills accumulate, and past a screenful a menu's only
            affordance for finding one is to read every row. The search field sits inside the
            popup because the trigger is a caret button, not a text field — Base UI's
            "input inside popup" arrangement. */}
        <Combobox
          items={skills.list}
          value={activeSkill ?? null}
          onValueChange={(sk: PromptSkill | null) => sk && choose(sk)}
          // What the filter reads. Including the tag is most of why tags are worth having:
          // typing "banner" finds every skill tagged banner, not just the one named after it.
          itemToStringLabel={(sk: PromptSkill) => `${sk.name} ${sk.tag?.label ?? ''}`}
          open={switcherOpen}
          onOpenChange={setSwitcherOpen}
          disabled={disabled}
        >
          <ComboboxTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                // The wrapper already dims the whole tile when disabled.
                className="disabled:opacity-100"
                aria-label="Switch prompt skill"
              />
            }
          />
          <ComboboxContent align="end" className="w-72">
            <ComboboxInput placeholder="Search skills…" showTrigger={false} />
            <ComboboxEmpty>No skill matches.</ComboboxEmpty>
            <ComboboxList>
              {(sk: PromptSkill) => (
                <ComboboxItem key={sk.id} value={sk}>
                  <span className="truncate">{sk.name}</span>
                  {/* The tag earns its place most here: this is the list you pick from. */}
                  {sk.tag?.label.trim() && <SkillTagBadge tag={sk.tag} />}
                </ComboboxItem>
              )}
            </ComboboxList>
            {/* "Custom" used to be a disabled row in the menu. In a searchable list a row that
                cannot be picked AND vanishes as soon as you type is worse than a line that
                simply stays put and says what the state is. Note a duplicate whose content
                still equals its source resolves to the source (matchSkill is content-derived,
                first match wins) — it gains its own identity once its content is edited. */}
            {skills.activeId === CUSTOM_SKILL_ID && (
              <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                This text matches no saved skill.
              </p>
            )}
          </ComboboxContent>
        </Combobox>
      </ItemActions>
      <AlertDialog open={pendingSkill !== null} onOpenChange={(open) => !open && setPendingSkill(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace the edited prompt?</AlertDialogTitle>
            <AlertDialogDescription>
              The current text doesn&rsquo;t match any saved skill, so switching to{' '}
              {pendingSkill?.name ?? 'another skill'} overwrites it. Save it as a skill from
              Settings first if you want to keep it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingSkill) skills.onSelect(pendingSkill);
                setPendingSkill(null);
              }}
            >
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Item>
  );
}
