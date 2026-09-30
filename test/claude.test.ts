import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MIN_CLAUDE_VERSION,
  buildArgs,
  buildChildEnv,
  checkClaudeInstall,
  classifyResult,
  runClaude,
  runStage,
  setKillGraceMsForTests,
  type ClaudeRunSpec,
} from '../worker/lib/claude.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fixtures', 'fake-claude.mjs');
const FIXTURES = path.join(here, 'fixtures', 'claude-results');
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8');

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function baseSpec(over: Partial<ClaudeRunSpec> = {}): ClaudeRunSpec {
  return {
    claudeBin: FAKE,
    cwd: tmpDir(),
    prompt: 'hello [fake:ok]',
    model: 'haiku',
    maxTurns: 2,
    tools: [],
    allowedTools: [],
    disallowedTools: [],
    mcpConfigPath: '/abs/mcp.json',
    settingsPath: '/abs/worker-settings.json',
    timeoutMs: 20_000,
    env: buildChildEnv(process.env, { TASK_ID: 't1', STAGE: 'NOOP', DRY_RUN: true, VENTURE_ID: 'v1' }),
    ...over,
  };
}

function calls(cwd: string): Array<{ argv: string[]; envKeys: string[]; stdin: string; cwd: string }> {
  const f = path.join(cwd, '.fake-claude-calls.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

describe('buildArgs', () => {
  it('emits the required flags and keeps the prompt out of argv', () => {
    const spec = baseSpec({
      prompt: '--dangerous looking prompt',
      appendSystemPrompt: 'be brief',
      jsonSchema: { type: 'object' },
      maxBudgetUsd: 1.5,
      resumeSessionId: 'sess-1',
      tools: ['Read', 'Edit'],
      allowedTools: ['Read', 'Bash(git status)'],
      disallowedTools: ['Bash(curl *)'],
    });
    const a = buildArgs(spec);
    const val = (flag: string) => a[a.indexOf(flag) + 1];
    expect(a).toContain('-p');
    expect(val('--output-format')).toBe('json');
    expect(val('--model')).toBe('haiku');
    expect(val('--max-turns')).toBe('2');
    expect(val('--permission-mode')).toBe('acceptEdits');
    expect(val('--permission-prompts')).toBe('none');
    expect(val('--settings')).toBe('/abs/worker-settings.json');
    expect(val('--setting-sources')).toBe('');
    expect(val('--mcp-config')).toBe('/abs/mcp.json');
    expect(a).toContain('--strict-mcp-config');
    expect(val('--tools')).toBe('Read,Edit');
    const i = a.indexOf('--allowedTools');
    expect(a.slice(i + 1, i + 3)).toEqual(['Read', 'Bash(git status)']);
    expect(val('--disallowedTools')).toBe('Bash(curl *)');
    expect(val('--append-system-prompt')).toBe('be brief');
    expect(val('--json-schema')).toBe('{"type":"object"}');
    expect(val('--max-budget-usd')).toBe('1.5');
    expect(val('--resume')).toBe('sess-1');
    expect(a.join(' ')).not.toContain('dangerous looking prompt');
    expect(a).not.toContain(spec.prompt);
  });

  it('passes the empty string for --tools and omits empty optional flags', () => {
    const a = buildArgs(baseSpec());
    expect(a[a.indexOf('--tools') + 1]).toBe('');
    for (const f of ['--allowedTools', '--disallowedTools', '--append-system-prompt', '--json-schema', '--max-budget-usd', '--resume']) {
      expect(a).not.toContain(f);
    }
  });

  it('never contains dangerous flags', () => {
    const a = buildArgs(baseSpec({ allowedTools: ['Read'] }));
    expect(a).not.toContain('--dangerously-skip-permissions');
    expect(a).not.toContain('--allow-dangerously-skip-permissions');
    expect(a).not.toContain('bypassPermissions');
  });

  it('rejects bad tool patterns and bad values', () => {
    expect(() => buildArgs(baseSpec({ tools: ['--dangerously-skip-permissions'] }))).toThrow();
    expect(() => buildArgs(baseSpec({ allowedTools: ['bypassPermissions'] }))).toThrow();
    expect(() => buildArgs(baseSpec({ allowedTools: ['Bash(a,b)'] }))).toThrow(/comma/);
    expect(() => buildArgs(baseSpec({ disallowedTools: ['Bash(a\nb)'] }))).toThrow(/newline/);
    expect(() => buildArgs(baseSpec({ tools: ['Read,Edit'] }))).toThrow(/comma/);
    expect(() => buildArgs(baseSpec({ settingsPath: 'rel.json' }))).toThrow(/absolute/);
    expect(() => buildArgs(baseSpec({ maxTurns: 0 }))).toThrow();
    expect(() => buildArgs(baseSpec({ model: '--foo' }))).toThrow();
  });
});

describe('buildChildEnv', () => {
  const parent: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    HOME: '/home/x',
    LANG: 'C.UTF-8',
    LC_ALL: 'C',
    HTTPS_PROXY: 'http://proxy',
    https_proxy: 'http://proxy',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    ANTHROPIC_API_KEY: 'sk-secret',
    ANTHROPIC_AUTH_TOKEN: 'tok',
    ANTHROPIC_BASE_URL: 'http://x',
    DATABASE_URL: 'postgres://secret',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    AWS_SECRET_ACCESS_KEY: 'aws',
    TASK_ID: 'parent-task',
  };

  it('strips secrets and keeps allowlisted vars', () => {
    const env = buildChildEnv(parent, { TASK_ID: 't1', STAGE: 'RESEARCH', DRY_RUN: false, VENTURE_ID: 'v9' });
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'DATABASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_SECRET_ACCESS_KEY']) {
      expect(env).not.toHaveProperty(k);
    }
    expect(env).toMatchObject({
      PATH: '/usr/bin', HOME: '/home/x', LANG: 'C.UTF-8', LC_ALL: 'C', HTTPS_PROXY: 'http://proxy',
      https_proxy: 'http://proxy', CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      TASK_ID: 't1', STAGE: 'RESEARCH', DRY_RUN: 'false', VENTURE_ID: 'v9', DISABLE_AUTOUPDATER: '1',
    });
  });

  it('sets VENTURE_ID only when present and DRY_RUN as a string', () => {
    const env = buildChildEnv(parent, { TASK_ID: 't', STAGE: 's', DRY_RUN: true, VENTURE_ID: null });
    expect(env).not.toHaveProperty('VENTURE_ID');
    expect(env.DRY_RUN).toBe('true');
  });
});

