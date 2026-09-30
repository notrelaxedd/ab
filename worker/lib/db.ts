import postgres from 'postgres';
import type { SettingsRow, TaskRow, VentureRow } from '../types.js';
import { MAX_ATTEMPTS } from '../policy.js';

export type Sql = postgres.Sql<Record<string, unknown>>;

/**
 * Direct Postgres connection (Supabase session pooler in production; see
 * docs/decisions.md D1). `prepare: false` keeps it compatible with the
 * transaction-mode pooler too.
 */
export function createDb(databaseUrl: string, opts: { max?: number } = {}): Sql {
  return postgres(databaseUrl, {
    max: opts.max ?? 5,
    prepare: false,
    onnotice: () => {},
    idle_timeout: 30,
    connect_timeout: 15,
  }) as unknown as Sql;
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

export async function getSettings(sql: Sql): Promise<SettingsRow> {
  const rows = await sql`select * from settings where id = 1`;
  const r = rows[0];
  if (!r) throw new Error('settings row missing (run npm run db:migrate)');
  return {
    kill_switch: Boolean(r.kill_switch),
    dry_run: Boolean(r.dry_run),
    monthly_budget_usd: num(r.monthly_budget_usd),
    venture_budget_usd: num(r.venture_budget_usd),
    max_active_ventures: num(r.max_active_ventures),
    max_concurrency: num(r.max_concurrency),
    auto_refund_limit_usd: num(r.auto_refund_limit_usd),
    brand_domain: (r.brand_domain as string | null) ?? null,
    support_email: (r.support_email as string | null) ?? null,
    owner_email: (r.owner_email as string | null) ?? null,
    timezone: String(r.timezone ?? 'UTC'),
    ai_paused_until: (r.ai_paused_until as Date | null) ?? null,
  };
}

export async function setKillSwitch(sql: Sql, on: boolean): Promise<void> {
  await sql`update settings set kill_switch = ${on} where id = 1`;
}

/** Extend (never shorten) the global AI pause after a usage/rate limit. */
export async function pauseAiUntil(sql: Sql, until: Date): Promise<void> {
  await sql`
    update settings
       set ai_paused_until = greatest(coalesce(ai_paused_until, ${until}), ${until})
     where id = 1`;
}

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

export interface EnqueueInput {
  stage: string;
  ventureId?: string | null;
  input?: Record<string, unknown>;
  runAfter?: Date;
  dedupeKey?: string | null;
}

/** Insert a pending task. Returns its id, or null if an open task with the same dedupe key exists. */
export async function enqueueTask(sql: Sql, t: EnqueueInput): Promise<string | null> {
  const rows = await sql`
    insert into tasks (stage, venture_id, input, run_after, dedupe_key)
    values (
      ${t.stage},
      ${t.ventureId ?? null},
      ${sql.json((t.input ?? {}) as postgres.JSONValue)},
      ${t.runAfter ?? sql`now()`},
      ${t.dedupeKey ?? null}
    )
    on conflict (dedupe_key) where dedupe_key is not null and status not in ('done', 'failed')
    do nothing
    returning id`;
  return (rows[0]?.id as string | undefined) ?? null;
}

export async function claimTask(sql: Sql, workerId: string): Promise<TaskRow | null> {
  const rows = await sql<TaskRow[]>`select * from claim_task(${workerId})`;
  return rows[0] ?? null;
}

export async function getTask(sql: Sql, id: string): Promise<TaskRow | null> {
  const rows = await sql<TaskRow[]>`select * from tasks where id = ${id}`;
  return rows[0] ?? null;
}

/** Only the worker that holds the lock may finish a task; returns false if it lost the lock. */
export async function completeTask(
  sql: Sql,
  id: string,
  workerId: string,
  r: { output: unknown; sessionId?: string | null },
): Promise<boolean> {
  const rows = await sql`
    update tasks
       set status = 'done',
           output = ${sql.json((r.output ?? null) as postgres.JSONValue)},
           claude_session_id = coalesce(${r.sessionId ?? null}, claude_session_id),
           completed_at = now(),
           locked_by = null,
           locked_at = null,
           error = null
     where id = ${id} and status = 'running' and locked_by = ${workerId}
    returning id`;
  return rows.length > 0;
}

/**
 * Usage/rate limit: back to the queue as 'deferred' without counting the attempt
 * (claim_task incremented it, so decrement here).
 */
export async function deferTask(
  sql: Sql,
  id: string,
  workerId: string,
  r: { runAfter: Date; error: string; sessionId?: string | null },
): Promise<boolean> {
  const rows = await sql`
    update tasks
       set status = 'deferred',
           attempt = greatest(attempt - 1, 0),
           defer_count = defer_count + 1,
           run_after = ${r.runAfter},
           error = ${r.error},
           claude_session_id = coalesce(${r.sessionId ?? null}, claude_session_id),
           locked_by = null,
           locked_at = null
     where id = ${id} and status = 'running' and locked_by = ${workerId}
    returning id`;
  return rows.length > 0;
}

/** Shutdown/abort: back to pending without counting the attempt. */
export async function releaseTask(sql: Sql, id: string, workerId: string, error: string): Promise<boolean> {
  const rows = await sql`
    update tasks
       set status = 'pending',
           attempt = greatest(attempt - 1, 0),
           error = ${error},
           locked_by = null,
           locked_at = null
     where id = ${id} and status = 'running' and locked_by = ${workerId}
    returning id`;
  return rows.length > 0;
}

export type FailResult = 'retry' | 'failed' | 'lost_lock';

/**
 * A counted failure. Retries (status pending, run_after = now + retryDelayMs) until
 * the attempt reaches maxAttempts; then the task fails and its venture is paused.
 * Runs in one transaction so the venture pause and task failure land together.
 */
export async function failTask(
  sql: Sql,
  id: string,
  workerId: string,
  r: {
    error: string;
    retryDelayMs: number;
    sessionId?: string | null;
    maxAttempts?: number;
    /** Only act if the lock is at least this old (the reaper's expiry check, re-done under the row lock). */
    lockedBefore?: Date;
  },
): Promise<FailResult> {
  const maxAttempts = r.maxAttempts ?? MAX_ATTEMPTS;
  return sql.begin(async (tx) => {
    const rows = await tx<{ attempt: number; venture_id: string | null; stage: string }[]>`
      select attempt, venture_id, stage from tasks
       where id = ${id} and status = 'running' and locked_by = ${workerId}
         and (${r.lockedBefore ?? null}::timestamptz is null or locked_at is null or locked_at <= ${r.lockedBefore ?? null}::timestamptz)
       for update`;
    const t = rows[0];
    if (!t) return 'lost_lock' as const;
    if (t.attempt < maxAttempts) {
      await tx`
        update tasks
           set status = 'pending',
               run_after = now() + make_interval(secs => ${r.retryDelayMs / 1000}),
               error = ${r.error},
               claude_session_id = coalesce(${r.sessionId ?? null}, claude_session_id),
               locked_by = null,
               locked_at = null
         where id = ${id}`;
      return 'retry' as const;
    }
    await tx`
      update tasks
         set status = 'failed',
             error = ${r.error},
             claude_session_id = coalesce(${r.sessionId ?? null}, claude_session_id),
             completed_at = now(),
             locked_by = null,
             locked_at = null
       where id = ${id}`;
    if (t.venture_id) {
      await tx`
        update ventures
           set status = 'paused',
               paused_reason = ${`task ${id} (${t.stage}) failed ${t.attempt} attempts: ${r.error}`.slice(0, 2000)}
         where id = ${t.venture_id} and status in ('active', 'scaling')`;
    }
    return 'failed' as const;
  }) as Promise<FailResult>;
}

/**
 * Startup recovery: tasks this worker id left 'running' (it just started, so they are orphans).
 * The interrupted attempt was counted at claim, so this goes through failTask: a task that has used
 * all its attempts fails (and pauses its venture) instead of crash-looping forever.
 */
export async function requeueOwnOrphans(sql: Sql, workerId: string): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    select id from tasks where status = 'running' and locked_by = ${workerId}`;
  let n = 0;
  for (const { id } of rows) {
    const r = await failTask(sql, id, workerId, {
      error: 'requeued at worker startup (previous run was interrupted)',
      retryDelayMs: 0,
    });
    if (r !== 'lost_lock') n++;
  }
  return n;
}

export interface WorkerLock {
  release(): Promise<void>;
}

/**
 * Takes a session-level advisory lock for this worker id on a dedicated connection, so two live processes
 * can never share an id (which would make requeueOwnOrphans steal live tasks). Returns null if another
 * process holds it. `onLost` fires if the connection drops while held (the lock is gone with it).
 * Needs a session-mode connection (Supabase session pooler or direct), as D1 already requires.
 */
export async function acquireWorkerLock(
  databaseUrl: string,
  workerId: string,
  onLost?: () => void,
): Promise<WorkerLock | null> {
  let released = false;
  const conn = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    onnotice: () => {},
    idle_timeout: 0,
    max_lifetime: null,
    connect_timeout: 15,
    onclose: () => {
      if (!released) onLost?.();
    },
  });
  try {
    const rows = await conn`select pg_try_advisory_lock(hashtext(${`venture-engine:worker:${workerId}`})) as locked`;
    if (rows[0]?.locked === true) {
      return {
        async release() {
          released = true;
          await conn.end({ timeout: 5 });
        },
      };
    }
  } catch (e) {
    released = true;
    await conn.end({ timeout: 1 }).catch(() => undefined);
    throw e;
  }
  released = true;
  await conn.end({ timeout: 5 });
  return null;
}

export async function listRunningTasks(
  sql: Sql,
): Promise<Pick<TaskRow, 'id' | 'stage' | 'locked_by' | 'locked_at' | 'attempt' | 'venture_id'>[]> {
  return sql`
    select id, stage, locked_by, locked_at, attempt, venture_id
      from tasks where status = 'running'`;
}

/**
 * Reaper helper: a running task whose lease expired is treated as a crashed attempt.
 * Uses failTask semantics (already counted at claim), keyed on the stale lock holder.
 */
export async function reapTask(
  sql: Sql,
  id: string,
  staleWorkerId: string,
  r: { error: string; retryDelayMs: number; lockedBefore?: Date },
): Promise<FailResult> {
  return failTask(sql, id, staleWorkerId, r);
}

// ---------------------------------------------------------------------------
// ventures
// ---------------------------------------------------------------------------

export async function getVenture(sql: Sql, id: string): Promise<VentureRow | null> {
  const rows = await sql`
    select id, slug, name, stage, status, budget_cap_usd, repo_path, paused_reason
      from ventures where id = ${id}`;
  const r = rows[0];
  if (!r) return null;
  return { ...(r as unknown as VentureRow), budget_cap_usd: num(r.budget_cap_usd) };
}
