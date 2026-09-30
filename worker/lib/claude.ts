// The ONLY module that spawns Claude Code. See docs/decisions.md D16-D24 and BUILD_PROMPT.md §5.
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';

export interface ClaudeRunSpec {
  claudeBin: string;
  cwd: string;
  prompt: string;
  appendSystemPrompt?: string;
  model: string;
  maxTurns: number;
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  mcpConfigPath: string;
  settingsPath: string;
  /** JSON Schema passed to --json-schema (derived from the stage's zod schema). */
  jsonSchema?: object;
  maxBudgetUsd?: number;
  resumeSessionId?: string;
  timeoutMs: number;
  /** Fully-built child environment (from buildChildEnv). Never process.env. */
  env: Record<string, string>;
  signal?: AbortSignal;
}

export type ClaudeRunResult =
  | {
      kind: 'ok';
      sessionId: string | null;
      resultText: string;
      structuredOutput?: unknown;
      costUsd?: number;
      numTurns?: number;
      raw: unknown;
    }
  | { kind: 'usage_limit'; sessionId: string | null; message: string; resetsAt?: Date; raw?: unknown }
  | { kind: 'timeout'; sessionId: string | null; message: string }
  | { kind: 'aborted'; sessionId: string | null; message: string }
  | { kind: 'error'; sessionId: string | null; message: string; raw?: unknown };

export type StageRunResult<T> =
  | { kind: 'ok'; output: T; sessionId: string | null; costUsd?: number; resumed: boolean }
  | Exclude<ClaudeRunResult, { kind: 'ok' }>;

export interface ChildEnvVars {
  VENTURE_ID?: string | null;
  TASK_ID: string;
  STAGE: string;
  DRY_RUN: boolean;
}

/** Oldest Claude Code we have verified the flag set against. */
export const MIN_CLAUDE_VERSION = '2.1.285';

const STDOUT_CAP = 20 * 1024 * 1024;
const STDERR_CAP = 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 10_000;
const CLOSE_WAIT_AFTER_KILL_MS = 5_000;

/** Longest a single runClaude call can outlive its timeoutMs: SIGTERM grace, then the wait for 'close'. */
export const KILL_OVERHEAD_MS = DEFAULT_KILL_GRACE_MS + CLOSE_WAIT_AFTER_KILL_MS;

let killGraceMs = DEFAULT_KILL_GRACE_MS;
/** Test hook: shorten the SIGTERM -> SIGKILL escalation. Pass undefined to restore the default. */
export function setKillGraceMsForTests(ms?: number): void {
  killGraceMs = ms ?? DEFAULT_KILL_GRACE_MS;
}

/**
 * Process groups of live claude children. The children are detached (own group, so a stage timeout can kill
 * their whole tree), which also means they survive the worker unless it kills them: see killAllChildrenSync.
 */
const liveChildren = new Set<number>();
let exitHookInstalled = false;
let workerStopping = false;

export function liveChildPids(): number[] {
  return [...liveChildren];
}

/** SIGKILLs every live child's process group. Synchronous, so it is safe in process 'exit' and fatal paths. */
export function killAllChildrenSync(): void {
  for (const pid of liveChildren) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  liveChildren.clear();
}

/**
 * Tell this module the worker is shutting down. A child that then exits on SIGINT/SIGTERM (e.g. a
 * process-manager signalling the whole tree) is reported as 'aborted' instead of a counted failure.
 */
export function markWorkerStopping(stopping = true): void {
  workerStopping = stopping;
}

const INTERRUPT_SIGNALS = new Set<NodeJS.Signals>(['SIGINT', 'SIGTERM', 'SIGHUP']);
const INTERRUPT_EXIT_CODES = new Set([129, 130, 143]);

/**
 * --setting-sources takes a comma-separated subset of user,project,local; the empty string is accepted
 * and loads none of them (verified against 2.1.285). Managed policy settings and --settings still apply.
 */
const SETTING_SOURCES_NONE = '';

const FORBIDDEN_ARGS = new Set([
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  'bypassPermissions',
]);