describe('classifyResult', () => {
  const run = (stdout: string, extra: { stderr?: string; exitCode?: number | null } = {}) =>
    classifyResult({ stdout, stderr: extra.stderr ?? '', exitCode: extra.exitCode ?? 0, signal: null });

  it('success with structured output', () => {
    const r = run(fixture('success_structured'));
    expect(r).toMatchObject({ kind: 'ok', sessionId: 'fake-session-0001', structuredOutput: { ok: true, echo: 'pong' }, costUsd: 0.0042, numTurns: 1 });
  });

  it('success with text only', () => {
    const r = run(fixture('success_text'));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.structuredOutput).toBeUndefined();
      expect(r.resultText).toContain('```json');
    }
  });

  it('tolerates leading noise lines', () => {
    const r = run('some warning\n' + JSON.stringify(JSON.parse(fixture('success_structured'))) + '\n');
    expect(r.kind).toBe('ok');
  });

  it('usage_limit via blocking_limit', () => {
    const r = run(fixture('usage_limit'), { exitCode: 1 });
    expect(r).toMatchObject({ kind: 'usage_limit', sessionId: 'fake-session-0001' });
    if (r.kind === 'usage_limit') {
      expect(r.message).toContain('hit your limit');
      expect(r.resetsAt).toBeUndefined();
    }
  });

  it('usage_limit via rapid_refill_breaker', () => {
    const o = { ...JSON.parse(fixture('usage_limit')), terminal_reason: 'rapid_refill_breaker', result: 'x' };
    expect(run(JSON.stringify(o), { exitCode: 1 }).kind).toBe('usage_limit');
  });

  it('usage_limit via 429; a 529 overload is an ordinary retryable error', () => {
    expect(run(fixture('rate_limit_429'), { exitCode: 1 }).kind).toBe('usage_limit');
    expect(run(fixture('overloaded_529'), { exitCode: 1 }).kind).toBe('error');
  });

  it('bare status numbers or "overloaded" in crash text without a result object are not usage limits', () => {
    expect(run('', { stderr: 'API Error: 529 overloaded_error', exitCode: 1 }).kind).toBe('error');
    expect(run('', { stderr: 'TypeError at cli.js:429:17\n    at cli.js:529:3', exitCode: 1 }).kind).toBe('error');
  });

  it('usage_limit via status code alone', () => {
    const o = { ...JSON.parse(fixture('rate_limit_429')), result: 'boom', errors: [] };
    expect(run(JSON.stringify(o), { exitCode: 1 }).kind).toBe('usage_limit');
  });

  it('parses the legacy resetsAt suffix', () => {
    const r = run(fixture('legacy_limit'), { exitCode: 1 });
    expect(r.kind).toBe('usage_limit');
    if (r.kind === 'usage_limit') expect(r.resetsAt?.getTime()).toBe(1712345678 * 1000);
  });

  it('usage limit wording on stderr with no result object', () => {
    const r = run('', { stderr: 'Claude AI usage limit reached|1712345678', exitCode: 1 });
    expect(r.kind).toBe('usage_limit');
  });

  it('does not treat a successful result that mentions rate limits as a limit', () => {
    const o = { ...JSON.parse(fixture('success_text')), result: 'Add a rate limit of 429 req/s' };
    expect(run(JSON.stringify(o)).kind).toBe('ok');
  });

  it('other errors carry subtype and terminal_reason', () => {
    const r = run(fixture('error_max_turns'), { exitCode: 1, stderr: 'some stderr' });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.message).toContain('error_max_turns');
      expect(r.message).toContain('max_turns');
      expect(r.message).toContain('some stderr');
    }
  });

  it('garbage, empty output and crashes are errors', () => {
    expect(run('not json at all', { exitCode: 0 }).kind).toBe('error');
    expect(run('', { exitCode: 1, stderr: 'kaboom' })).toMatchObject({ kind: 'error' });
    expect(run('{"type":"assistant"}', { exitCode: 0 }).kind).toBe('error');
    const r = classifyResult({ stdout: '', stderr: 'kaboom', exitCode: null, signal: 'SIGSEGV' });
    expect(r.kind === 'error' && r.message).toContain('SIGSEGV');
  });

  it('a nonzero exit with an ok-looking result is an error', () => {
    expect(run(fixture('success_structured'), { exitCode: 3 }).kind).toBe('error');
  });
});

