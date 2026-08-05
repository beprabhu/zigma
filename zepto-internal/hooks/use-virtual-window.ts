'use client';

import * as React from 'react';

// Fixed-height windowing for lists and grids: measure the scroll container, hand back the slice
// of rows that is on screen plus two spacers standing in for the rest. Rows must all be the same
// height — the caller passes it, so a breakpoint that resizes cells just passes a new number.

export interface VirtualWindow {
  /** First row index to render (inclusive). */
  startIndex: number;
  /** Last row index to render (EXCLUSIVE). */
  endIndex: number;
  /** Spacer height above the rendered window, in px. */
  paddingTop: number;
  /** Spacer height below the rendered window, in px. */
  paddingBottom: number;
  /** Full scrollable height of all rows, in px. */
  totalHeight: number;
}

export interface VirtualWindowOptions {
  /** The element that actually scrolls. May be null on first render. */
  scrollRef: React.RefObject<HTMLElement | null>;
  /** Number of ROWS (for a grid, ceil(items / columns)). */
  rowCount: number;
  /** Fixed height of one row including its gap, in px. */
  rowHeight: number;
  /** Extra rows rendered above and below the viewport. Default 3. */
  overscan?: number;
  /**
   * Height of whatever is rendered above row 0 *inside the same scroll container*, in px.
   * Row offsets are measured from the top of the scrolled content, so a heading or preview panel
   * that scrolls along with the rows shifts them all down by this much. Default 0.
   */
  offsetTop?: number;
}

const DEFAULT_OVERSCAN = 3;

function computeWindow(
  scrollTop: number,
  viewportHeight: number,
  rowCount: number,
  rowHeight: number,
  overscan: number,
): VirtualWindow {
  // Written as comparisons rather than Number.isFinite checks so a NaN or zero row height falls
  // back to a usable window instead of poisoning every padding and collapsing the scrollbar.
  const rows = rowCount > 0 ? Math.floor(rowCount) : 0;
  const measured = rowHeight > 0;
  const height = measured ? rowHeight : 1;
  const slack = overscan > 0 ? Math.floor(overscan) : 0;
  const offset = scrollTop > 0 ? scrollTop : 0;

  const totalHeight = rows * height;
  const firstVisible = Math.floor(offset / height);
  // The +1 is the partially-scrolled row at the bottom edge; without it the last row pops in only
  // after it is fully exposed. Neither fallback may divide the viewport: at the 1px placeholder
  // height that windows in one row per viewport pixel, which is the unbounded mount this module
  // exists to prevent. One row keeps the first paint of an unresolved container non-blank.
  const visibleRows = measured && viewportHeight > 0 ? Math.ceil(viewportHeight / height) + 1 : 1;

  const startIndex = Math.max(0, Math.min(rows, firstVisible - slack));
  const endIndex = Math.max(startIndex, Math.min(rows, firstVisible + visibleRows + slack));

  const paddingTop = startIndex * height;
  // Derived by subtraction, not as (rows - endIndex) * height: the three pieces have to sum to
  // totalHeight to the last bit, or a fractional row height makes the scrollbar jitter while the
  // window slides. Clamped because that subtraction can land a float ulp below zero.
  const paddingBottom = Math.max(0, totalHeight - paddingTop - (endIndex - startIndex) * height);

  return { startIndex, endIndex, paddingTop, paddingBottom, totalHeight };
}

function sameWindow(a: VirtualWindow, b: VirtualWindow): boolean {
  return (
    a.startIndex === b.startIndex &&
    a.endIndex === b.endIndex &&
    a.paddingTop === b.paddingTop &&
    a.paddingBottom === b.paddingBottom &&
    a.totalHeight === b.totalHeight
  );
}

/**
 * The element a ref currently points at, as state, so effects can key off it.
 *
 * A ref object does not notify on assignment. React fills it in during the commit that mounts the
 * element, which is before effects run, so re-reading it on every commit catches the usual case;
 * the one retry frame covers an element that mounts in a commit this component did not take part
 * in (a scroll viewport owned by a child, for instance). Retrying only while still null keeps
 * this from becoming a permanent rAF loop.
 */
