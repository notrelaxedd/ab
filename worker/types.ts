import { z } from 'zod';

// Every stage the worker knows about. SQL only checks the ^[A-Z_]+$ shape, so
// adding a stage here needs no migration (docs/decisions.md D3).
export const StageName = z.enum([
  'NOOP',
  'IDEATE',
  'RESEARCH',
  'SPEC',
  'BUILD',
  'REVIEW_LAUNCH',
  'LAUNCH',
  'MARKET_CONTENT',
  'MARKET_EMAIL',
  'MARKET_CREATIVE',
  'MARKET_ADS',
  'REVIEW',
  'MEASURE',
  'DECIDE',
  'ITERATE_MARKETING',
  'ITERATE_OFFER',
  'SCALE',
  'OPTIMIZE_ADS',
  'SUPPORT',
  'KILL',
  'DIGEST',
]);
export type StageName = z.infer<typeof StageName>;

export const TaskStatus = z.enum(['pending', 'running', 'done', 'failed', 'deferred']);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const VentureStatus = z.enum(['active', 'paused', 'killed', 'scaling']);
export type VentureStatus = z.infer<typeof VentureStatus>;

export interface TaskRow {
  id: string;
  venture_id: string | null;
  stage: string;
  status: TaskStatus;
  attempt: number;
  defer_count: number;
  run_after: Date;
  claude_session_id: string | null;
  input: Record<string, unknown>;
  output: unknown;
  error: string | null;
  locked_by: string | null;
  locked_at: Date | null;
  dedupe_key: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface SettingsRow {
  kill_switch: boolean;
  dry_run: boolean;
  monthly_budget_usd: number;
  venture_budget_usd: number;
  max_active_ventures: number;
  max_concurrency: number;
  auto_refund_limit_usd: number;
  brand_domain: string | null;
  support_email: string | null;
  owner_email: string | null;
  timezone: string;
  ai_paused_until: Date | null;
}

export interface VentureRow {
  id: string;
  slug: string;
  name: string;
  stage: string;
  status: VentureStatus;
  budget_cap_usd: number;
  repo_path: string | null;
  paused_reason: string | null;
}

/**
 * What running a task produced. The worker persists it with applyOutcome().
 *  - done:     success; output is the stage's validated JSON.
 *  - deferred: usage/rate limit; does NOT count as an attempt.
 *  - failed:   counts as an attempt; retried until MAX_ATTEMPTS, then the venture pauses.
 *  - aborted:  worker shutdown killed it; requeued without counting an attempt.
 */
export type TaskOutcome =
  | { kind: 'done'; output: unknown; sessionId?: string | null }
  | { kind: 'deferred'; error: string; resetsAt?: Date; sessionId?: string | null }
  | { kind: 'failed'; error: string; sessionId?: string | null }
  | { kind: 'aborted'; error: string; sessionId?: string | null };
