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

// Figma's Show/Hide UI shortcut (⌘\ / Ctrl+\): both side panels vanish and the canvas takes
// the full viewport; the same press brings them back. Session-scoped like Figma — a reload
// restores the panels.
const PanelsHiddenContext = React.createContext(false);

export function StudioShell({
  children,
  height = STUDIO_HEIGHT,
}: {
  children: React.ReactNode;
  height?: string;
}) {
  const [panelsHidden, setPanelsHidden] = React.useState(false);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key !== '\\') return;
      event.preventDefault();
      setPanelsHidden((prev) => !prev);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <PanelsHiddenContext.Provider value={panelsHidden}>
      <div
        className="flex min-w-0 flex-col lg:h-(--studio-h) lg:flex-row lg:overflow-hidden"
        style={{ '--studio-h': height } as React.CSSProperties}
      >
        {children}
      </div>
    </PanelsHiddenContext.Provider>
  );
}

interface PanelProps {
  /** Accessible name only — panels render no visible title strip; the session header and
      section headings carry the visual structure. */
  title: string;
  children: React.ReactNode;
  /** Rendered at the panel's top edge — the Figma-style file/session header slot. */
  header?: React.ReactNode;
  /** Pinned to the panel's bottom edge, outside the scroll region. */
  footer?: React.ReactNode;
  className?: string;
}

function Panel({ side, title, children, header, footer, className }: PanelProps & { side: 'left' | 'right' }) {
  // Unmounted, not width-zeroed: hidden panels must not keep canvases, previews and effects
  // alive off screen — a 3,000-cell grid behind a collapsed panel would still be paying rent.
  const panelsHidden = React.useContext(PanelsHiddenContext);
  if (panelsHidden) return null;
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
      {/* pt-4: both panes open with 16px of air above their first block — the session header
          when there is one, otherwise the first section inside the scroll region. */}
      {header && <div className="shrink-0 border-b pt-4">{header}</div>}
      {/* Flat, Figma-style body: sections divided by hairlines instead of card outlines,
          and the scrollbar (ScrollArea) fades in only while hovering or scrolling. */}
      <ScrollArea className="min-h-0 flex-1">
        <div className={cn('divide-y divide-border', !header && 'pt-4')}>{children}</div>
      </ScrollArea>
      {footer && <div className="shrink-0 border-t px-4 py-3">{footer}</div>}
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
  /** Omit for a heading-only section — a titled switch row with its body collapsed. */
  children?: React.ReactNode;
  className?: string;
}) {
  // Descriptions live in the title's tooltip, not as visible subtext — panels stay dense and
  // the explanation is one hover away. A description WITHOUT a title has no tooltip anchor,
  // so that one case stays visible rather than silently vanishing.
  const tip =
    hint != null && description != null ? (
      <>
        {hint} {description}
      </>
    ) : (
      hint ?? description
    );
  return (
    <section className="px-4 py-4">
      {(title != null || action != null) && (
        <div className={cn('flex items-center gap-2', children != null && 'mb-3')}>
          {title != null && (
            // font-semibold, one visual rank above FieldLabel (text-xs regular) — the
            // section/property hierarchy the whole panel column reads by.
            <h3 className="text-sm font-semibold">{tip ? <Hint hint={tip}>{title}</Hint> : title}</h3>
          )}
          {action != null && <div className="ml-auto">{action}</div>}
        </div>
      )}
      {title == null && description != null && (
        <p className="mb-3 text-xs text-muted-foreground">{description}</p>
      )}
      {children != null && <div className={cn('space-y-3', className)}>{children}</div>}
    </section>
  );
}

/**
 * The grid's toolbar row — filters, counts, Clear all — pinned to the canvas's top edge.
 *
 * It scrolled away with the grid before, which on a 8,000-image queue meant the filter you set
 * two screens ago was unreachable without scrolling back to the top, and the count line (the one
 * thing that says how much of the queue you are looking at) was visible only while looking at
 * the part that needs it least. Frosted rather than opaque: the tiles stay legible as they pass
 * under it, so the bar reads as a layer over the canvas instead of a lid on it.
 *
 * The negative margins undo Canvas's own p-4 so the bar spans the full width and covers the
 * padding above it — without them, cells scroll through a 16px gap on either side of it.
 */
export function CanvasToolbar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        // -top-4 pairs with -mt-4: sticky pins the MARGIN box, so with top-0 a negative margin
        // parks the bar 16px down and cells scroll through the strip above it.
        'sticky -top-4 z-20 -mx-4 -mt-4 mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2',
        'border-b border-border/60 bg-background/70 px-4 pt-4 pb-3 backdrop-blur-md',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function LeftPanel(props: PanelProps) {
  return <Panel side="left" {...props} className={cn('lg:w-[320px] lg:shrink-0', props.className)} />;
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
        <div className="shrink-0 border-t bg-background px-4 py-3">{footer}</div>
      )}
    </section>
  );
}
