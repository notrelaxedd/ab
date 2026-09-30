import { describe, expect, it } from 'vitest';
import { LEASE_GRACE_MS, MAX_ATTEMPTS, deferDelayMs, deferUntil, retryDelayMs } from '../worker/policy.js';

const MIN = 60_000;

describe('policy', () => {
  it('backs off usage-limit deferrals 30, 60, 120, 240, then caps at 300 minutes', () => {
    expect([0, 1, 2, 3, 4, 5].map((n) => deferDelayMs(n) / MIN)).toEqual([30, 60, 120, 240, 300, 300]);
    expect(deferDelayMs(1000) / MIN).toBe(300);
    expect(deferDelayMs(-3) / MIN).toBe(30);
  });

  it('retries ordinary failures after 2 minutes times the attempt', () => {
    expect(retryDelayMs(1)).toBe(2 * MIN);
    expect(retryDelayMs(2)).toBe(4 * MIN);
    expect(retryDelayMs(0)).toBe(2 * MIN);
    expect(MAX_ATTEMPTS).toBe(3);
    expect(LEASE_GRACE_MS).toBe(5 * MIN);
  });

  it('deferUntil uses the backoff, honours a later resetsAt, and caps at 5 hours', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const at = (ms: number) => new Date(now.getTime() + ms);
    expect(deferUntil(now, 0)).toEqual(at(30 * MIN));
    // reset sooner than the backoff: keep the backoff
    expect(deferUntil(now, 1, at(10 * MIN))).toEqual(at(60 * MIN));
    // reset later than the backoff: wait for it
    expect(deferUntil(now, 0, at(90 * MIN))).toEqual(at(90 * MIN));
    // reset far away: capped at 5 h
    expect(deferUntil(now, 0, at(24 * 60 * MIN))).toEqual(at(300 * MIN));
    // reset in the past is ignored
    expect(deferUntil(now, 2, at(-5 * MIN))).toEqual(at(120 * MIN));
  });
});
