import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  buildChildEnv,
  killAllChildrenSync,
  liveChildPids,
  markWorkerStopping,
  runClaude,
  type ClaudeRunSpec,
} from '../worker/lib/claude.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fixtures', 'fake-claude.mjs');

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
  markWorkerStopping(false);
  killAllChildrenSync();
});

function spec(prompt: string, over: Partial<ClaudeRunSpec> = {}): ClaudeRunSpec {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-sd-'));
  tmpDirs.push(cwd);
  return {
    claudeBin: FAKE,
    cwd,
    prompt,
    model: 'haiku',
    maxTurns: 2,
    tools: [],
    allowedTools: [],
    disallowedTools: [],
    mcpConfigPath: '/abs/mcp.json',
    settingsPath: '/abs/worker-settings.json',
    timeoutMs: 30_000,
    env: buildChildEnv(process.env, { TASK_ID: 't1', STAGE: 'NOOP', DRY_RUN: true }),
    ...over,
  };
}

/** Waits until the fake child has started (it logs its call before hanging). */
async function waitForChild(cwd: string): Promise<number> {
  const file = path.join(cwd, '.fake-claude-calls.jsonl');
  for (let i = 0; i < 100; i++) {
    const pids = liveChildPids();
    if (pids.length > 0 && fs.existsSync(file)) return pids[0]!;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('child did not start');
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('shutdown handling', () => {
  it('a child that dies on SIGINT while the worker is stopping is aborted, not a counted failure', async () => {
    const s = spec('[fake:hang]');
    const p = runClaude(s);
    const pid = await waitForChild(s.cwd);
    markWorkerStopping();
    process.kill(-pid, 'SIGINT'); // what pm2's treekill does to every descendant
    const r = await p;
    expect(r.kind).toBe('aborted');
  });

  it('the same SIGINT with no shutdown in progress stays an error', async () => {
    const s = spec('[fake:hang]');
    const p = runClaude(s);
    const pid = await waitForChild(s.cwd);
    process.kill(-pid, 'SIGINT');
    const r = await p;
    expect(r.kind).toBe('error');
  });

  it('killAllChildrenSync SIGKILLs live children even if they ignore SIGTERM', async () => {
    const s = spec('[fake:hang_ignore_term]');
    const p = runClaude(s);
    const pid = await waitForChild(s.cwd);
    expect(alive(pid)).toBe(true);
    killAllChildrenSync();
    const r = await p;
    expect(r.kind).toBe('error');
    expect(alive(pid)).toBe(false);
    expect(liveChildPids()).toEqual([]);
  });
});