function checkPattern(kind: string, p: string): void {
  if (p.length === 0) throw new Error(`empty ${kind} pattern`);
  if (/[,\n\r]/.test(p)) throw new Error(`${kind} pattern must not contain a comma or newline: ${JSON.stringify(p)}`);
  // The flag is variadic: a leading dash would be parsed as the next flag.
  if (p.startsWith('-')) throw new Error(`${kind} pattern must not start with "-": ${JSON.stringify(p)}`);
}

function checkValue(name: string, v: string): void {
  if (v.length === 0 || v.startsWith('-')) throw new Error(`invalid ${name}: ${JSON.stringify(v)}`);
}

/** The prompt is deliberately NOT part of argv: runClaude writes it to stdin. */
export function buildArgs(spec: ClaudeRunSpec): string[] {
  checkValue('model', spec.model);
  if (!Number.isInteger(spec.maxTurns) || spec.maxTurns < 1) throw new Error(`invalid maxTurns: ${spec.maxTurns}`);
  // Relative paths would resolve against the venture dir (cwd), not the repo.
  if (!path.isAbsolute(spec.settingsPath)) throw new Error('settingsPath must be absolute');
  if (!path.isAbsolute(spec.mcpConfigPath)) throw new Error('mcpConfigPath must be absolute');
  for (const t of spec.tools) checkPattern('tool', t);
  for (const t of spec.allowedTools) checkPattern('allowedTools', t);
  for (const t of spec.disallowedTools) checkPattern('disallowedTools', t);

  const args = [
    '-p',
    '--output-format', 'json',
    '--model', spec.model,
    '--max-turns', String(spec.maxTurns),
    '--permission-mode', 'acceptEdits',
    '--permission-prompts', 'none',
    '--settings', spec.settingsPath,
    '--setting-sources', SETTING_SOURCES_NONE,
    '--mcp-config', spec.mcpConfigPath,
    '--strict-mcp-config',
    '--tools', spec.tools.join(','),
  ];
  if (spec.allowedTools.length > 0) args.push('--allowedTools', ...spec.allowedTools);
  if (spec.disallowedTools.length > 0) args.push('--disallowedTools', ...spec.disallowedTools);
  if (spec.appendSystemPrompt) args.push('--append-system-prompt', spec.appendSystemPrompt);
  if (spec.jsonSchema) args.push('--json-schema', JSON.stringify(spec.jsonSchema));
  if (spec.maxBudgetUsd !== undefined) {
    if (!Number.isFinite(spec.maxBudgetUsd) || spec.maxBudgetUsd <= 0) throw new Error('invalid maxBudgetUsd');
    args.push('--max-budget-usd', String(spec.maxBudgetUsd));
  }
  if (spec.resumeSessionId) {
    checkValue('resumeSessionId', spec.resumeSessionId);
    args.push('--resume', spec.resumeSessionId);
  }

  for (const a of args) {
    if (FORBIDDEN_ARGS.has(a)) throw new Error(`forbidden claude argument: ${a}`);
  }
  return args;
}

const ENV_ALLOW = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LANGUAGE', 'TERM', 'TZ', 'TMPDIR', 'TMP', 'TEMP',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
]);

/** Copies only allowlisted variables. Everything else (API keys, DATABASE_URL, cloud creds) is dropped. */
function allowlistedEnv(parent: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    if (ENV_ALLOW.has(k) || k.startsWith('LC_')) env[k] = v;
  }
  return env;
}

export function buildChildEnv(parent: NodeJS.ProcessEnv, vars: ChildEnvVars): Record<string, string> {
  const env = allowlistedEnv(parent);
  env.TASK_ID = vars.TASK_ID;
  env.STAGE = vars.STAGE;
  env.DRY_RUN = vars.DRY_RUN ? 'true' : 'false';
  if (vars.VENTURE_ID) env.VENTURE_ID = vars.VENTURE_ID;
  env.DISABLE_AUTOUPDATER = '1';
  return env;
}

