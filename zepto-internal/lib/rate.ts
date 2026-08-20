'use client';

// Requests-per-minute throttle — ONE suite-wide setting, owned by the Settings modal, like
// image quality (lib/quality.ts).
//
// Products already cap CONCURRENCY (parallel lanes via mapWithLimit), but lanes say nothing
// about rate: 6 lanes of fast edits can still trip a deployment's RPM limit. This gate sits in
// lib/pipeline's callAzure/callAzureGenerate — the choke point every Azure image call goes
// through — so one number covers Compose, Cleanup, BG Remover AI fixes and Generate together.
//
// Sliding window over request-start times. 0 (the default) means no throttle, which is the
// pre-setting behavior. The value is re-read on every acquire, so changing it in Settings
// affects calls already queued behind the gate, not just future runs.

import { readPersisted, usePersistedState } from '@/hooks/use-persisted-state';

export const RPM_KEY = 'skuc_requestsPerMin';

/** 0 = unlimited. */
export const DEFAULT_RPM = 0;

/** Sanity cap for the input; Azure image deployments sit far below this. Exported so the
 *  Settings input and this clamp cannot drift apart. */
export const RPM_MAX = 600;

export function clampRpm(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : DEFAULT_RPM;
  return Math.max(0, Math.min(RPM_MAX, n));
}

/** Non-reactive read for lib code (pipeline call sites). Falls back on junk in storage. */
export function readRpm(): number {
  return clampRpm(readPersisted<unknown>(RPM_KEY, DEFAULT_RPM));
}

/** Reactive read/write for the Settings pane. */
export function useRpm() {
  return usePersistedState<number>(RPM_KEY, DEFAULT_RPM);
}

// ---- Parallel requests -------------------------------------------------------------------
// The OTHER knob: how many Azure calls run at once (RPM above paces how often they start).
// Also one suite-wide setting now — it was Generate's and the compositor's per-product fields
// plus BG Remover's AI_EDIT_CONCURRENCY constant.

export const PARALLEL_KEY = 'skuc_parallelRequests';
export const DEFAULT_PARALLEL = 3;
/**
 * Sanity cap only — nothing about Azure or the pipeline breaks above it. It exists so a
 * mistyped 500 cannot open 500 lanes at once. Exported for the same reason as RPM_MAX: the
 * Settings input used to repeat the number as a literal, so raising the clamp here left the
 * field still refusing the value.
 */
export const PARALLEL_MAX = 32;

export function clampParallel(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : DEFAULT_PARALLEL;
  return Math.max(1, Math.min(PARALLEL_MAX, n));
}

/** Non-reactive read for run starts (mapWithLimit lane counts). */
export function readParallel(): number {
  const v = readPersisted<unknown>(PARALLEL_KEY, null);
  if (typeof v === 'number') return clampParallel(v);
  // Migration: honor whichever per-product field the user had tuned. Max of the two — a user
  // who raised either one had headroom on their deployment.
  const legacyAzure = readPersisted<unknown>('skuc_azureParallel', null);
  const legacyGen = readPersisted<unknown>('skuc_genParallel', null);
  const legacy = [legacyAzure, legacyGen].filter((n): n is number => typeof n === 'number');
  return legacy.length ? clampParallel(Math.max(...legacy)) : DEFAULT_PARALLEL;
}

/** Reactive read/write for the Settings pane (legacy-aware fallback, like useImageQuality). */
export function useParallel() {
  return usePersistedState<number>(PARALLEL_KEY, readParallel());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    signal?.addEventListener('abort', onAbort);
  });
}

// Start times (ms) of requests admitted in the last minute. Module-level on purpose: every
// product in the tab shares the one window, which is exactly what "suite-wide" means. A second
// tab has its own window — same limitation the usage ledger already accepts.
const admitted: number[] = [];

/**
 * Blocks until the current RPM setting admits another request, then records it. No-op at 0.
 * The check-then-push runs with no await between them, so concurrent lanes can't oversubscribe
 * a slot. Rejects with AbortError if the run's Stop button fires mid-wait.
 */
export async function acquireRpmSlot(signal?: AbortSignal): Promise<void> {
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const rpm = readRpm();
    if (rpm <= 0) break;
    const now = Date.now();
    while (admitted.length && now - admitted[0] >= 60_000) admitted.shift();
    if (admitted.length < rpm) break;
    // Wake just after the oldest admit leaves the window, then re-check — another lane may
    // have taken the slot, or the setting may have changed while we slept.
    await sleep(60_000 - (now - admitted[0]) + 25, signal);
  }
  admitted.push(Date.now());
}
