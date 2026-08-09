'use client';

// The right pane's shared "processing space": remove background · tile fit · compress, as one
// hook every product mounts. The hook owns the persisted switches (namespaced per product), the
// section UI, and the apply functions — so the four products cannot drift apart, and a change
// to a step's logic (lib/process.ts, lib/compress.ts) lands everywhere at once.

import * as React from 'react';

import { PanelSection } from '@/components/pane-layout';
import { Field, FieldContent, FieldLabel } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { SafeAreaControls } from '@/components/bg-remover/safe-area-controls';

import { DEFAULT_SAFE_AREA, type SafeAreaConfig } from '@/lib/bg/safe-area';
import {
  COMPRESS_COLOR_CHOICES, COMPRESS_DEFAULT_COLORS, compressPng,
} from '@/lib/compress';
import { isProcessingActive, processCanvas, type ProcessSteps } from '@/lib/process';
import { usePersistedState } from '@/hooks/use-persisted-state';

export interface UseProcessingOptions {
  /** Persisted-key namespace, e.g. 'skuc_gen' — keeps each product's choices its own. */
  prefix: string;
  /** Which sections this product offers. */
  removeBg?: boolean;
  tileFit?: boolean;
  /** Off for the PNG Compressor, whose own settings card IS the compress step. */
  compress?: boolean;
  /** Disables every control (a run is in progress). */
  busy?: boolean;
}

export interface ProcessingApi {
  /** Section UI to mount inside the right pane. */
  panel: React.ReactNode;
  /** The pixel steps (bg removal, tile fit) for lib/process — null tileFit when off. */
  steps: ProcessSteps;
  /** True when any pixel step is on; identity otherwise. */
  stepsActive: boolean;
  /** Applies the pixel steps to a canvas (identity-safe; always returns a fresh canvas). */
  apply: (canvas: HTMLCanvasElement) => Promise<HTMLCanvasElement>;
  /** Compression state + one-call byte step (returns input on disabled). */
  compressOn: boolean;
  compressBytes: (bytes: Uint8Array, signal?: AbortSignal) => Promise<Uint8Array>;
  /** Current safe-area config (for previews) regardless of the tile-fit switch. */
  safeArea: SafeAreaConfig;
  /** One-line summary for panel hints, e.g. "bg · tile · ≤256c". */
  summary: string;
}

export function useProcessing({
  prefix,
  removeBg: offerRemoveBg = false,
  tileFit: offerTileFit = false,
  compress: offerCompress = true,
  busy = false,
}: UseProcessingOptions): ProcessingApi {
  const [removeBg, setRemoveBg] = usePersistedState(`${prefix}ProcRemoveBg`, false);
  const [tileFitOn, setTileFitOn] = usePersistedState(`${prefix}ProcTileFit`, false);
  const [safeArea, setSafeArea] = usePersistedState<SafeAreaConfig>(
    `${prefix}ProcSafeArea`,
    DEFAULT_SAFE_AREA,
  );
  const [compressOn, setCompressOn] = usePersistedState(`${prefix}ProcCompress`, false);
  const [lossless, setLossless] = usePersistedState(`${prefix}ProcLossless`, false);
  const [colors, setColors] = usePersistedState(`${prefix}ProcColors`, COMPRESS_DEFAULT_COLORS);

  const steps: ProcessSteps = React.useMemo(
    () => ({
      removeBg: offerRemoveBg && removeBg,
      tileFit: offerTileFit && tileFitOn ? safeArea : null,
    }),
    [offerRemoveBg, removeBg, offerTileFit, tileFitOn, safeArea],
  );

  const apply = React.useCallback(
    (canvas: HTMLCanvasElement) => processCanvas(canvas, steps),
    [steps],
  );

  const compressActive = offerCompress && compressOn;
  const compressBytes = React.useCallback(
    async (bytes: Uint8Array, signal?: AbortSignal) =>
      compressActive ? compressPng(bytes, { colors, lossless, signal }) : bytes,
    [compressActive, colors, lossless],
  );

  const summary = [
    steps.removeBg && 'bg',
    steps.tileFit && `tile ${safeArea.tile.width}×${safeArea.tile.height}`,
    compressActive && (lossless ? 'lossless' : `≤${colors}c`),
  ]
    .filter(Boolean)
    .join(' · ');

  // Each step is its own titled section with the switch in the heading row, so the right pane
  // reads as a uniform list of named sections (the toggle no longer moonlights as the title).
  // Explanations live in the title tooltips; a section's body only exists while its step is on.
  const panel = (
    <>
      {offerRemoveBg && (
        <PanelSection
          title="Remove background"
          hint="Cleanup's model, applied on export. Weights download once and are shared with that product."
          action={
            <Switch
              aria-label="Remove background"
              checked={removeBg}
              disabled={busy}
              onCheckedChange={(checked) => setRemoveBg(checked === true)}
            />
          }
        />
      )}

      {offerTileFit && (
        <PanelSection
          title="Tile fit"
          hint="Fits the subject into a safe area on a fixed tile — Cleanup's module, same settings shape."
          action={
            <Switch
              aria-label="Tile fit"
              checked={tileFitOn}
              disabled={busy}
              onCheckedChange={(checked) => setTileFitOn(checked === true)}
            />
          }
        >
          {tileFitOn ? (
            <SafeAreaControls
              config={safeArea}
              onChange={setSafeArea}
              onReset={() => setSafeArea(structuredClone(DEFAULT_SAFE_AREA))}
              disabled={busy}
            />
          ) : undefined}
        </PanelSection>
      )}

      {offerCompress && (
        <PanelSection
          title="Compress PNGs"
          hint="pngquant + oxipng on this machine — Compress's exact pipeline, no key, nothing uploaded."
          action={
            <Switch
              aria-label="Compress PNGs"
              checked={compressOn}
              disabled={busy}
              onCheckedChange={(checked) => setCompressOn(checked === true)}
            />
          }
        >
          {compressOn ? (
            <>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor={`${prefix}-proc-lossless`} className="font-normal">
                    Lossless only
                  </FieldLabel>
                </FieldContent>
                <Switch
                  id={`${prefix}-proc-lossless`}
                  checked={lossless}
                  disabled={busy}
                  onCheckedChange={(checked) => setLossless(checked === true)}
                />
              </Field>
              {!lossless && (
                <Field>
                  <FieldLabel htmlFor={`${prefix}-proc-colors`}>Palette colors</FieldLabel>
                  <Select
                    value={String(colors)}
                    onValueChange={(v) => setColors(Number(v) || COMPRESS_DEFAULT_COLORS)}
                    disabled={busy}
                  >
                    <SelectTrigger id={`${prefix}-proc-colors`} className="w-full">
                      <SelectValue>{(v) => `${v} colors`}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {COMPRESS_COLOR_CHOICES.map((c) => (
                        <SelectItem key={c} value={String(c)}>
                          {c} colors{c === COMPRESS_DEFAULT_COLORS ? ' (best quality)' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </>
          ) : undefined}
        </PanelSection>
      )}
    </>
  );

  return {
    panel,
    steps,
    stepsActive: isProcessingActive(steps),
    apply,
    compressOn: compressActive,
    compressBytes,
    safeArea,
    summary,
  };
}
