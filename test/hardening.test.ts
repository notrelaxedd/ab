import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { defaultWorkerId } from '../worker/lib/config.js';
import { acquireWorkerLock, claimTask, enqueueTask, getTask, reapTask, requeueOwnOrphans } from '../worker/lib/db.js';
import { Worker } from '../worker/loop.js';
import { KILL_OVERHEAD_MS } from '../worker/lib/claude.js';
import { LEASE_GRACE_MS, leaseMs } from '../worker/policy.js';
import { writeStageMcpConfig } from '../worker/runTask.js';
import { getStage, stageTimeoutMs } from '../worker/stages/registry.js';
import type { ClaudeStageDef } from '../worker/stages/types.js';

process.env.LOG_LEVEL ??= 'error';

const WORKER = 'hard-worker';
let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`delete from tasks`;
  await db.sql`delete from ventures`;
});

describe('worker id', () => {
  it('uses hostname:pm_id under pm2 and a per-process id otherwise', () => {
    expect(defaultWorkerId({ pm_id: '0' }, 111)).toMatch(/:0$/);
    const a = defaultWorkerId({}, 111);
    const b = defaultWorkerId({}, 222);
    expect(a).not.toBe(b);
    expect(a).not.toBe(defaultWorkerId({ pm_id: '0' }, 111));
  });

  it('advisory lock: a second process with the same id is refused until the first releases', async () => {
    const first = await acquireWorkerLock(db.url, 'lock-id');
    expect(first).not.toBeNull();
    expect(await acquireWorkerLock(db.url, 'lock-id')).toBeNull();
    const other = await acquireWorkerLock(db.url, 'other-id');
    expect(other).not.toBeNull();
    await first!.release();
    const again = await acquireWorkerLock(db.url, 'lock-id');
    expect(again).not.toBeNull();
    await again!.release();
    await other!.release();
  });

  it('advisory lock: onLost fires when the connection dies, not on release', async () => {
    let lost = 0;
    const l = await acquireWorkerLock(db.url, 'lost-id', () => lost++);
    await l!.release();
    expect(lost).toBe(0);

    const l2 = await acquireWorkerLock(db.url, 'lost-id-2', () => lost++);
    await db.sql`select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and granted and pid <> pg_backend_pid()`;
    for (let i = 0; i < 50 && lost === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(lost).toBe(1);
    await l2!.release().catch(() => undefined);
  });
});

describe('requeueOwnOrphans and the attempt limit', () => {
  it('fails an orphan that has used all attempts and pauses its venture', async () => {
    const [v] = await db.sql`insert into ventures (slug, name) values ('orphan-venture', 'o') returning id`;
    const vid = v!.id as string;
    await enqueueTask(db.sql, { stage: 'NOOP', ventureId: vid });
    await db.sql`update tasks set attempt = 2`;
    const t = (await claimTask(db.sql, WORKER))!;
    expect(t.attempt).toBe(3);
    expect(await requeueOwnOrphans(db.sql, WORKER)).toBe(1);
    expect((await getTask(db.sql, t.id))!.status).toBe('failed');
    const [after] = await db.sql`select status from ventures where id = ${vid}`;
    expect(after!.status).toBe('paused');
  });

  it('a crash loop ends: each restart counts an attempt until the task fails', async () => {
    await enqueueTask(db.sql, { stage: 'NOOP' });
    const statuses: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await claimTask(db.sql, WORKER);
      if (!t) break;
      await requeueOwnOrphans(db.sql, WORKER); // "worker died during the task, then restarted"
      statuses.push((await getTask(db.sql, t.id))!.status);
    }
    expect(statuses).toEqual(['pending', 'pending', 'failed']);
  });
});

describe('reaper lease', () => {
  it('covers two full runs (first plus correction) of the stage timeout', () => {
    const t = stageTimeoutMs('NOOP');
    expect(leaseMs(t)).toBe(2 * (t + KILL_OVERHEAD_MS) + LEASE_GRACE_MS);
    expect(leaseMs(t)).toBeGreaterThan(2 * t + LEASE_GRACE_MS);
  });

  it('does not reap a task that is past one run but inside the two-run lease', async () => {
    await enqueueTask(db.sql, { stage: 'NOOP' });
    const t = (await claimTask(db.sql, 'other-worker'))!;
    // 2 min timeout: the old lease (timeout + 5 min = 7 min) would reap this; the new one (9.5 min) must not.
    await db.sql`update tasks set locked_at = now() - interval '8 minutes' where id = ${t.id}`;
    const w = new Worker({ sql: db.sql, workerId: WORKER, tickMs: 1000, stageTimeoutMs, execute: async () => ({ kind: 'done', output: null }) });
    expect(await w.reap()).toBe(0);
    expect((await getTask(db.sql, t.id))!.status).toBe('running');
  });

  it('reapTask leaves a task alone if it was re-claimed (fresh lock) after the reaper looked', async () => {
    await enqueueTask(db.sql, { stage: 'NOOP' });
    const t = (await claimTask(db.sql, 'other-worker'))!;
    const cutoff = new Date(Date.now() - 10 * 60_000);
    const r = await reapTask(db.sql, t.id, 'other-worker', { error: 'x', retryDelayMs: 0, lockedBefore: cutoff });
    expect(r).toBe('lost_lock');
    expect((await getTask(db.sql, t.id))!.status).toBe('running');

    await db.sql`update tasks set locked_at = now() - interval '20 minutes' where id = ${t.id}`;
    expect(await reapTask(db.sql, t.id, 'other-worker', { error: 'x', retryDelayMs: 0, lockedBefore: cutoff })).toBe('retry');
  });
});

describe('dispatch guard', () => {
  it('never starts a second run for a task id already running in this process', async () => {
    await enqueueTask(db.sql, { stage: 'NOOP' });
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = new Worker({
      sql: db.sql,
      workerId: WORKER,
      tickMs: 1000,
      stageTimeoutMs,
      execute: async () => {
        runs++;
        await gate;
        return { kind: 'done', output: { ok: true } };
      },
    });
    const { claimed } = await w.tick();
    expect(claimed).toHaveLength(1);
    const row = (await getTask(db.sql, claimed[0]!))!;
    (w as unknown as { dispatch(t: typeof row): void }).dispatch(row);
    expect(runs).toBe(1);
    expect(w.runningCount).toBe(1);
    release();
    await w.idle();
  });
});

describe('writeStageMcpConfig', () => {
  it('replaces the shared file atomically: concurrent writers never expose an empty or partial file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 've-mcp-'));
    try {
      const def = getStage('NOOP') as ClaudeStageDef;
      const file = await writeStageMcpConfig(def, root);
      let writing = true;
      const bad: string[] = [];
      const reader = (async () => {
        while (writing) {
          const txt = await fs.readFile(file, 'utf8');
          try {
            if (JSON.stringify(JSON.parse(txt)) !== '{"mcpServers":{}}') bad.push(txt);
          } catch {
            bad.push(txt);
          }
        }
      })();
      for (let round = 0; round < 20; round++) {
        await Promise.all(Array.from({ length: 10 }, () => writeStageMcpConfig(def, root)));
      }
      writing = false;
      await reader;
      expect(bad).toEqual([]);
      expect((await fs.readdir(path.dirname(file))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
