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
 *
 * Two conditions, not one. The window alone ("at most N starts in any 60s") admits a batch
 * start as one burst — 9 parallel lanes all fire in the same instant, and 9 < 10 is legal.
 * Azure does not meter that way: an S0 deployment enforces RPM in roughly per-second slices
 * of the quota, so 10 RPM really means ~one request every 6 seconds and a 9-wide burst is an
 * instant 429 ("retry after 1 second") even though the minute total is fine. The even-spacing
 * gate below is what matches the meter Azure actually runs; the window is kept as the
 * backstop that makes the setting's plain reading ("no more than N per minute") always true.
 */
export async function acquireRpmSlot(signal?: AbortSignal): Promise<void> {
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    // A 429 anywhere in the tab holds EVERY lane here until Azure's wait is over — checked
    // before the budget, so it applies even when no budget is set.
    const cooling = cooldownUntil - Date.now();
    if (cooling > 0) {
      await sleep(cooling + 25, signal);
      continue;
    }
    const rpm = effectiveRpm();
    if (rpm <= 0) break;
    const now = Date.now();
    while (admitted.length && now - admitted[0] >= 60_000) admitted.shift();
    const last = admitted.length ? admitted[admitted.length - 1] : -Infinity;
    const gap = 60_000 / rpm;
    if (admitted.length < rpm && now - last >= gap) break;
    // Wake at whichever bar clears later — the spacing gap, or the oldest admit leaving the
    // window — then re-check: another lane may have taken the slot, or the setting may have
    // changed while we slept.
    const gapWait = last === -Infinity ? 0 : gap - (now - last);
    const windowWait = admitted.length < rpm ? 0 : 60_000 - (now - admitted[0]);
    await sleep(Math.max(gapWait, windowWait) + 25, signal);
  }
  admitted.push(Date.now());
}

// ---- Backing off after a 429 ---------------------------------------------------------------
// The budget above only helps once someone has set it, and the default is unlimited — which is
// why a fresh install's first big batch is a burst, and a burst is an instant 429 on any real
// deployment. So a 429 teaches the tab two things, both in memory and both for this tab only:
// a cooldown every lane waits out together, and a pace derived from the wait Azure asked for,
// used whenever no budget is set. Neither is written to Settings: a value the user never typed
// must not appear there, and the deployment's limit is Azure's to state, not ours to guess and
// save.

/** Nothing before this may start. Shared by every lane and every product in the tab. */
let cooldownUntil = 0;
/**
 * The pace the deployment actually tolerates, learned from Retry-After. Applies only while the
 * Settings budget is 0, and only tightens — a second 429 with a shorter wait does not loosen it.
 */
let sessionRpm = 0;
/** 429s since the last success, for the fallback back-off when Azure states no wait. */
let streak = 0;

const FALLBACK_WAIT_MS = 5_000;
const MAX_WAIT_MS = 60_000;
/** The realistic S0 pace when Azure gave us nothing to derive one from. */
const FALLBACK_SESSION_RPM = 10;

/**
 * Records a 429 and returns how long the tab will hold before the next request. `retryAfterMs`
 * is Azure's own figure when it stated one (see lib/retry-after.ts), else the wait doubles per
 * consecutive 429. Jittered so repeated penalties never line up to the millisecond.
 */
export function penalize(retryAfterMs: number | null): number {
  streak += 1;
  const asked = retryAfterMs ?? FALLBACK_WAIT_MS * 2 ** (streak - 1);
  const wait = Math.min(MAX_WAIT_MS, Math.round(asked * (0.8 + Math.random() * 0.4)));
  cooldownUntil = Math.max(cooldownUntil, Date.now() + wait);
  if (readRpm() <= 0) {
    const derived = retryAfterMs ? Math.floor(60_000 / Math.max(retryAfterMs, 1_000)) : FALLBACK_SESSION_RPM;
    const paced = Math.max(1, clampRpm(derived));
    sessionRpm = sessionRpm ? Math.min(sessionRpm, paced) : paced;
  }
  return wait;
}

/** A request got through: the back-off ladder resets. The learned pace stays — the limit did not move. */
export function clearPenalty(): void {
  streak = 0;
}

/** The Settings budget when set, else whatever a 429 taught this tab, else unlimited. */
function effectiveRpm(): number {
  const set = readRpm();
  return set > 0 ? set : sessionRpm;
}

/** For progress lines: '' while nothing is throttling, else a short note on what is. */
export function throttleNote(): string {
  const cooling = cooldownUntil - Date.now();
  if (cooling > 0) return `Throttled by Azure — waiting ${Math.ceil(cooling / 1000)}s`;
  if (readRpm() <= 0 && sessionRpm > 0) return `Pacing at ${sessionRpm}/min after a rate limit`;
  return '';
}
