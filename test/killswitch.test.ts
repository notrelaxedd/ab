import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { claimTask, enqueueTask, setKillSwitch } from '../worker/lib/db.js';
import { Worker } from '../worker/loop.js';
import { stageTimeoutMs } from '../worker/stages/registry.js';

process.env.LOG_LEVEL ??= 'error';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.cleanup();
});

describe('kill switch', () => {
  it('stops claiming on the next tick and in SQL, and resumes when switched off', async () => {
    const executed: string[] = [];
    const worker = new Worker({
      sql: db.sql,
      workerId: 'ks-worker',
      tickMs: 1000,
      stageTimeoutMs,
      execute: async (task) => {
        executed.push(task.id);
        return { kind: 'done', output: { ok: true } };
      },
    });

    const first = await enqueueTask(db.sql, { stage: 'NOOP' });
    const t1 = await worker.tick();
    expect(t1.claimed).toEqual([first]);
    await worker.idle();

    await setKillSwitch(db.sql, true);
    const later = [
      await enqueueTask(db.sql, { stage: 'NOOP' }),
      await enqueueTask(db.sql, { stage: 'NOOP' }),
    ];
    const t2 = await worker.tick();
    expect(t2).toEqual({ claimed: [], skipped: 'kill_switch' });
    expect(await claimTask(db.sql, 'someone-else')).toBeNull();
    const pending = await db.sql`select count(*)::int as n from tasks where status = 'pending'`;
    expect(pending[0]!.n).toBe(2);

    await setKillSwitch(db.sql, false);
    const t3 = await worker.tick();
    expect(t3.claimed.sort()).toEqual([...later].sort());
    await worker.idle();
    expect(executed).toHaveLength(3);
  });
});