// Only fields we read are named; everything else passes through. Verified against 2.1.285 (strings of the
// binary and a live `--output-format json` result): type, subtype, is_error, result, session_id,
// structured_output, total_cost_usd, num_turns, terminal_reason, api_error_status, errors.
const ResultObjectSchema = z
  .object({
    type: z.literal('result'),
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    result: z.string().nullish(),
    session_id: z.string().nullish(),
    structured_output: z.unknown().optional(),
    total_cost_usd: z.number().nullish(),
    num_turns: z.number().nullish(),
    terminal_reason: z.string().nullish(),
    api_error_status: z.number().nullish(),
    errors: z.array(z.string()).nullish(),
  })
  .passthrough();
type ResultObject = z.infer<typeof ResultObjectSchema>;

// Explicit limit wording only. Bare status numbers (429/529) and "overloaded" are deliberately absent: a
// transient overload or a stack-trace line number must not pause all AI. api_error_status 429 is handled
// separately; 529 is an ordinary retryable error.
const USAGE_LIMIT_RE = /usage limit|hit your limit|rate.?limit|rate_limit_error/i;
const LIMIT_TERMINAL_REASONS = new Set(['blocking_limit', 'rapid_refill_breaker']);

function tail(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? '...' + t.slice(-n) : t;
}

function findResultObject(stdout: string): ResultObject | null {
  const text = stdout.trim();
  if (!text) return null;
  const candidates = [text, ...text.split('\n').reverse()];
  for (const c of candidates) {
    let json: unknown;
    try {
      json = JSON.parse(c.trim());
    } catch {
      continue;
    }
    const parsed = ResultObjectSchema.safeParse(json);
    if (parsed.success) return parsed.data;
  }
  return null;
}

function parseResetsAt(text: string): Date | undefined {
  const m = /\|\s*(\d{9,11})\b/.exec(text);
  if (!m) return undefined;
  const d = new Date(Number(m[1]) * 1000);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function classifyResult(r: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}): ClaudeRunResult {
  const obj = findResultObject(r.stdout);
  const exit = r.signal ? `signal ${r.signal}` : `exit code ${r.exitCode}`;

  if (!obj) {
    const text = `${r.stdout}\n${r.stderr}`;
    if (USAGE_LIMIT_RE.test(text)) {
      return { kind: 'usage_limit', sessionId: null, message: tail(text, 500), resetsAt: parseResetsAt(text) };
    }
    return {
      kind: 'error',
      sessionId: null,
      message: `claude produced no result object (${exit}); stderr: ${tail(r.stderr, 500) || '(empty)'}; stdout: ${tail(r.stdout, 300) || '(empty)'}`,
    };
  }

  const sessionId = obj.session_id ?? null;
  if (obj.is_error === false && r.exitCode === 0 && !r.signal) {
    return {
      kind: 'ok',
      sessionId,
      resultText: obj.result ?? '',
      ...(obj.structured_output !== undefined ? { structuredOutput: obj.structured_output } : {}),
      ...(obj.total_cost_usd != null ? { costUsd: obj.total_cost_usd } : {}),
      ...(obj.num_turns != null ? { numTurns: obj.num_turns } : {}),
      raw: obj,
    };
  }

  const text = [obj.result, ...(obj.errors ?? []), r.stderr].filter(Boolean).join('\n');
  const isLimit =
    (obj.terminal_reason != null && LIMIT_TERMINAL_REASONS.has(obj.terminal_reason)) ||
    obj.api_error_status === 429 ||
    USAGE_LIMIT_RE.test(text);
  if (isLimit) {
    return {
      kind: 'usage_limit',
      sessionId,
      message: tail(obj.result || text, 500) || `usage limit (${obj.terminal_reason ?? obj.api_error_status})`,
      resetsAt: parseResetsAt(text),
      raw: obj,
    };
  }

  const parts = [
    obj.subtype ? `subtype=${obj.subtype}` : null,
    obj.terminal_reason ? `terminal_reason=${obj.terminal_reason}` : null,
    obj.api_error_status != null ? `api_error_status=${obj.api_error_status}` : null,
    exit,
  ].filter(Boolean);
  const detail = tail(obj.result || (obj.errors ?? []).join('; '), 500);
  const err = tail(r.stderr, 300);
  return {
    kind: 'error',
    sessionId,
    message: `claude failed (${parts.join(', ')})${detail ? `: ${detail}` : ''}${err ? `; stderr: ${err}` : ''}`,
    raw: obj,
  };
}

