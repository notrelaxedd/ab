import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { WorkerConfig } from './lib/config.js';
import {
  completeTask,
  deferTask,
  failTask,
  getSettings,
  getVenture,
  pauseAiUntil,
  releaseTask,
  type Sql,
} from './lib/db.js';
import { buildChildEnv, runStage as defaultRunStage, type ClaudeRunSpec } from './lib/claude.js';
import { log } from './lib/log.js';
import { deferUntil, retryDelayMs } from './policy.js';
import { getStage as defaultGetStage } from './stages/registry.js';
import type { ClaudeStageDef, CodeStageDef, StageContext, StageDef } from './stages/types.js';
import type { SettingsRow, TaskOutcome, TaskRow, VentureRow } from './types.js';

export interface ExecuteDeps {
  sql: Sql;
  config: WorkerConfig;
  /** Injectable so tests never spawn Claude. */
  runStage?: typeof defaultRunStage;
  getStage?: (name: string) => StageDef | undefined;
  now?: () => Date;
  /** Parent env for buildChildEnv. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Per-stage MCP config written under .generated/mcp/. Phase 1 has no MCP-enabled stages,
 * so anything other than an empty server list fails closed.
 */
export async function writeStageMcpConfig(def: ClaudeStageDef, repoRoot: string): Promise<string> {
  if (def.mcpServers.length > 0) {
    throw new Error(`stage ${def.name} requests MCP servers; per-stage MCP configs land in Phase 2`);
  }
  const dir = path.join(repoRoot, '.generated', 'mcp');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${def.name}.json`);
  // Same-stage tasks share this file while a claude child may be reading it: replace it atomically.
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify({ mcpServers: {} }, null, 2) + '\n');
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
  return file;
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Builds the exact ClaudeRunSpec for a stage run. Exported for scripts/smoke-noop.ts. */
export async function buildClaudeSpec(
  def: ClaudeStageDef,
  ctx: StageContext,
  config: Pick<WorkerConfig, 'claudeBin' | 'repoRoot'>,
  env: NodeJS.ProcessEnv,
  dryRun: boolean,
): Promise<ClaudeRunSpec> {
  const claudeMd = await readIfExists(path.join(config.repoRoot, 'CLAUDE.md'));
  const stagePrompt = await fs.readFile(path.join(config.repoRoot, def.promptFile), 'utf8');
  const jsonSchema: Record<string, unknown> = { ...z.toJSONSchema(def.outputSchema) };
  // The $schema URI (draft 2020-12) is not needed and some validators reject it.
  delete jsonSchema.$schema;
  return {
    claudeBin: config.claudeBin,
    cwd: ctx.cwd,
    prompt: def.buildPrompt(ctx),
    appendSystemPrompt: claudeMd ? `${claudeMd}\n\n${stagePrompt}` : stagePrompt,
    model: def.model,
    maxTurns: def.maxTurns,
    tools: def.tools,
    allowedTools: def.allowedTools,
    disallowedTools: def.disallowedTools,
    mcpConfigPath: await writeStageMcpConfig(def, config.repoRoot),
    settingsPath: path.join(config.repoRoot, '.claude', 'worker-settings.json'),
    jsonSchema,
    maxBudgetUsd: def.maxBudgetUsd,
    timeoutMs: def.timeoutMs,
    env: buildChildEnv(env, {
      VENTURE_ID: ctx.venture?.id ?? null,
      TASK_ID: ctx.task.id,
      STAGE: def.name,
      DRY_RUN: dryRun,
    }),
    signal: ctx.signal,
  };
}

async function runCodeStage(def: CodeStageDef, ctx: StageContext, signal: AbortSignal): Promise<TaskOutcome> {
  const inner = new AbortController();
  const onAbort = () => inner.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    const outcome = await Promise.race([
      def.run({ ...ctx, signal: inner.signal }).then((output): TaskOutcome => ({ kind: 'done', output })),
      new Promise<TaskOutcome>((resolve) => {
        timer = setTimeout(() => {
          inner.abort();
          resolve({ kind: 'failed', error: `timed out after ${def.timeoutMs}ms` });
        }, def.timeoutMs);
      }),
      new Promise<TaskOutcome>((resolve) => {
        const abortedOutcome: TaskOutcome = { kind: 'aborted', error: 'aborted by worker shutdown' };
        if (signal.aborted) resolve(abortedOutcome);
        else signal.addEventListener('abort', () => resolve(abortedOutcome), { once: true });
      }),
    ]);
    return outcome;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    inner.abort();
  }
}

/** Runs one claimed task and reports what happened. Never throws. */
export async function executeTask(task: TaskRow, deps: ExecuteDeps, signal: AbortSignal): Promise<TaskOutcome> {
  try {
    const def = (deps.getStage ?? defaultGetStage)(task.stage);
    if (!def) return { kind: 'failed', error: `unknown stage: ${task.stage}` };

    const settings: SettingsRow = await getSettings(deps.sql);
    let venture: VentureRow | null = null;
    if (task.venture_id) {
      venture = await getVenture(deps.sql, task.venture_id);
      if (!venture) return { kind: 'failed', error: `venture ${task.venture_id} not found` };
    }
    const cwd = venture
      ? (venture.repo_path ?? path.join(deps.config.venturesDir, venture.slug))
      : path.join(deps.config.venturesDir, '_portfolio');
    await fs.mkdir(cwd, { recursive: true });
    const ctx: StageContext = { task, venture, settings, cwd, signal };

    if (def.kind === 'code') return await runCodeStage(def, ctx, signal);

    const spec = await buildClaudeSpec(def, ctx, deps.config, deps.env ?? process.env, settings.dry_run);
    const r = await (deps.runStage ?? defaultRunStage)(spec, def.outputSchema);
    switch (r.kind) {
      case 'ok':
        return { kind: 'done', output: r.output, sessionId: r.sessionId };
      case 'usage_limit':
        return { kind: 'deferred', error: r.message, resetsAt: r.resetsAt, sessionId: r.sessionId };
      case 'timeout':
        return { kind: 'failed', error: `timed out after ${def.timeoutMs}ms`, sessionId: r.sessionId };
      case 'aborted':
        return { kind: 'aborted', error: r.message, sessionId: r.sessionId };
      case 'error':
        return { kind: 'failed', error: r.message, sessionId: r.sessionId };
      default:
        return { kind: 'failed', error: 'unrecognised stage result' };
    }
  } catch (e) {
    return { kind: 'failed', error: errMsg(e) };
  }
}

export type ApplyResult = 'done' | 'deferred' | 'retry' | 'failed' | 'released' | 'lost_lock';

/** Persists an outcome for a task this worker holds the lock on. */
export async function applyOutcome(
  sql: Sql,
  task: TaskRow,
  workerId: string,
  outcome: TaskOutcome,
  now: Date = new Date(),
): Promise<ApplyResult> {
  const base = { task: task.id, stage: task.stage, venture: task.venture_id, attempt: task.attempt };
  let result: ApplyResult;
  switch (outcome.kind) {
    case 'done': {
      const ok = await completeTask(sql, task.id, workerId, outcome);
      result = ok ? 'done' : 'lost_lock';
      break;
    }
    case 'deferred': {
      const runAfter = deferUntil(now, task.defer_count, outcome.resetsAt);
      const ok = await deferTask(sql, task.id, workerId, {
        runAfter,
        error: outcome.error,
        sessionId: outcome.sessionId,
      });
      // The limit is real whether or not we still hold the lock: stop claiming until it passes.
      await pauseAiUntil(sql, runAfter);
      result = ok ? 'deferred' : 'lost_lock';
      log.warn('usage limit: ai paused', { ...base, until: runAfter.toISOString(), error: outcome.error });
      break;
    }
    case 'failed': {
      result = await failTask(sql, task.id, workerId, {
        error: outcome.error,
        retryDelayMs: retryDelayMs(task.attempt),
        sessionId: outcome.sessionId,
      });
      break;
    }
    case 'aborted': {
      const ok = await releaseTask(sql, task.id, workerId, outcome.error);
      result = ok ? 'released' : 'lost_lock';
      break;
    }
  }
  const level = result === 'failed' || result === 'lost_lock' ? 'error' : 'info';
  log[level]('task outcome', {
    ...base,
    outcome: outcome.kind,
    result,
    ...('error' in outcome ? { error: outcome.error } : {}),
  });
  return result;
}