describe('runClaude against fake-claude', () => {
  afterEach(() => setKillGraceMsForTests());

  it('ok: prompt goes via stdin, env is the allowlist, group leader spawn works', async () => {
    const spec = baseSpec({ prompt: '-weird prompt [fake:ok]' });
    const r = await runClaude(spec);
    expect(r).toMatchObject({ kind: 'ok', structuredOutput: { ok: true, echo: 'pong' } });
    const [call] = calls(spec.cwd);
    expect(call!.stdin).toBe('-weird prompt [fake:ok]');
    expect(call!.argv).not.toContain('-weird prompt [fake:ok]');
    expect(call!.cwd).toBe(fs.realpathSync(spec.cwd));
    expect(call!.envKeys).toEqual(expect.arrayContaining(['TASK_ID', 'STAGE', 'DRY_RUN', 'VENTURE_ID', 'DISABLE_AUTOUPDATER']));
  });

  it('kills processes the child left behind in its group after a normal exit', async () => {
    const spec = baseSpec({ prompt: '[fake:ok_leave_grandchild]' });
    const r = await runClaude(spec);
    expect(r.kind).toBe('ok');
    const pid = Number(fs.readFileSync(path.join(spec.cwd, 'grandchild.pid'), 'utf8'));
    // A SIGKILLed orphan can linger as a zombie if PID 1 does not reap; that still counts as dead.
    const alive = () => {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        return !/^\d+ \(.*\) Z /.test(stat);
      } catch {
        try {
          process.kill(pid, 0);
          return !fs.existsSync('/proc');
        } catch {
          return false;
        }
      }
    };
    for (let i = 0; i < 20 && alive(); i++) await new Promise((res) => setTimeout(res, 50));
    expect(alive()).toBe(false);
  });

  it('child never sees parent secrets', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak';
    process.env.DATABASE_URL = 'postgres://should-not-leak';
    try {
      const spec = baseSpec({ prompt: '[fake:echo_env]' });
      const r = await runClaude(spec);
      expect(r.kind).toBe('ok');
      const keys = calls(spec.cwd)[0]!.envKeys;
      expect(keys).not.toContain('ANTHROPIC_API_KEY');
      expect(keys).not.toContain('DATABASE_URL');
      expect(JSON.stringify(r)).not.toContain('should-not-leak');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.DATABASE_URL;
    }
  });

  it('usage_limit', async () => {
    const r = await runClaude(baseSpec({ prompt: '[fake:usage_limit]' }));
    expect(r.kind).toBe('usage_limit');
  });

  it('rate_limit_429 with nonzero exit', async () => {
    const r = await runClaude(baseSpec({ prompt: '[fake:rate_limit_429]' }));
    expect(r.kind).toBe('usage_limit');
  });

  it('crash', async () => {
    const r = await runClaude(baseSpec({ prompt: '[fake:crash]' }));
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('something exploded');
  });

  it('spawn failure is an error', async () => {
    const r = await runClaude(baseSpec({ claudeBin: '/nonexistent/claude-bin' }));
    expect(r.kind).toBe('error');
  });

  it('timeout kills a hanging child', async () => {
    const spec = baseSpec({ prompt: '[fake:hang]', timeoutMs: 500 });
    const t0 = Date.now();
    const r = await runClaude(spec);
    expect(r.kind).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('timeout escalates to SIGKILL when SIGTERM is ignored', async () => {
    setKillGraceMsForTests(700);
    const spec = baseSpec({ prompt: '[fake:hang_ignore_term]', timeoutMs: 500 });
    const t0 = Date.now();
    const r = await runClaude(spec);
    const dt = Date.now() - t0;
    expect(r.kind).toBe('timeout');
    expect(dt).toBeGreaterThanOrEqual(1_100);
    expect(dt).toBeLessThan(8_000);
  });

  it('abort signal kills the child', async () => {
    const ac = new AbortController();
    const spec = baseSpec({ prompt: '[fake:hang]', signal: ac.signal });
    setTimeout(() => ac.abort(), 400);
    const r = await runClaude(spec);
    expect(r.kind).toBe('aborted');
  });

  it('an already-aborted signal never spawns', async () => {
    const ac = new AbortController();
    ac.abort();
    const spec = baseSpec({ signal: ac.signal });
    const r = await runClaude(spec);
    expect(r.kind).toBe('aborted');
    expect(calls(spec.cwd)).toHaveLength(0);
  });
});

