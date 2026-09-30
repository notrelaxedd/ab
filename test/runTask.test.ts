import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { REPO_ROOT, type WorkerConfig } from '../worker/lib/config.js';
import type { ClaudeRunSpec, StageRunResult } from '../worker/lib/claude.js';
import { claimTask, enqueueTask, getSettings, getTask, requeueOwnOrphans } from '../worker/lib/db.js';
import { Worker } from '../worker/loop.js';
import { applyOutcome, executeTask, type ExecuteDeps } from '../worker/runTask.js';
import { getStage, stageTimeoutMs } from '../worker/stages/registry.js';
import type { CodeStageDef, StageDef } from '../worker/stages/types.js';
import type { TaskOutcome, TaskRow } from '../worker/types.js';

process.env.LOG_LEVEL ??= 'error';

const MIN = 60_000;
const WORKER = 'rt-worker';

let db: TestDb;
let tmp: string;
let config: WorkerConfig;

beforeAll(async () => {
  db = await createTestDb();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 've-runtask-'));
  const repoRoot = path.join(tmp, 'repo');
  await fs.mkdir(path.join(repoRoot, 'prompts', 'stages'), { recursive: true });
  await fs.copyFile(
    path.join(REPO_ROOT, 'prompts', 'stages', 'NOOP.md'),
    path.join(repoRoot, 'prompts', 'stages', 'NOOP.md'),
  );
  await fs.writeFile(path.join(repoRoot, 'CLAUDE.md'), 'STANDING RULES\n');
  config = {
    databaseUrl: db.url,
    workerId: WORKER,
    tickMs: 1000,
    claudeBin: 'claude-not-used',
    repoRoot,
    venturesDir: path.join(tmp, 'ventures'),
    shutdownGraceMs: 1000,
  };
});
afterAll(async () => {
  await db?.cleanup();
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.sql`delete from tasks`;
  await db.sql`delete from ventures`;
  await db.sql`update settings set ai_paused_until = null, kill_switch = false, max_concurrency = 2 where id = 1`;
});

async function mkVenture(slug: string): Promise<string> {
  const [v] = await db.sql`insert into ventures (slug, name) values (${slug}, ${slug}) returning id`;
  return v!.id as string;
}

async function enqueueAndClaim(opts: { stage?: string; ventureId?: string | null } = {}): Promise<TaskRow> {
  const id = await enqueueTask(db.sql, { stage: opts.stage ?? 'NOOP', ventureId: opts.ventureId ?? null });
  const t = await claimTask(db.sql, WORKER);
  expect(t?.id).toBe(id);
  return t!;
}

const near = (d: Date, expectedMs: number, tolMs = 30_000) =>
  expect(Math.abs(d.getTime() - expectedMs)).toBeLessThan(tolMs);

function idleWorker(): Worker {
  return new Worker({
    sql: db.sql,
    workerId: WORKER,
    tickMs: 1000,
    stageTimeoutMs,
    execute: async () => ({ kind: 'done', output: { ok: true } }),
  });
}