/** Keeps only the last `cap` characters of a stream. */
class TailBuffer {
  private chunks: string[] = [];
  private size = 0;
  constructor(private readonly cap: number) {}
  push(s: string): void {
    this.chunks.push(s);
    this.size += s.length;
    while (this.size > this.cap && this.chunks.length > 1) this.size -= this.chunks.shift()!.length;
    if (this.size > this.cap) {
      const only = this.chunks[0]!.slice(-this.cap);
      this.chunks = [only];
      this.size = only.length;
    }
  }
  toString(): string {
    return this.chunks.join('');
  }
}

export async function runClaude(spec: ClaudeRunSpec): Promise<ClaudeRunResult> {
  const args = buildArgs(spec);
  if (spec.signal?.aborted) return { kind: 'aborted', sessionId: null, message: 'aborted before start' };

  return new Promise<ClaudeRunResult>((resolve) => {
    const stdout = new TailBuffer(STDOUT_CAP);
    const stderr = new TailBuffer(STDERR_CAP);
    let settled = false;
    let killReason: 'timeout' | 'aborted' | null = null;
    let termTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let closeWaitTimer: NodeJS.Timeout | undefined;

    const child = spawn(spec.claudeBin, args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    const pid = child.pid;
    if (pid !== undefined) {
      liveChildren.add(pid);
      if (!exitHookInstalled) {
        exitHookInstalled = true;
        process.on('exit', killAllChildrenSync);
      }
    }

    const cleanup = () => {
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      clearTimeout(closeWaitTimer);
      spec.signal?.removeEventListener('abort', onAbort);
    };
    const settle = (r: ClaudeRunResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(r);
    };
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // already gone
        }
      }
    };
    const terminate = (reason: 'timeout' | 'aborted') => {
      if (killReason || settled) return;
      killReason = reason;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => {
        killGroup('SIGKILL');
        // A grandchild holding the pipes open could delay 'close'; don't wait forever.
        closeWaitTimer = setTimeout(() => settle(killedResult()), CLOSE_WAIT_AFTER_KILL_MS);
      }, killGraceMs);
    };
    const killedResult = (): ClaudeRunResult =>
      killReason === 'timeout'
        ? { kind: 'timeout', sessionId: null, message: `claude exceeded ${spec.timeoutMs} ms and was killed` }
        : { kind: 'aborted', sessionId: null, message: 'claude run aborted' };
    const onAbort = () => terminate('aborted');

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => stdout.push(c));
    child.stderr.on('data', (c: string) => stderr.push(c));
    child.stdin.on('error', () => {
      // EPIPE when the child exits before reading the prompt; the exit status tells the story.
    });
    child.on('error', (err) => {
      if (pid !== undefined) liveChildren.delete(pid);
      settle({ kind: 'error', sessionId: null, message: `failed to spawn ${spec.claudeBin}: ${err.message}` });
    });
    child.on('close', (exitCode, signal) => {
      if (pid !== undefined) liveChildren.delete(pid);
      // Anything still in the group (e.g. a dev server a Bash tool left running) must not outlive the run.
      killGroup('SIGKILL');
      if (killReason) return settle(killedResult());
      const interrupted = (signal !== null && INTERRUPT_SIGNALS.has(signal)) || (exitCode !== null && INTERRUPT_EXIT_CODES.has(exitCode));
      if (interrupted && (workerStopping || spec.signal?.aborted)) {
        return settle({ kind: 'aborted', sessionId: null, message: `claude interrupted by ${signal ?? `exit code ${exitCode}`} during shutdown` });
      }
      settle(classifyResult({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode, signal }));
    });

    termTimer = setTimeout(() => terminate('timeout'), spec.timeoutMs);
    spec.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdin.end(spec.prompt);
  });
}

function extractFencedJson(text: string): string | undefined {
  const re = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi;
  let last: string | undefined;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m[1];
  return last?.trim();
}

function candidateFrom(res: Extract<ClaudeRunResult, { kind: 'ok' }>): { value: unknown } | { error: string } {
  if (res.structuredOutput !== undefined) return { value: res.structuredOutput };
  const raw = extractFencedJson(res.resultText) ?? res.resultText.trim();
  if (!raw) return { error: 'empty result' };
  try {
    return { value: JSON.parse(raw) };
  } catch (e) {
    return { error: `no valid JSON found in result (${(e as Error).message})` };
  }
}

