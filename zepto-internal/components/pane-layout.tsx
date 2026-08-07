'use client';

// The suite's Figma-style work surface: a fixed left panel (contents/controls), a center
// canvas (the work itself, on a recessed backdrop), and a fixed right panel (properties/
// export). Panels hug the viewport edges like an editor, not a document — no outer page
// padding, each region scrolls by itself, and actions pin to their panel's bottom edge.
//
// Below lg the three regions stack vertically in reading order (left, canvas, right), which
// keeps every control reachable on a laptop half-screen without a horizontal scrollbar.

import * as React from 'react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { Hint } from '@/components/hint';
import { cn } from '@/lib/utils';

// The shell owns the full viewport — there is no per-product header strip above it; product
// identity lives in the rail and panel titles.
export const STUDIO_HEIGHT = '100dvh';

export function StudioShell({
  children,
  height = STUDIO_HEIGHT,
}: {
  children: React.ReactNode;
  height?: string;
}) {
  return (
    <div
      className="flex min-w-0 flex-col lg:h-(--studio-h) lg:flex-row lg:overflow-hidden"
      style={{ '--studio-h': height } as React.CSSProperties}
    >
      {children}
    </div>
  );
}

interface PanelProps {
  /** Uppercase panel caption, Figma-style; the hint sits right-aligned beside it. */
  title: string;
  hint?: string;
  children: React.ReactNode;
  /** Pinned to the panel's bottom edge, outside the scroll region. */
  footer?: React.ReactNode;
  className?: string;
}

function Panel({ side, title, hint, children, footer, className }: PanelProps & { side: 'left' | 'right' }) {
  return (
    <section
      aria-label={title}
      className={cn(
        'flex min-w-0 flex-col border-border bg-background lg:h-full',
        side === 'left' ? 'lg:border-r' : 'lg:border-l',
        // Stacked (mobile) order: left panel above the canvas, right panel below it.
        side === 'right' && 'order-last',
        className,
      )}
    >
      <div className="flex shrink-0 items-baseline gap-2 border-b px-4 py-2.5">
        <h2 className="text-xs font-semibold tracking-wide uppercase">{title}</h2>
        {hint && <span className="ml-auto truncate text-xs text-muted-foreground">{hint}</span>}
      </div>
      {/* Flat, Figma-style body: sections divided by hairlines instead of card outlines,
          and the scrollbar (ScrollArea) fades in only while hovering or scrolling. */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="divide-y divide-border">{children}</div>
      </ScrollArea>
      {footer && <div className="shrink-0 border-t p-3">{footer}</div>}
    </section>
  );
}

/**
 * One flat settings group inside a Left/RightPanel — the card replacement. Panels divide
 * consecutive sections with hairlines, so this carries only padding and an optional header.
 */
export function PanelSection({
  title,
  hint,
  description,
  action,
  children,
  className,
}: {
  /** Optional section heading; wrapped in a Hint tooltip when `hint` is given. */
  title?: React.ReactNode;
  hint?: React.ReactNode;
  /** Visible subtext under the heading (the old CardDescription). */
  description?: React.ReactNode;
  /** Rendered right-aligned beside the title. */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className="px-4 py-4">
      {(title != null || action != null) && (
        <div className="mb-3 flex items-center gap-2">
          {title != null && (
            <h3 className="text-sm font-medium">{hint ? <Hint hint={hint}>{title}</Hint> : title}</h3>
          )}
          {action != null && <div className="ml-auto">{action}</div>}
        </div>
      )}
      {description != null && (
        <p className="-mt-2 mb-3 text-xs text-muted-foreground">{description}</p>
      )}
      <div className={cn('space-y-3', className)}>{children}</div>
    </section>
  );
}

export function LeftPanel(props: PanelProps) {
  return <Panel side="left" {...props} className={cn('lg:w-[380px] lg:shrink-0', props.className)} />;
}

export function RightPanel(props: PanelProps) {
  return <Panel side="right" {...props} className={cn('lg:w-[320px] lg:shrink-0', props.className)} />;
}

/**
 * The center work surface. Recessed backdrop so panels read as chrome and this reads as the
 * canvas; the scroll container ref is what the virtual grids measure against.
 */
export function Canvas({
  children,
  footer,
  scrollRef,
  className,
}: {
  children: React.ReactNode;
  footer?: React.ReactNode;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  className?: string;
}) {
  return (
    <section aria-label="Canvas" className="flex min-w-0 flex-1 flex-col bg-muted/40 lg:h-full">
      <div
        ref={scrollRef}
        className={cn('max-h-[70dvh] min-h-0 flex-1 overflow-y-auto p-4 lg:max-h-none', className)}
      >
        {children}
      </div>
      {footer && (
        <div className="shrink-0 border-t bg-background px-4 py-2.5">{footer}</div>
      )}
    </section>
  );
}