describe('applyOutcome', () => {
  it('done: completes the task with output and session id', async () => {
    const t = await enqueueAndClaim();
    const r = await applyOutcome(db.sql, t, WORKER, { kind: 'done', output: { ok: true, echo: 'x' }, sessionId: 's-1' });
    expect(r).toBe('done');
    const row = (await getTask(db.sql, t.id))!;
    expect(row.status).toBe('done');
    expect(row.output).toEqual({ ok: true, echo: 'x' });
    expect(row.claude_session_id).toBe('s-1');
    expect(row.completed_at).not.toBeNull();
    expect(row.locked_by).toBeNull();
  });

  it('reports lost_lock when another worker holds the task', async () => {
    const t = await enqueueAndClaim();
    expect(await applyOutcome(db.sql, t, 'intruder', { kind: 'done', output: {} })).toBe('lost_lock');
    expect((await getTask(db.sql, t.id))!.status).toBe('running');
  });

  it('failed: returns to pending about 2 minutes out and keeps the attempt', async () => {
    const t = await enqueueAndClaim();
    const r = await applyOutcome(db.sql, t, WORKER, { kind: 'failed', error: 'boom' });
    expect(r).toBe('retry');
    const row = (await getTask(db.sql, t.id))!;
    expect(row.status).toBe('pending');
    expect(row.attempt).toBe(1);
    expect(row.error).toBe('boom');
    near(row.run_after, Date.now() + 2 * MIN);
  });

  it('third counted failure fails the task and pauses the venture', async () => {
    const vid = await mkVenture('fail-venture');
    await enqueueTask(db.sql, { stage: 'NOOP', ventureId: vid });
    const results: string[] = [];
    for (let i = 1; i <= 3; i++) {
      await db.sql`update tasks set run_after = now() where status = 'pending'`;
      const t = (await claimTask(db.sql, WORKER))!;
      expect(t.attempt).toBe(i);
      results.push(await applyOutcome(db.sql, t, WORKER, { kind: 'failed', error: `err ${i}` }));
    }
    expect(results).toEqual(['retry', 'retry', 'failed']);
    const [row] = await db.sql`select status, attempt, error from tasks`;
    expect(row).toMatchObject({ status: 'failed', attempt: 3, error: 'err 3' });
    const [v] = await db.sql`select status, paused_reason from ventures where id = ${vid}`;
    expect(v!.status).toBe('paused');
    expect(v!.paused_reason).toContain('err 3');
  });

  it('aborted: releases to pending and restores the attempt', async () => {
    const t = await enqueueAndClaim();
    expect(t.attempt).toBe(1);
    const r = await applyOutcome(db.sql, t, WORKER, { kind: 'aborted', error: 'shutdown' });
    expect(r).toBe('released');
    const row = (await getTask(db.sql, t.id))!;
    expect(row.status).toBe('pending');
    expect(row.attempt).toBe(0);
    expect(row.locked_by).toBeNull();
  });

  it('deferred: backs off 30 minutes, restores attempt, pauses ai, and the worker claims nothing', async () => {
    const t = await enqueueAndClaim();
    const now = new Date();
    const r = await applyOutcome(db.sql, t, WORKER, { kind: 'deferred', error: 'usage limit reached' }, now);
    expect(r).toBe('deferred');
    const row = (await getTask(db.sql, t.id))!;
    expect(row.status).toBe('deferred');
    expect(row.attempt).toBe(0);
    expect(row.defer_count).toBe(1);
    near(row.run_after, now.getTime() + 30 * MIN, 5_000);
    const s = await getSettings(db.sql);
    expect(s.ai_paused_until).not.toBeNull();
    near(s.ai_paused_until!, now.getTime() + 30 * MIN, 5_000);

    // Even with the task runnable, the pause keeps the worker from claiming.
    await db.sql`update tasks set run_after = now() where id = ${t.id}`;
    const tick = await idleWorker().tick();
    expect(tick).toEqual({ claimed: [], skipped: 'ai_paused' });
    expect((await getTask(db.sql, t.id))!.status).toBe('deferred');
  });

  it('deferred: a later resetsAt extends the wait, and a second deferral doubles it', async () => {
    const t = await enqueueAndClaim();
    const now = new Date();
    await applyOutcome(db.sql, t, WORKER, { kind: 'deferred', error: 'limit', resetsAt: new Date(now.getTime() + 90 * MIN) }, now);
    near((await getTask(db.sql, t.id))!.run_after, now.getTime() + 90 * MIN, 5_000);

    await db.sql`update tasks set run_after = now() where id = ${t.id}`;
    const t2 = (await claimTask(db.sql, WORKER))!;
    expect(t2.defer_count).toBe(1);
    await applyOutcome(db.sql, t2, WORKER, { kind: 'deferred', error: 'limit' }, now);
    const row = (await getTask(db.sql, t.id))!;
    expect(row.defer_count).toBe(2);
    near(row.run_after, now.getTime() + 60 * MIN, 5_000);
  });
});

describe('claiming rules', () => {
  it("never claims a paused venture's tasks", async () => {
    const vid = await mkVenture('paused-venture');
    await db.sql`update ventures set status = 'paused' where id = ${vid}`;
    await enqueueTask(db.sql, { stage: 'NOOP', ventureId: vid });
    expect(await claimTask(db.sql, WORKER)).toBeNull();
    expect(await idleWorker().tick()).toEqual({ claimed: [] });
    await db.sql`update ventures set status = 'active' where id = ${vid}`;
    expect(await claimTask(db.sql, WORKER)).not.toBeNull();
  });

  it('requeueOwnOrphans resets only this worker id', async () => {
    await enqueueTask(db.sql, { stage: 'NOOP' });
    await enqueueTask(db.sql, { stage: 'NOOP' });
    const mine = (await claimTask(db.sql, WORKER))!;
    const theirs = (await claimTask(db.sql, 'other-worker'))!;
    expect(await requeueOwnOrphans(db.sql, WORKER)).toBe(1);
    expect((await getTask(db.sql, mine.id))!.status).toBe('pending');
    expect((await getTask(db.sql, theirs.id))!.status).toBe('running');
  });
});

