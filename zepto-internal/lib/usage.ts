'use client';

// Token-usage ledger for the Azure image calls. Azure's images API reports usage
// (input/output tokens) on every response; /api/generate passes it through and
// lib/pipeline.ts records it here. Stored via writePersisted so the Settings modal's
// Usage pane (a usePersistedState subscriber) updates live as calls complete.
//
// Aggregates only — per-request history would grow without bound in localStorage, and the
// questions this answers ("how much are we spending?", "which product burns it?") only need
// totals per mode since the last reset.

import { readPersisted, writePersisted } from '@/hooks/use-persisted-state';

export const USAGE_KEY = 'skuc_usage';

export type UsageMode = 'edits' | 'generations';

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageLedger {
  /** Epoch ms of the last reset (or first recorded call). */
  since: number;
  byMode: Record<UsageMode, UsageTotals>;
  /**
   * Per-DAY totals, keyed 'YYYY-MM-DD' in local time — what the calendar reads.
   *
   * The file's original rule was "aggregates only, because per-request history grows without
   * bound". That still holds: this is per-day, so it is bounded by the calendar rather than by
   * how hard the tool is used — a year is ~365 small records, and anything older is pruned on
   * write. Optional because ledgers written before this existed have no such field.
   *
   * Local, not UTC: an 11pm batch in IST belongs to the day the person was working, not to
   * tomorrow.
   */
  byDay?: Record<string, UsageTotals>;
}

/** Weeks the calendar shows — 53 so a full year always fits, GitHub-style. */
export const CALENDAR_WEEKS = 53;
const RETAIN_DAYS = CALENDAR_WEEKS * 7;

/** Local 'YYYY-MM-DD'. toISOString would shift the day for anyone east or west of UTC. */
export function dayKey(date: Date): string {
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

const EMPTY_TOTALS: UsageTotals = { requests: 0, inputTokens: 0, outputTokens: 0 };

export function emptyLedger(since = 0): UsageLedger {
  return {
    since,
    byMode: { edits: { ...EMPTY_TOTALS }, generations: { ...EMPTY_TOTALS } },
    byDay: {},
  };
}

/** Azure's usage block, as far as we consume it. Fields are absent on older API versions. */
export interface AzureUsage {
  input_tokens?: number;
  output_tokens?: number;
}

export function recordUsage(mode: UsageMode, usage: AzureUsage | null | undefined): void {
  if (typeof window === 'undefined') return;
  const ledger = readPersisted<UsageLedger>(USAGE_KEY, emptyLedger());
  if (!ledger.since) ledger.since = Date.now();
  const totals = ledger.byMode[mode] ?? { ...EMPTY_TOTALS };
  totals.requests += 1;
  totals.inputTokens += Math.max(0, Math.round(usage?.input_tokens ?? 0));
  totals.outputTokens += Math.max(0, Math.round(usage?.output_tokens ?? 0));
  ledger.byMode[mode] = totals;

  // Same numbers, bucketed by day. Written after the mode totals so a throw here cannot cost
  // the figure the cost estimate is built from.
  const key = dayKey(new Date());
  const byDay = ledger.byDay ?? {};
  const day = byDay[key] ?? { ...EMPTY_TOTALS };
  day.requests += 1;
  day.inputTokens += Math.max(0, Math.round(usage?.input_tokens ?? 0));
  day.outputTokens += Math.max(0, Math.round(usage?.output_tokens ?? 0));
  byDay[key] = day;
  ledger.byDay = pruneDays(byDay);

  writePersisted(USAGE_KEY, ledger);
}

/**
 * Drops days the calendar can no longer show. Runs on write rather than on read so the stored
 * object cannot creep upward while the app sits open on a long session.
 */
function pruneDays(byDay: Record<string, UsageTotals>): Record<string, UsageTotals> {
  const keys = Object.keys(byDay);
  if (keys.length <= RETAIN_DAYS) return byDay;
  const keep = keys.sort().slice(-RETAIN_DAYS);
  return Object.fromEntries(keep.map((k) => [k, byDay[k]]));
}

export function resetUsage(): void {
  writePersisted(USAGE_KEY, emptyLedger(Date.now()));
}

// ---- Cost estimation --------------------------------------------------------
// Azure gpt-image-2 list price, per 1M tokens in USD — flat input/output, no text/image input
// split (unlike gpt-image-1). Verified 2026-08-09 against Azure pricing trackers; the ₹ rate
// is a snapshot of the same date. Estimates only — deployment type, region and agreement all
// move the real bill; update these constants when they drift.
export const PRICE_USD_PER_MTOK = { input: 5.0, output: 10.0 } as const;
export const USD_TO_INR = 95.35;
export const PRICING_ASOF = '9 Aug 2026';

export function costUsd(totals: UsageTotals): number {
  return (
    (totals.inputTokens * PRICE_USD_PER_MTOK.input +
      totals.outputTokens * PRICE_USD_PER_MTOK.output) /
    1_000_000
  );
}

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
});

export function formatInr(usd: number): string {
  return inr.format(usd * USD_TO_INR);
}
