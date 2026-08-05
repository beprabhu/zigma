'use client';

// Windowed results grid. Only the rows on screen are mounted, so a 3,000-image queue costs the
// same as a 30-image one: without this, every cell mounts a canvas AND asks the preview cache to
// decode a bitmap, which is what made the Tile fit tab come up blank on large batches.

import * as React from 'react';

import { useMeasuredColumns, useVirtualWindow } from '@/hooks/use-virtual-window';
import { cn } from '@/lib/utils';

export interface VirtualGridProps<T> {
  items: T[];
  /** The element that scrolls — the results pane, not the grid itself. */
  scrollRef: React.RefObject<HTMLElement | null>;
  /** Narrowest a cell may be before the column count drops. */
  minCellWidth: number;
  gap: number;
  /**
   * Cell height for a given measured cell width. Rows must be uniform for the window arithmetic
   * to hold, so this cannot depend on the individual item.
   */
  cellHeight: (cellWidth: number) => number;
  renderItem: (item: T, index: number) => React.ReactNode;
  keyOf: (item: T, index: number) => React.Key;
  className?: string;
}

export function VirtualGrid<T>({
  items,
  scrollRef,
  minCellWidth,
  gap,
  cellHeight,
  renderItem,
  keyOf,
  className,
}: VirtualGridProps<T>) {
  const gridRef = React.useRef<HTMLDivElement>(null);
  const columns = useMeasuredColumns(gridRef, minCellWidth, gap);
  const [width, setWidth] = React.useState(0);

  React.useEffect(() => {
    const element = gridRef.current;
    if (!element) return;
    const measure = () => setWidth((prev) => (prev === element.clientWidth ? prev : element.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const cellWidth = width ? (width - gap * (columns - 1)) / columns : minCellWidth;
  const rowHeight = Math.max(1, cellHeight(cellWidth) + gap);
  const rowCount = Math.ceil(items.length / columns);

  // How far the grid sits below the top of the scroll container. The Tile fit tab renders a
  // large preview above it, so without this the window would be off by that height.
  const [offsetTop, setOffsetTop] = React.useState(0);
  React.useEffect(() => {
    const element = gridRef.current;
    const scroller = scrollRef.current;
    if (!element || !scroller) return;
    const measure = () => {
      const next = element.offsetTop - (scroller instanceof HTMLElement ? scroller.offsetTop : 0);
      setOffsetTop((prev) => (prev === next ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollRef, items.length]);

  const window = useVirtualWindow({ scrollRef, rowCount, rowHeight, offsetTop });

  const start = window.startIndex * columns;
  const end = Math.min(items.length, window.endIndex * columns);
  const visible = items.slice(start, end);

  return (
    <div ref={gridRef} className={cn('w-full', className)}>
      {window.paddingTop > 0 && <div style={{ height: window.paddingTop }} aria-hidden="true" />}
      <div
        className="grid"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap }}
      >
        {visible.map((item, i) => (
          <React.Fragment key={keyOf(item, start + i)}>{renderItem(item, start + i)}</React.Fragment>
        ))}
      </div>
      {window.paddingBottom > 0 && (
        <div style={{ height: window.paddingBottom }} aria-hidden="true" />
      )}
    </div>
  );
}
