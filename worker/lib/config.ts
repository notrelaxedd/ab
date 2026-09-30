import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Repo root = two levels up from worker/lib (works from both src and dist/).
const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, here.includes(`${path.sep}dist${path.sep}`) ? '../../..' : '../..');

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  WORKER_ID: z.string().min(1).optional(),
  TICK_MS: z.coerce.number().int().min(250).default(60_000),
  CLAUDE_BIN: z.string().min(1).default('claude'),
  VENTURES_DIR: z.string().min(1).optional(),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(45_000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export interface WorkerConfig {
  databaseUrl: string;
  workerId: string;
  tickMs: number;
  claudeBin: string;
  repoRoot: string;
  venturesDir: string;
  shutdownGraceMs: number;
}

/**
 * Stable across pm2 restarts (hostname:pm_id) so startup recovery finds the previous run's orphans. Outside
 * pm2 there is no stable id, so use the pid: a manual run must never share an id with the pm2 worker.
 */
export function defaultWorkerId(env: NodeJS.ProcessEnv, pid: number = process.pid): string {
  const pm = env.pm_id;
  return `${os.hostname()}:${pm !== undefined && pm !== '' ? pm : `pid${pid}`}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = EnvSchema.parse(env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    workerId: parsed.WORKER_ID ?? defaultWorkerId(env),
    tickMs: parsed.TICK_MS,
    claudeBin: parsed.CLAUDE_BIN,
    repoRoot: REPO_ROOT,
    venturesDir: parsed.VENTURES_DIR ?? path.join(REPO_ROOT, 'ventures'),
    shutdownGraceMs: parsed.SHUTDOWN_GRACE_MS,
  };
}
