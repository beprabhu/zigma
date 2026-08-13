'use client';

// Compact "markdown file" card for prompt-like text that is configuration, not a per-run
// control: panels show this tile (name, first line, status badge) and the editing surface
// lives in a roomy modal. Shared by Cleanup (default AI-edit prompt) and Generate (uploaded
// brief) so the two products present prompts identically.
//
// Composed from the shadcn Item primitive (rendered as a <button> via Base UI's render prop)
// so hover/focus/disabled conventions come from the registry instead of being re-implemented.

import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import {
  Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle,
} from '@/components/ui/item';
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

export function MdFileTile({
  name,
  text,
  badge,
  onClick,
  disabled = false,
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
  className?: string;
}) {
  const preview = text.split('\n').find((line) => line.trim()) ?? '';
  return (
    <Item
      variant="outline"
      render={<button type="button" onClick={onClick} disabled={disabled} />}
      className={cn(
        'cursor-pointer text-left hover:bg-accent disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
    >
      <ItemMedia variant="icon">
        <MdFileIcon className="text-muted-foreground" />
      </ItemMedia>
      <ItemContent className="min-w-0 gap-0">
        <ItemTitle className="w-full truncate">{name}</ItemTitle>
        <ItemDescription className="truncate text-xs">{preview}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Badge variant="chip">{badge}</Badge>
      </ItemActions>
    </Item>
  );
}