function useTrackedElement(ref: React.RefObject<HTMLElement | null>): HTMLElement | null {
  const [element, setElement] = React.useState<HTMLElement | null>(null);

  React.useEffect(() => {
    // Returning prev is a bail-out, not a re-render, so running this every commit is free.
    const sync = () => setElement((prev) => (prev === ref.current ? prev : ref.current));
    sync();
    if (ref.current) return;
    const frame = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(frame);
  });

  return element;
}

export function useVirtualWindow(options: VirtualWindowOptions): VirtualWindow {
  const {
    scrollRef,
    rowCount,
    rowHeight,
    overscan = DEFAULT_OVERSCAN,
    offsetTop = 0,
  } = options;

  const element = useTrackedElement(scrollRef);
  const [virtualWindow, setVirtualWindow] = React.useState<VirtualWindow>(() =>
    computeWindow(0, 0, rowCount, rowHeight, overscan),
  );

  // Geometry is read through a ref inside the listener so it can change without re-subscribing.
  // rowCount grows once per finished image during a batch; keeping it in the effect's deps meant
  // thousands of removeEventListener/addEventListener + ResizeObserver cycles over a long run.
  const geometry = React.useRef({ rowCount, rowHeight, overscan, offsetTop });
  React.useEffect(() => {
    geometry.current = { rowCount, rowHeight, overscan, offsetTop };
  });

  React.useEffect(() => {
    // setState here is guarded on the window's own fields, so the pass triggered by this first
    // call settles in one extra render instead of looping.
    const measure = () => {
      const g = geometry.current;
      const next = element
        ? computeWindow(
            element.scrollTop - g.offsetTop,
            element.clientHeight,
            g.rowCount,
            g.rowHeight,
            g.overscan,
          )
        : computeWindow(0, 0, g.rowCount, g.rowHeight, g.overscan);
      setVirtualWindow((prev) => (sameWindow(prev, next) ? prev : next));
    };

    measure();
    if (!element) return;

    element.addEventListener('scroll', measure, { passive: true });
    // Catches the container being resized, the pane collapsing at a breakpoint, and the tab
    // panel going from display:none (clientHeight 0) to visible.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      element.removeEventListener('scroll', measure);
      observer.disconnect();
    };
    // Only `element` belongs here: geometry is read through the ref above, so adding a row does
    // not rebuild the subscription. The effect below handles geometry changes.
  }, [element]);

  // Geometry changes still need a recompute, just not a new subscription.
  React.useEffect(() => {
    const el = element;
    const g = geometry.current;
    const next = el
      ? computeWindow(el.scrollTop - g.offsetTop, el.clientHeight, g.rowCount, g.rowHeight, g.overscan)
      : computeWindow(0, 0, g.rowCount, g.rowHeight, g.overscan);
    setVirtualWindow((prev) => (sameWindow(prev, next) ? prev : next));
  }, [element, rowCount, rowHeight, overscan, offsetTop]);

  return virtualWindow;
}

/**
 * Measures a container and reports how many columns of at least minCellWidth fit.
 * Returns 1 until measured, so the first paint is never zero-column.
 */
export function useMeasuredColumns(
  ref: React.RefObject<HTMLElement | null>,
  minCellWidth: number,
  gap: number,
): number {
  const element = useTrackedElement(ref);
  const [columns, setColumns] = React.useState(1);

  React.useEffect(() => {
    if (!element) return;
    const measure = () => {
      const stride = minCellWidth + gap;
      // A hidden tab panel measures 0 wide; falling back to 1 keeps the row count finite so the
      // window stays valid until the panel is shown and the observer fires again.
      // clientWidth includes horizontal padding, which would over-report the usable width and
      // hand back a column too many, making every cell narrower than minCellWidth.
      const style = getComputedStyle(element);
      const inner =
        element.clientWidth -
        (parseFloat(style.paddingLeft) || 0) -
        (parseFloat(style.paddingRight) || 0);
      const next = stride > 0 ? Math.max(1, Math.floor((inner + gap) / stride)) : 1;
      setColumns((prev) => (prev === next ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, minCellWidth, gap]);

  return columns;
}
