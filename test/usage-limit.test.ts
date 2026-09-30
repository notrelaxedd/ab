import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { REPO_ROOT, type WorkerConfig } from '../worker/lib/config.js';
import { enqueueTask, getSettings, getTask } from '../worker/lib/db.js';
import { Worker } from '../worker/loop.js';
import { executeTask } from '../worker/runTask.js';
import { stageTimeoutMs } from '../worker/stages/registry.js';

process.env.LOG_LEVEL ??= 'error';

// End to end with nothing injected: real Worker, real executeTask, real runClaude spawning the fake CLI.

const MIN = 60_000;
const FAKE_CLAUDE = path.join(REPO_ROOT, 'test', 'fixtures', 'fake-claude.mjs');

let db: TestDb;
let tmp: string;
let venturesDir: string;
let config: WorkerConfig;
let worker: Worker;

const SECRET_ENV = { ANTHROPIC_API_KEY: 'sk-ant-test-secret', DATABASE_URL: 'postgresql://secret@db/secret' };
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  db = await createTestDb();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 've-usage-limit-'));
  venturesDir = path.join(tmp, 'ventures');
  config = {
    databaseUrl: db.url,
    workerId: 'ul-worker',
    tickMs: 1000,
    claudeBin: FAKE_CLAUDE,
    repoRoot: REPO_ROOT,
    venturesDir,
    shutdownGraceMs: 1000,
  };
});
afterAll(async () => {
  await db?.cleanup();
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.sql`delete from tasks`;
  await db.sql`update settings set ai_paused_until = null, kill_switch = false, max_concurrency = 2 where id = 1`;
  await fs.rm(venturesDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(SECRET_ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  worker = new Worker({
    sql: db.sql,
    workerId: config.workerId,
    tickMs: config.tickMs,
    stageTimeoutMs,
    execute: (task, signal) => executeTask(task, { sql: db.sql, config }, signal),
  });
});
afterEach(() => {
  for (const k of Object.keys(SECRET_ENV)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const near = (d: Date, expectedMs: number, tolMs = 10_000) =>
  expect(Math.abs(d.getTime() - expectedMs)).toBeLessThan(tolMs);

async function enqueue(t: { stage: string; input: Record<string, unknown> }): Promise<string> {
  const id = await enqueueTask(db.sql, t);
  if (!id) throw new Error('enqueue returned no id');
  return id;
}

async function runOnce(): Promise<string[]> {
  const { claimed } = await worker.tick();
  await worker.idle();
  return claimed;
}

async function readCalls(): Promise<Array<{ argv: string[]; envKeys: string[]; stdin: string }>> {
  const file = path.join(venturesDir, '_portfolio', '.fake-claude-calls.jsonl');
  const text = await fs.readFile(file, 'utf8');
  return text
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

describe.each(['usage_limit', 'rate_limit_429'])('simulated %s', (scenario) => {
  it('defers the task with backoff, pauses the AI and does not claim again until it passes', async () => {
    const id = await enqueue({ stage: 'NOOP', input: { message: `[fake:${scenario}] hello` } });

    expect(await runOnce()).toEqual([id]);
    let t = (await getTask(db.sql, id))!;
    expect(t.status).toBe('deferred');
    expect(t.attempt).toBe(0);
    expect(t.defer_count).toBe(1);
    expect(t.locked_by).toBeNull();
    expect(t.error).toMatch(/limit/i);
    near(t.run_after, Date.now() + 30 * MIN);

    const paused = (await getSettings(db.sql)).ai_paused_until;
    expect(paused).not.toBeNull();
    near(paused!, t.run_after.getTime(), 2_000);

    // While paused the worker claims nothing, even with the task due.
    await db.sql`update tasks set run_after = now() - interval '1 minute' where id = ${id}`;
    const tick = await worker.tick();
    expect(tick).toEqual({ claimed: [], skipped: 'ai_paused' });
    expect((await getTask(db.sql, id))!.status).toBe('deferred');

    // Pause over and task due again: second deferral backs off 60 minutes.
    await db.sql`update settings set ai_paused_until = null where id = 1`;
    expect(await runOnce()).toEqual([id]);
    t = (await getTask(db.sql, id))!;
    expect(t.status).toBe('deferred');
    expect(t.attempt).toBe(0);
    expect(t.defer_count).toBe(2);
    near(t.run_after, Date.now() + 60 * MIN);
    expect((await getSettings(db.sql)).ai_paused_until).not.toBeNull();
  });
});

describe('child process contract', () => {
  it('hides secrets, uses the locked-down flags and feeds the prompt on stdin', async () => {
    expect(process.env.ANTHROPIC_API_KEY).toBe(SECRET_ENV.ANTHROPIC_API_KEY);
    const id = await enqueue({ stage: 'NOOP', input: { message: '[fake:usage_limit] hello' } });
    await runOnce();

    const calls = await readCalls();
    expect(calls).toHaveLength(1);
    const { argv, envKeys, stdin } = calls[0]!;

    expect(envKeys).not.toContain('ANTHROPIC_API_KEY');
    expect(envKeys).not.toContain('DATABASE_URL');
    expect(envKeys).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(envKeys).toEqual(expect.arrayContaining(['TASK_ID', 'STAGE', 'DRY_RUN']));

    expect(argv).toContain('--strict-mcp-config');
    const pp = argv.indexOf('--permission-prompts');
    expect(pp).toBeGreaterThanOrEqual(0);
    expect(argv[pp + 1]).toBe('none');
    expect(argv).not.toContain('--dangerously-skip-permissions');
    expect(argv.join(' ')).not.toContain('bypassPermissions');
    // The prompt is not an argv entry.
    expect(argv.some((a) => a.includes('[fake:usage_limit]'))).toBe(false);

    expect(stdin).toContain('[fake:usage_limit] hello');
    expect((await getTask(db.sql, id))!.status).toBe('deferred');
  });
});

describe('happy path', () => {
  it('runs a NOOP task to done with schema-validated output', async () => {
    const id = await enqueue({ stage: 'NOOP', input: { message: '[fake:ok]' } });
    expect(await runOnce()).toEqual([id]);
    const t = (await getTask(db.sql, id))!;
    expect(t.status).toBe('done');
    expect(t.output).toEqual({ ok: true, echo: 'pong' });
    expect(t.claude_session_id).toBe('fake-session-0001');
    expect(t.error).toBeNull();
    expect((await getSettings(db.sql)).ai_paused_until).toBeNull();
  });
});
