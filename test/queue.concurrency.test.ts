import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { claimTask, enqueueTask } from '../worker/lib/db.js';
import { Worker } from '../worker/loop.js';
import { stageTimeoutMs } from '../worker/stages/registry.js';
import type { TaskRow } from '../worker/types.js';

process.env.LOG_LEVEL ??= 'error';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.cleanup();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('queue concurrency', () => {
  it('20 simultaneous claimers get exactly 10 distinct tasks from 10 pending', async () => {
    for (let i = 0; i < 10; i++) await enqueueTask(db.sql, { stage: 'NOOP', input: { i } });
    const pools = Array.from({ length: 20 }, () => db.connect(1));
    const results = await Promise.all(pools.map((p, i) => claimTask(p, `racer-${i}`)));
    const ids = results.filter((r): r is TaskRow => r !== null).map((r) => r.id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    expect(results.filter((r) => r === null)).toHaveLength(10);
    const rows = await db.sql`select status, attempt from tasks`;
    expect(rows.every((r) => r.status === 'running' && r.attempt === 1)).toBe(true);
  });

  it('two workers with separate pools run each of 40 tasks exactly once', async () => {
    await db.sql`delete from tasks`;
    await db.sql`update settings set max_concurrency = 4 where id = 1`;
    const total = 40;
    for (let i = 0; i < total; i++) await enqueueTask(db.sql, { stage: 'NOOP', input: { i } });

    const executions = new Map<string, number>();
    const byWorker = new Map<string, number>();
    const makeWorker = (workerId: string) =>
      new Worker({
        sql: db.connect(5),
        workerId,
        tickMs: 1000,
        stageTimeoutMs,
        execute: async (task) => {
          executions.set(task.id, (executions.get(task.id) ?? 0) + 1);
          byWorker.set(workerId, (byWorker.get(workerId) ?? 0) + 1);
          await sleep(((Number(task.input.i) * 7) % 5) * 6 + 2);
          return { kind: 'done', output: { ok: true, echo: String(task.input.i) } };
        },
      });
    const a = makeWorker('worker-a');
    const b = makeWorker('worker-b');

    const deadline = Date.now() + 20_000;
    for (;;) {
      await Promise.all([a.tick(), b.tick()]);
      const [{ open }] = (await db.sql`
        select count(*)::int as open from tasks where status not in ('done', 'failed')`) as unknown as [{ open: number }];
      if (open === 0) break;
      if (Date.now() > deadline) throw new Error('tasks did not finish in time');
      await sleep(10);
    }
    await Promise.all([a.idle(), b.idle()]);

    expect(executions.size).toBe(total);
    expect([...executions.values()].every((n) => n === 1)).toBe(true);
    const rows = await db.sql`select status, attempt from tasks`;
    expect(rows).toHaveLength(total);
    expect(rows.every((r) => r.status === 'done' && r.attempt === 1)).toBe(true);
    expect(byWorker.size).toBe(2);
  });
});
