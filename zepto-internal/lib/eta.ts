// Estimated time remaining for a batch run.
//
// Overall throughput — elapsed / finished * remaining — rather than per-item timing: the
// suite's batches run N items in parallel lanes (lib/rate.ts, the bg worker pool), where
// summing per-item durations overcounts the overlapped waits. Throughput self-corrects as
// the run proceeds and needs nothing but the completion counter the progress text already
// tracks. No estimate before the first completion: with zero data points, showing anything
// would just be noise that immediately jumps.

export interface EtaTracker {
  /** "~3m 20s left", or null before the first completion / after the last. */
  remaining(finished: number, total: number): string | null;
}

export function createEta(): EtaTracker {
  const startedAt = performance.now();
  return {
    remaining(finished, total) {
      if (finished <= 0 || finished >= total) return null;
      const elapsed = performance.now() - startedAt;
      return `~${formatDuration((elapsed / finished) * (total - finished))} left`;
    },
  };
}

/** 42s · 3m 20s · 1h 5m — coarse on purpose; an ETA pretending to second-precision at the
    hour scale reads as false confidence. */
export function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}
