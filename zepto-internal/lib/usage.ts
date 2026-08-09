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
}

const EMPTY_TOTALS: UsageTotals = { requests: 0, inputTokens: 0, outputTokens: 0 };

export function emptyLedger(since = 0): UsageLedger {
  return {
    since,
    byMode: { edits: { ...EMPTY_TOTALS }, generations: { ...EMPTY_TOTALS } },
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
  writePersisted(USAGE_KEY, ledger);
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
