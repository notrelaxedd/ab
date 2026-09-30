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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = EnvSchema.parse(env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    // Stable across pm2 restarts so startup recovery can find this worker's orphans.
    workerId: parsed.WORKER_ID ?? `${os.hostname()}:${env.pm_id ?? '0'}`,
    tickMs: parsed.TICK_MS,
    claudeBin: parsed.CLAUDE_BIN,
    repoRoot: REPO_ROOT,
    venturesDir: parsed.VENTURES_DIR ?? path.join(REPO_ROOT, 'ventures'),
    shutdownGraceMs: parsed.SHUTDOWN_GRACE_MS,
  };
}
