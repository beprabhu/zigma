'use client';

// Image quality — ONE suite-wide setting, owned by the Settings modal.
//
// It used to be three unrelated values: the compositor rode callAzure's 'low' default, BG
// Remover hardcoded 'medium' at its AI-edit call site, and Generate carried its own dropdown
// (skuc_genQuality). Same knob on the same Azure param, three places to look — so it moved
// into Settings and the call sites stopped passing it.
//
// Products should NOT read this directly: lib/pipeline's callAzure/callAzureGenerate fall back
// to readImageQuality() when a caller omits `quality`, so the setting applies everywhere by
// default. The optional param survives only for a caller that must pin a value.

import { readPersisted, usePersistedState } from '@/hooks/use-persisted-state';

export const QUALITY_KEY = 'skuc_imageQuality';

export const QUALITIES = ['low', 'medium', 'high'] as const;
export type ImageQuality = (typeof QUALITIES)[number];

// 'medium' — the highest of the three old defaults, so nothing regresses on upgrade. 'low'
// follows composition instructions noticeably worse, which is exactly what every product's
// prompt is doing.
export const DEFAULT_QUALITY: ImageQuality = 'medium';

export const QUALITY_BLURB: Record<ImageQuality, string> = {
  low: 'Cheapest and fastest. Follows composition instructions noticeably worse.',
  medium: 'Balanced — the suite default.',
  high: 'Best fidelity, slowest, and the most tokens per image.',
};

function isQuality(v: unknown): v is ImageQuality {
  return typeof v === 'string' && (QUALITIES as readonly string[]).includes(v);
}

/** Non-reactive read for lib code (pipeline call sites). Falls back on junk in storage. */
export function readImageQuality(): ImageQuality {
  const v = readPersisted<unknown>(QUALITY_KEY, null);
  if (isQuality(v)) return v;
  // Migration: Generate's old per-product dropdown (skuc_genQuality) was the only place a
  // user could have picked a value — honor it once rather than resetting them to the default.
  const legacy = readPersisted<unknown>('skuc_genQuality', null);
  return isQuality(legacy) ? legacy : DEFAULT_QUALITY;
}

/** Reactive read/write for the Settings pane. */
export function useImageQuality() {
  // readImageQuality (not DEFAULT_QUALITY) as the fallback, so the pane shows the same
  // legacy-migrated value the pipeline would actually send while skuc_imageQuality is unset.
  return usePersistedState<ImageQuality>(QUALITY_KEY, readImageQuality());
}
