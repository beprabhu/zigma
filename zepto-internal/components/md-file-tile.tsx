'use client';

// Compact "markdown file" card for prompt-like text that is configuration, not a per-run
// control: panels show this tile (name, first line, status badge) and the editing surface
// lives in a roomy modal. Shared by Compose (composite prompt), Cleanup (default AI-edit
// prompt) and Generate (brief) so the three products present prompts identically.
//
// With `skills` set, the tile also carries the prompt switcher: an up/down-caret button
// (matching the Select trigger convention) opening a menu of the skills managed in
// Settings → Skills. Picking one hands the skill to the owner, which copies its content
// into the surface's own prompt state — selection stays content-derived (matchSkill),
// preset-style, exactly like Compose pioneered.
//
// Composed from the shadcn Item primitive. Without `skills` the whole tile is a <button>
// (via Base UI's render prop); with `skills` the tile is a div holding two siblings — the
// clickable body and the caret menu — because button-in-button is invalid HTML.

import * as React from 'react';
import { ChevronsUpDownIcon } from 'lucide-react';

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle,
} from '@/components/ui/item';
import { CUSTOM_SKILL_ID, type PromptSkill } from '@/lib/skills';
import { cn } from '@/lib/utils';

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
  /** Short status chip: "Default", "Customised", "1,240 chars", … */
  badge: string;
  onClick: () => void;
  disabled?: boolean;
  /** Enables the skill-switcher caret; omit for a plain click-to-edit tile. */
  skills?: SkillSwitch;
  className?: string;
}) {
  // A skill picked while the text is in the unsaved Edited state waits here for the
  // overwrite confirm; null whenever no confirm is pending.
  const [pendingSkill, setPendingSkill] = React.useState<PromptSkill | null>(null);
  const preview = text.split('\n').find((line) => line.trim()) ?? '';
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
        <ItemActions>
          <Badge variant="chip">{badge}</Badge>
        </ItemActions>
      </Item>
    );
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
        <Badge variant="chip" className="shrink-0">{badge}</Badge>
      </button>
      <ItemActions className="shrink-0 gap-0 pr-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={disabled}
                // The wrapper already dims the whole tile when disabled.
                className="disabled:opacity-100"
                aria-label="Switch prompt skill"
              />
            }
          >
            <ChevronsUpDownIcon className="text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56 max-w-72">
            <DropdownMenuRadioGroup
              value={skills.activeId}
              onValueChange={(v) => {
                const skill = skills.list.find((sk) => sk.id === v);
                if (!skill) return;
                // Edited text matches no skill, so switching would overwrite work that is
                // saved nowhere — that one deserves a confirm. Skill-to-skill is lossless
                // (the current text IS a skill) and applies immediately.
                if (skills.activeId === CUSTOM_SKILL_ID && text.trim()) setPendingSkill(skill);
                else skills.onSelect(skill);
              }}
            >
              {skills.list.map((sk) => (
                // closeOnClick: picking a prompt is a one-shot switch, not a toggle session —
                // the menu closing is the confirmation, Select-style.
                <DropdownMenuRadioItem key={sk.id} value={sk.id} closeOnClick>
                  <span className="truncate">{sk.name}</span>
                </DropdownMenuRadioItem>
              ))}
              {/* Indicator, not an action: it becomes selected by editing the prompt.
                  Note a duplicate whose content still equals its source resolves to the
                  source (matchSkill is content-derived, first match wins) — it gains its
                  own identity the moment its content is edited. */}
              <DropdownMenuRadioItem value={CUSTOM_SKILL_ID} disabled>
                Custom
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
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
