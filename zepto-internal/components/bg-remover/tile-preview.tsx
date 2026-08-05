'use client';

// Presentational preview of a safe-area tile. The canvas holds the real exported artwork and
// nothing else: the checkerboard is CSS behind it and the safe-area / subject rects are DOM
// elements on top, so what you see composited here is never what gets encoded.

import * as React from 'react';
import { cn } from '@/lib/utils';
import {
  planTile,
  renderTile,
  scaleRect,
  TRANSPARENT,
  type Rect,
  type SafeAreaConfig,
  type SubjectBounds,
} from '@/lib/bg/safe-area';

// Same conic-gradient checker the template editor uses, so transparency reads identically
// across the two preview surfaces.
const CHECKERBOARD =
  'repeating-conic-gradient(oklch(0.93 0 0) 0% 25%, #fff 0% 50%) 0 0 / 16px 16px';

const DEFAULT_MAX_SIZE = 320;

export interface TilePreviewProps {
  /** The background-removed cutout. null renders an empty checkerboard tile. */
  source: HTMLCanvasElement | HTMLImageElement | ImageBitmap | null;
  /** Precomputed once by the caller — never re-scan pixels here. */
  bounds: SubjectBounds | null;
  config: SafeAreaConfig;
  /** Dashed safe-area + subject rect overlay. Default true. */
  showOverlay?: boolean;
  /** Longest edge of the rendered preview in CSS px. Default 320. */
  maxSize?: number;
  className?: string;
}

function rectStyle(rect: Rect): React.CSSProperties {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}

export function TilePreview({
  source,
  bounds,
  config,
  showOverlay = true,
  maxSize = DEFAULT_MAX_SIZE,
  className,
}: TilePreviewProps): React.JSX.Element {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  // planTile is canvas-free and allocation-light; safe to run on every config tick.
  const layout = React.useMemo(() => planTile(config, bounds), [config, bounds]);

  const tileW = Math.max(1, Math.round(config.tile.width));
  const tileH = Math.max(1, Math.round(config.tile.height));
  const box = Number.isFinite(maxSize) && maxSize > 0 ? maxSize : DEFAULT_MAX_SIZE;
  const factor = box / Math.max(tileW, tileH);
  const viewW = tileW * factor;
  const viewH = tileH * factor;

  // A preview never needs more pixels than it displays. Rendering at full tile resolution
  // would put a 2048x2048 backing store behind every cell of a batch grid (~16 MB each, and
  // re-rendered on every safe-area tick). Exports call renderTile with the real config, so
  // this only ever shrinks what is on screen.
  const renderConfig = React.useMemo(() => {
    const dpr = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    const scale = Math.min(1, (box * dpr) / Math.max(tileW, tileH));
    if (scale >= 1) return config;
    return {
      ...config,
      tile: { width: config.tile.width * scale, height: config.tile.height * scale },
      // Percent margins are relative and survive scaling untouched; pixel ones must follow.
      margins:
        config.marginUnit === 'px'
          ? {
              top: config.margins.top * scale,
              right: config.margins.right * scale,
              bottom: config.margins.bottom * scale,
              left: config.margins.left * scale,
            }
          : config.margins,
    };
  }, [config, box, tileW, tileH]);

  // Layout effect, not a passive effect: the canvas pixels and the overlay rects must land in
  // the same paint, otherwise dragging a slider shows the subject lagging its own outline.
  React.useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // The canvas instance is reused across renders — renderTile resizes and clears it in place.
    if (source) {
      renderTile(source, renderConfig, { bounds, canvas });
      return;
    }
    const w = Math.max(1, Math.round(renderConfig.tile.width));
    const h = Math.max(1, Math.round(renderConfig.tile.height));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    if (config.background !== TRANSPARENT) {
      ctx.fillStyle = config.background;
      ctx.fillRect(0, 0, w, h);
    }
  }, [source, bounds, config, renderConfig]);

  const safeView = scaleRect(layout.safe, factor);
  const subject = layout.subject;
  const subjectView = subject ? scaleRect(subject, factor) : null;
  // null means "no subject at all". A subject scaled to nothing (fill 0, or margins that ate the
  // safe area) still exists and must not be reported as missing.
  const scalePct = subject ? Math.round(subject.scale * 100) : null;

  return (
    <div className={cn('flex w-full flex-col items-center', className)}>
      {/* No corner rounding: the tile's own edge pixels are part of the artwork. */}
      <div
        className="relative overflow-hidden ring-1 ring-border"
        style={{ width: viewW, height: viewH, background: CHECKERBOARD }}
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`Tile preview, ${tileW} by ${tileH} pixels`}
          className="absolute inset-0 block h-full w-full"
        />
        {showOverlay && (
          <div className="pointer-events-none absolute inset-0" aria-hidden="true">
            <div
              className="absolute border border-dashed border-primary/70"
              style={rectStyle(safeView)}
            />
            {subjectView && subjectView.width >= 1 && subjectView.height >= 1 && (
              <div
                className="absolute border border-foreground/25"
                style={rectStyle(subjectView)}
              />
            )}
          </div>
        )}
      </div>
      <div className="mt-2 text-center text-[11px] text-muted-foreground tabular-nums">
        {tileW} × {tileH}
        {scalePct === null ? ' · no subject' : ` · subject ${scalePct}%`}
      </div>
    </div>
  );
}