function checkStageOutput<T>(
  res: Extract<ClaudeRunResult, { kind: 'ok' }>,
  schema: z.ZodType<T>,
): { ok: true; value: T } | { ok: false; problem: string } {
  const cand = candidateFrom(res);
  if ('error' in cand) return { ok: false, problem: cand.error };
  const parsed = schema.safeParse(cand.value);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, problem: issues };
}

export async function runStage<T>(spec: ClaudeRunSpec, schema: z.ZodType<T>): Promise<StageRunResult<T>> {
  const first = await runClaude(spec);
  if (first.kind !== 'ok') return first;

  const checked = checkStageOutput(first, schema);
  if (checked.ok) {
    return { kind: 'ok', output: checked.value, sessionId: first.sessionId, costUsd: first.costUsd, resumed: false };
  }
  if (!first.sessionId) {
    return {
      kind: 'error',
      sessionId: null,
      message: `invalid stage output and no session to resume: ${checked.problem}`,
      raw: first.raw,
    };
  }

  const second = await runClaude({
    ...spec,
    resumeSessionId: first.sessionId,
    prompt:
      `Your previous reply did not match the required output format. Problems: ${checked.problem}\n` +
      'Reply again with exactly one corrected JSON block (a single ```json fenced block, nothing else that looks like JSON).',
  });
  if (second.kind !== 'ok') return second;

  const rechecked = checkStageOutput(second, schema);
  if (!rechecked.ok) {
    return {
      kind: 'error',
      sessionId: second.sessionId ?? first.sessionId,
      message: `invalid stage output after one correction: ${rechecked.problem}`,
      raw: second.raw,
    };
  }
  const cost = first.costUsd === undefined && second.costUsd === undefined ? undefined : (first.costUsd ?? 0) + (second.costUsd ?? 0);
  return { kind: 'ok', output: rechecked.value, sessionId: second.sessionId ?? first.sessionId, costUsd: cost, resumed: true };
}

/** Visible flags we pass (--max-turns is hidden from --help, so it is not checked here). */
const REQUIRED_HELP_FLAGS = [
  '--print',
  '--output-format',
  '--model',
  '--permission-mode',
  '--permission-prompts',
  '--settings',
  '--setting-sources',
  '--mcp-config',
  '--strict-mcp-config',
  '--tools',
  '--allowedTools',
  '--disallowedTools',
  '--append-system-prompt',
  '--json-schema',
  '--max-budget-usd',
  '--resume',
];

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function exec(bin: string, args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${bin} ${args.join(' ')} failed: ${err.message}${stderr ? ` (${tail(stderr, 200)})` : ''}`));
      else resolve(stdout);
    });
  });
}

export async function checkClaudeInstall(claudeBin: string): Promise<{ version: string }> {
  const env = allowlistedEnv(process.env);
  env.DISABLE_AUTOUPDATER = '1';
  const problems: string[] = [];

  let version = '';
  try {
    const out = await exec(claudeBin, ['--version'], env);
    const m = /(\d+\.\d+\.\d+)/.exec(out);
    if (!m) problems.push(`could not parse version from: ${tail(out, 100)}`);
    else {
      version = m[1]!;
      if (compareVersions(version, MIN_CLAUDE_VERSION) < 0) {
        problems.push(`claude ${version} is older than required ${MIN_CLAUDE_VERSION}`);
      }
    }
  } catch (e) {
    problems.push((e as Error).message);
  }

  try {
    const help = await exec(claudeBin, ['--help'], env);
    const missing = REQUIRED_HELP_FLAGS.filter((f) => !new RegExp(`(^|[\\s,])${f}(?![\\w-])`, 'm').test(help));
    if (missing.length > 0) problems.push(`--help does not list: ${missing.join(', ')}`);
  } catch (e) {
    problems.push((e as Error).message);
  }

  if (problems.length > 0) throw new Error(`claude install check failed: ${problems.join('; ')}`);
  return { version };
}