describe('reaper', () => {
  it('requeues an expired lease from another worker and ignores a fresh one', async () => {
    await enqueueTask(db.sql, { stage: 'NOOP' });
    await enqueueTask(db.sql, { stage: 'NOOP' });
    const stale = (await claimTask(db.sql, 'crashed-worker'))!;
    const fresh = (await claimTask(db.sql, 'live-worker'))!;
    // Lease = 2 runs of (2 min timeout + 15 s kill overhead) + 5 min grace = 9.5 min: 20 minutes old is expired.
    await db.sql`update tasks set locked_at = now() - interval '20 minutes' where id = ${stale.id}`;
    await db.sql`update tasks set locked_at = now() - interval '1 minute' where id = ${fresh.id}`;

    const reaped = await idleWorker().reap();
    expect(reaped).toBe(1);
    const s = (await getTask(db.sql, stale.id))!;
    expect(s.status).toBe('pending');
    expect(s.error).toMatch(/lease expired/);
    expect(s.locked_by).toBeNull();
    expect((await getTask(db.sql, fresh.id))!.status).toBe('running');
  });

  it('fails a task whose expired lease was its last attempt', async () => {
    const vid = await mkVenture('reap-venture');
    await enqueueTask(db.sql, { stage: 'NOOP', ventureId: vid });
    await db.sql`update tasks set attempt = 2`;
    const t = (await claimTask(db.sql, 'crashed-worker'))!;
    expect(t.attempt).toBe(3);
    await db.sql`update tasks set locked_at = now() - interval '1 hour' where id = ${t.id}`;
    await idleWorker().reap();
    expect((await getTask(db.sql, t.id))!.status).toBe('failed');
    const [v] = await db.sql`select status from ventures where id = ${vid}`;
    expect(v!.status).toBe('paused');
  });

  it('does not reap a task this worker is still running', async () => {
    await enqueueTask(db.sql, { stage: 'NOOP' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = new Worker({
      sql: db.sql,
      workerId: WORKER,
      tickMs: 1000,
      stageTimeoutMs,
      execute: async () => {
        await gate;
        return { kind: 'done', output: { ok: true } };
      },
    });
    const { claimed } = await w.tick();
    expect(claimed).toHaveLength(1);
    await db.sql`update tasks set locked_at = now() - interval '1 hour'`;
    expect(await w.reap()).toBe(0);
    release();
    await w.idle();
    expect((await getTask(db.sql, claimed[0]!))!.status).toBe('done');
  });
});

describe('Worker dispatch', () => {
  it('turns a throwing execute into a failed outcome and keeps running', async () => {
    const outcomes: TaskOutcome[] = [];
    await enqueueTask(db.sql, { stage: 'NOOP' });
    const w = new Worker({
      sql: db.sql,
      workerId: WORKER,
      tickMs: 1000,
      stageTimeoutMs,
      execute: async () => {
        throw new Error('kaboom');
      },
      onOutcome: (_t, o) => outcomes.push(o),
    });
    await w.tick();
    await w.idle();
    expect(outcomes).toEqual([{ kind: 'failed', error: 'kaboom' }]);
    const [row] = await db.sql`select status, error from tasks`;
    expect(row).toMatchObject({ status: 'pending', error: 'kaboom' });
  });

  it('respects max_concurrency and ignores overlapping ticks', async () => {
    await db.sql`update settings set max_concurrency = 2 where id = 1`;
    for (let i = 0; i < 5; i++) await enqueueTask(db.sql, { stage: 'NOOP' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = new Worker({
      sql: db.sql,
      workerId: WORKER,
      tickMs: 1000,
      stageTimeoutMs,
      execute: async () => {
        await gate;
        return { kind: 'done', output: { ok: true } };
      },
    });
    const [a, b] = await Promise.all([w.tick(), w.tick()]);
    expect([a.skipped, b.skipped].filter(Boolean)).toEqual(['busy']);
    expect(a.claimed.length + b.claimed.length).toBe(2);
    expect(w.runningCount).toBe(2);
    expect((await w.tick()).claimed).toEqual([]);
    release();
    await w.idle();
  });

  it('stop() aborts tasks that outlive the grace period and releases them', async () => {
    await enqueueTask(db.sql, { stage: 'NOOP' });
    const w = new Worker({
      sql: db.sql,
      workerId: WORKER,
      tickMs: 1000,
      stageTimeoutMs,
      execute: (_t, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ kind: 'aborted', error: 'worker shutting down' }));
        }),
    });
    await w.tick();
    expect(w.runningCount).toBe(1);
    await w.stop(50);
    expect(w.runningCount).toBe(0);
    const [row] = await db.sql`select status, attempt, locked_by from tasks`;
    expect(row).toMatchObject({ status: 'pending', attempt: 0, locked_by: null });
  });
});

