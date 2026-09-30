// Retry / backoff policy in one place so tests and docs can point at it.

export const MAX_ATTEMPTS = 3;

/** Extra time past a stage's timeout before a 'running' task is considered orphaned. */
export const LEASE_GRACE_MS = 5 * 60_000;

const MINUTE = 60_000;
const DEFER_BASE_MS = 30 * MINUTE;
const DEFER_CAP_MS = 5 * 60 * MINUTE;

/**
 * Usage/rate-limit backoff: 30 min, 60, 120, 240, then capped at 5 h.
 * @param deferCountBefore how many times this task was deferred before now.
 */
export function deferDelayMs(deferCountBefore: number): number {
  const n = Math.max(0, Math.floor(deferCountBefore));
  // Guard against 2**large overflowing to Infinity before the cap applies.
  if (n >= 10) return DEFER_CAP_MS;
  return Math.min(DEFER_BASE_MS * 2 ** n, DEFER_CAP_MS);
}

/** Delay before retrying an ordinary failure. attempt is the attempt that just failed (1-based). */
export function retryDelayMs(attempt: number): number {
  return 2 * MINUTE * Math.max(1, attempt);
}

/**
 * When a deferred task may run again. If the limit reports its own reset time and it is
 * later than the backoff, wait for the reset instead (still capped at 5 h).
 */
export function deferUntil(now: Date, deferCountBefore: number, resetsAt?: Date): Date {
  let ms = deferDelayMs(deferCountBefore);
  if (resetsAt) {
    const untilReset = resetsAt.getTime() - now.getTime();
    if (untilReset > ms) ms = Math.min(untilReset, DEFER_CAP_MS);
  }
  return new Date(now.getTime() + ms);
}