describe('runStage', () => {
  const Out = z.object({ ok: z.literal(true), echo: z.string() });

  it('ok via structured_output', async () => {
    const r = await runStage(baseSpec(), Out);
    expect(r).toMatchObject({ kind: 'ok', output: { ok: true, echo: 'pong' }, resumed: false, sessionId: 'fake-session-0001' });
  });

  it('ok via fenced json block in text', async () => {
    const spec = baseSpec({ prompt: '[fake:ok_text]' });
    const r = await runStage(spec, Out);
    expect(r).toMatchObject({ kind: 'ok', output: { ok: true, echo: 'pong' }, resumed: false });
    expect(calls(spec.cwd)).toHaveLength(1);
  });

  it('invalid then valid resumes exactly once', async () => {
    const spec = baseSpec({ prompt: '[fake:invalid_then_valid]' });
    const r = await runStage(spec, Out);
    expect(r).toMatchObject({ kind: 'ok', output: { ok: true, echo: 'pong' }, resumed: true });
    const cs = calls(spec.cwd);
    expect(cs).toHaveLength(2);
    expect(cs[0]!.argv).not.toContain('--resume');
    const i = cs[1]!.argv.indexOf('--resume');
    expect(cs[1]!.argv[i + 1]).toBe('fake-session-0001');
    expect(cs[1]!.stdin).toMatch(/corrected JSON/);
  });

  it('invalid twice is an error after exactly one correction', async () => {
    const spec = baseSpec({ prompt: '[fake:invalid_twice]' });
    const r = await runStage(spec, Out);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('invalid stage output after one correction');
    expect(calls(spec.cwd)).toHaveLength(2);
  });

  it('schema mismatch in valid JSON triggers a correction with issue summary', async () => {
    const spec = baseSpec({ prompt: '[fake:ok_text]' });
    const Strict = z.object({ ok: z.literal(true), echo: z.string(), extra: z.number() });
    const r = await runStage(spec, Strict);
    expect(r.kind).toBe('error');
    const cs = calls(spec.cwd);
    expect(cs).toHaveLength(2);
    expect(cs[1]!.stdin).toContain('extra');
  });

  it('usage_limit passes through without a correction', async () => {
    const spec = baseSpec({ prompt: '[fake:usage_limit]' });
    const r = await runStage(spec, Out);
    expect(r.kind).toBe('usage_limit');
    expect(calls(spec.cwd)).toHaveLength(1);
  });

  it('timeout passes through', async () => {
    const r = await runStage(baseSpec({ prompt: '[fake:hang]', timeoutMs: 300 }), Out);
    expect(r.kind).toBe('timeout');
  });
});

describe('checkClaudeInstall', () => {
  function wrapper(body: string): string {
    const f = path.join(tmpDir(), 'claude');
    fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return f;
  }

  it('accepts the fake', async () => {
    const r = await checkClaudeInstall(FAKE);
    expect(r.version).toBe('2.1.285');
    expect(MIN_CLAUDE_VERSION).toBe('2.1.285');
  });

  it('rejects an older version', async () => {
    const bin = wrapper(`case "$1" in --version) echo "2.0.9 (Claude Code)";; *) exec "${FAKE}" "$@";; esac`);
    await expect(checkClaudeInstall(bin)).rejects.toThrow(/older than required/);
  });

  it('rejects a help text missing flags and lists them', async () => {
    const bin = wrapper(`case "$1" in --version) echo "2.1.285 (Claude Code)";; *) echo "Usage: claude --print --model";; esac`);
    await expect(checkClaudeInstall(bin)).rejects.toThrow(/--setting-sources.*--permission-prompts|--permission-prompts.*--setting-sources/);
  });

  it('rejects a missing binary', async () => {
    await expect(checkClaudeInstall('/nonexistent/claude')).rejects.toThrow();
  });
});

beforeAll(() => {
  fs.chmodSync(FAKE, 0o755);
});