describe('executeTask', () => {
  const okResult = (): StageRunResult<unknown> => ({
    kind: 'ok',
    output: { ok: true, echo: 'hi' },
    sessionId: 'sess-1',
    resumed: false,
  });

  function harness(result: StageRunResult<unknown> | (() => Promise<StageRunResult<unknown>>), env: NodeJS.ProcessEnv = {}) {
    const specs: ClaudeRunSpec[] = [];
    const deps: ExecuteDeps = {
      sql: db.sql,
      config,
      env,
      runStage: (async (spec: ClaudeRunSpec) => {
        specs.push(spec);
        return typeof result === 'function' ? result() : result;
      }) as ExecuteDeps['runStage'],
    };
    return { specs, deps };
  }

  const signal = () => new AbortController().signal;

  it('fails closed on an unknown stage', async () => {
    const t = await enqueueAndClaim({ stage: 'BOGUS' });
    const { deps, specs } = harness(okResult());
    const o = await executeTask(t, deps, signal());
    expect(o).toMatchObject({ kind: 'failed' });
    expect((o as { error: string }).error).toMatch(/unknown stage/);
    expect(specs).toHaveLength(0);
    expect(await applyOutcome(db.sql, t, WORKER, o)).toBe('retry');
  });

  it('maps ok to done and builds the spec from the stage definition', async () => {
    await enqueueTask(db.sql, { stage: 'NOOP', input: { message: 'hello there' } });
    const t = (await claimTask(db.sql, WORKER))!;
    const { deps, specs } = harness(okResult());
    const o = await executeTask(t, deps, signal());
    expect(o).toEqual({ kind: 'done', output: { ok: true, echo: 'hi' }, sessionId: 'sess-1' });

    const spec = specs[0]!;
    expect(spec.model).toBe('haiku');
    expect(spec.maxTurns).toBe(2);
    expect(spec.timeoutMs).toBe(120_000);
    expect(spec.tools).toEqual([]);
    expect(spec.claudeBin).toBe('claude-not-used');
    expect(spec.prompt).toContain('hello there');
    expect(spec.appendSystemPrompt).toMatch(/^STANDING RULES\n\n/);
    expect(spec.appendSystemPrompt).toContain('Stage: NOOP');
    expect(spec.cwd).toBe(path.join(config.venturesDir, '_portfolio'));
    expect((await fs.stat(spec.cwd)).isDirectory()).toBe(true);
    expect(spec.settingsPath).toBe(path.join(config.repoRoot, '.claude', 'worker-settings.json'));
    expect(JSON.parse(await fs.readFile(spec.mcpConfigPath, 'utf8'))).toEqual({ mcpServers: {} });
    expect(spec.mcpConfigPath).toBe(path.join(config.repoRoot, '.generated', 'mcp', 'NOOP.json'));
    const schema = spec.jsonSchema as { type?: string; properties?: Record<string, unknown> };
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['echo', 'ok']);
    expect(spec.signal).toBeDefined();
  });

  it('uses the venture slug directory as cwd', async () => {
    const vid = await mkVenture('cwd-venture');
    const t = await enqueueAndClaim({ ventureId: vid });
    const { deps, specs } = harness(okResult());
    await executeTask(t, deps, signal());
    expect(specs[0]!.cwd).toBe(path.join(config.venturesDir, 'cwd-venture'));
    expect(specs[0]!.env.VENTURE_ID).toBe(vid);
  });

  it('maps usage_limit to deferred, with the reset time', async () => {
    const t = await enqueueAndClaim();
    const resetsAt = new Date(Date.now() + 3600_000);
    const { deps } = harness({ kind: 'usage_limit', sessionId: 's2', message: 'limit hit', resetsAt });
    expect(await executeTask(t, deps, signal())).toEqual({
      kind: 'deferred',
      error: 'limit hit',
      resetsAt,
      sessionId: 's2',
    });
  });

  it('maps timeout, aborted and error', async () => {
    const t = await enqueueAndClaim();
    const timeout = await executeTask(t, harness({ kind: 'timeout', sessionId: null, message: 'x' }).deps, signal());
    expect(timeout).toMatchObject({ kind: 'failed', error: 'timed out after 120000ms' });
    const aborted = await executeTask(t, harness({ kind: 'aborted', sessionId: null, message: 'stopped' }).deps, signal());
    expect(aborted).toMatchObject({ kind: 'aborted', error: 'stopped' });
    const error = await executeTask(t, harness({ kind: 'error', sessionId: 's3', message: 'bad output' }).deps, signal());
    expect(error).toMatchObject({ kind: 'failed', error: 'bad output', sessionId: 's3' });
  });

  it('turns a thrown runStage into a failed outcome', async () => {
    const t = await enqueueAndClaim();
    const { deps } = harness(async () => {
      throw new Error('spawn ENOENT');
    });
    expect(await executeTask(t, deps, signal())).toEqual({ kind: 'failed', error: 'spawn ENOENT' });
  });

  it('passes a child env without ANTHROPIC_API_KEY or DATABASE_URL, even when the parent has them', async () => {
    const t = await enqueueAndClaim();
    const { deps, specs } = harness(okResult(), {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      DATABASE_URL: 'postgresql://user:pw@host/db',
      SUPABASE_SERVICE_ROLE_KEY: 'service-secret',
    });
    await executeTask(t, deps, signal());
    const env = specs[0]!.env;
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('DATABASE_URL');
    expect(env).not.toHaveProperty('SUPABASE_SERVICE_ROLE_KEY');
    expect(JSON.stringify(env)).not.toContain('sk-ant-secret');
    expect(JSON.stringify(env)).not.toContain('pw@host');
    expect(env.TASK_ID).toBe(t.id);
    expect(env.STAGE).toBe('NOOP');
    expect(env).toHaveProperty('DRY_RUN');
  });

  it('fails closed when a stage asks for MCP servers', async () => {
    const t = await enqueueAndClaim();
    const base = getStage('NOOP')!;
    if (base.kind !== 'claude') throw new Error('expected claude stage');
    const withMcp: StageDef = { ...base, mcpServers: ['supabase'] };
    const { deps, specs } = harness(okResult());
    const o = await executeTask(t, { ...deps, getStage: () => withMcp }, signal());
    expect(o).toMatchObject({ kind: 'failed' });
    expect((o as { error: string }).error).toMatch(/Phase 2/);
    expect(specs).toHaveLength(0);
  });

  describe('code stages', () => {
    const code = (run: CodeStageDef['run'], timeoutMs = 5_000): StageDef => ({ kind: 'code', name: 'NOOP', timeoutMs, run });

    it('returns done with the stage output', async () => {
      const t = await enqueueAndClaim();
      const def = code(async (ctx) => ({ stage: ctx.task.stage }));
      const o = await executeTask(t, { ...harness(okResult()).deps, getStage: () => def }, signal());
      expect(o).toEqual({ kind: 'done', output: { stage: 'NOOP' } });
    });

    it('times out as a failure and signals the stage', async () => {
      const t = await enqueueAndClaim();
      let stageSignal: AbortSignal | undefined;
      const def = code((ctx) => {
        stageSignal = ctx.signal;
        return new Promise(() => undefined);
      }, 40);
      const o = await executeTask(t, { ...harness(okResult()).deps, getStage: () => def }, signal());
      expect(o).toEqual({ kind: 'failed', error: 'timed out after 40ms' });
      expect(stageSignal?.aborted).toBe(true);
    });

    it('is aborted by the worker signal', async () => {
      const t = await enqueueAndClaim();
      const ctrl = new AbortController();
      const def = code(() => new Promise(() => undefined));
      const p = executeTask(t, { ...harness(okResult()).deps, getStage: () => def }, ctrl.signal);
      setTimeout(() => ctrl.abort(), 20);
      expect(await p).toMatchObject({ kind: 'aborted' });
    });

    it('turns a thrown error into a failed outcome', async () => {
      const t = await enqueueAndClaim();
      const def = code(async () => {
        throw new Error('rule engine broke');
      });
      const o = await executeTask(t, { ...harness(okResult()).deps, getStage: () => def }, signal());
      expect(o).toEqual({ kind: 'failed', error: 'rule engine broke' });
    });
  });

  it('validates that the registry NOOP schema accepts only the expected shape', () => {
    const def = getStage('NOOP')!;
    if (def.kind !== 'claude') throw new Error('expected claude stage');
    expect(def.outputSchema.safeParse({ ok: true, echo: 'x' }).success).toBe(true);
    expect(def.outputSchema.safeParse({ ok: false, echo: 'x' }).success).toBe(false);
    expect(z.toJSONSchema(def.outputSchema)).toBeTruthy();
  });
});
