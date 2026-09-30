import type { Sql } from './lib/db.js';

/** Enqueues recurring work (MEASURE, DIGEST, ...). Filled in by Phase 6. */
export interface Scheduler {
  /** Returns how many tasks were enqueued. Must be idempotent (use dedupe keys). */
  enqueueDue(sql: Sql, now: Date): Promise<number>;
}

export const noopScheduler: Scheduler = {
  async enqueueDue() {
    return 0;
  },
};
