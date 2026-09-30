import { claimTask, getSettings, listRunningTasks, reapTask, type Sql } from './lib/db.js';
import { log } from './lib/log.js';
import { leaseMs, retryDelayMs } from './policy.js';
import { applyOutcome, type ApplyResult } from './runTask.js';
import { noopScheduler, type Scheduler } from './scheduler.js';
import type { TaskOutcome, TaskRow } from './types.js';

export interface WorkerOptions {
  sql: Sql;
  workerId: string;
  tickMs: number;
  execute(task: TaskRow, signal: AbortSignal): Promise<TaskOutcome>;
  stageTimeoutMs(stage: string): number;
  scheduler?: Scheduler;
  now?: () => Date;
  onOutcome?(task: TaskRow, outcome: TaskOutcome, result: ApplyResult | 'error'): void;
}

export interface TickResult {
  claimed: string[];
  skipped?: 'kill_switch' | 'ai_paused' | 'busy';
}

interface Running {
  controller: AbortController;
  done: Promise<void>;
}

/** Time allowed for aborted tasks to wind down (claude gets SIGTERM, then SIGKILL after 10 s). */
const ABORT_WAIT_MS = 12_000;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Claims and runs tasks. max_concurrency from settings is per worker process
 * (pm2 runs a single fork-mode instance), not global across processes.
 */
export class Worker {
  private readonly sql: Sql;
  private readonly workerId: string;
  private readonly tickMs: number;
  private readonly execute: WorkerOptions['execute'];
  private readonly stageTimeoutMs: WorkerOptions['stageTimeoutMs'];
  private readonly scheduler: Scheduler;
  private readonly now: () => Date;
  private readonly onOutcome?: WorkerOptions['onOutcome'];

  private readonly running = new Map<string, Running>();
  private ticking: Promise<TickResult> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private stopping = false;

  constructor(opts: WorkerOptions) {
    this.sql = opts.sql;
    this.workerId = opts.workerId;
    this.tickMs = opts.tickMs;
    this.execute = opts.execute;
    this.stageTimeoutMs = opts.stageTimeoutMs;
    this.scheduler = opts.scheduler ?? noopScheduler;
    this.now = opts.now ?? (() => new Date());
    this.onOutcome = opts.onOutcome;
  }

  get runningCount(): number {
    return this.running.size;
  }

  /** One scheduling pass. An overlapping call is a no-op. */
  async tick(): Promise<TickResult> {
    if (this.ticking) return { claimed: [], skipped: 'busy' };
    const p = this.doTick();
    this.ticking = p;
    try {
      return await p;
    } finally {
      this.ticking = null;
    }
  }

  private async doTick(): Promise<TickResult> {
    const settings = await getSettings(this.sql);
    if (settings.kill_switch) return { claimed: [], skipped: 'kill_switch' };
    const now = this.now();
    if (settings.ai_paused_until && settings.ai_paused_until > now) return { claimed: [], skipped: 'ai_paused' };

    await this.reap(now);

    const claimed: string[] = [];
    while (!this.stopping && this.running.size < settings.max_concurrency) {
      const task = await claimTask(this.sql, this.workerId);
      if (!task) break;
      claimed.push(task.id);
      this.dispatch(task);
    }

    try {
      const n = await this.scheduler.enqueueDue(this.sql, now);
      if (n > 0) log.info('scheduler enqueued tasks', { count: n });
    } catch (e) {
      log.error('scheduler failed', { error: errMsg(e) });
    }
    return { claimed };
  }

  /** Requeue 'running' tasks owned by nobody alive: lease = leaseMs(stage timeout), see policy.ts. */
  async reap(now: Date = this.now()): Promise<number> {
    const rows = await listRunningTasks(this.sql);
    let reaped = 0;
    for (const t of rows) {
      if (this.running.has(t.id) || !t.locked_by) continue;
      const lockedAt = t.locked_at ? t.locked_at.getTime() : 0;
      const lease = leaseMs(this.stageTimeoutMs(t.stage));
      if (lockedAt + lease >= now.getTime()) continue;
      const r = await reapTask(this.sql, t.id, t.locked_by, {
        error: 'lease expired (worker crashed or hung)',
        retryDelayMs: retryDelayMs(t.attempt),
        // Re-checked under the row lock: if the owner re-claimed the task since we listed it, leave it be.
        lockedBefore: new Date(now.getTime() - lease),
      });
      log.warn('reaped expired task', { task: t.id, stage: t.stage, lockedBy: t.locked_by, result: r });
      if (r !== 'lost_lock') reaped++;
    }
    return reaped;
  }

  private dispatch(task: TaskRow): void {
    if (this.running.has(task.id)) {
      // Claimed while already running here: only possible if two processes share a worker id.
      log.error('claimed a task that is already running in this process; not starting a second run', { task: task.id });
      return;
    }
    const controller = new AbortController();
    const done = (async () => {
      let outcome: TaskOutcome;
      try {
        outcome = await this.execute(task, controller.signal);
      } catch (e) {
        outcome = { kind: 'failed', error: errMsg(e) };
      }
      let result: ApplyResult | 'error' = 'error';
      try {
        result = await applyOutcome(this.sql, task, this.workerId, outcome, this.now());
      } catch (e) {
        // Leaves the task 'running'; the reaper recovers it once the lease expires.
        log.error('failed to persist task outcome', { task: task.id, error: errMsg(e) });
      }
      try {
        this.onOutcome?.(task, outcome, result);
      } catch (e) {
        log.error('onOutcome hook threw', { task: task.id, error: errMsg(e) });
      }
    })().finally(() => {
      this.running.delete(task.id);
    });
    this.running.set(task.id, { controller, done });
    log.info('task claimed', { task: task.id, stage: task.stage, venture: task.venture_id, attempt: task.attempt });
  }

  /** Tick now, then every tickMs (setTimeout chain, so ticks never pile up). */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    const loop = async () => {
      try {
        await this.tick();
      } catch (e) {
        log.error('tick failed', { error: errMsg(e) });
      }
      if (!this.stopping) {
        this.timer = setTimeout(loop, this.tickMs);
      }
    };
    void loop();
  }

  /** Stop claiming; give running tasks graceMs to finish, then abort the rest and wait for them. */
  async stop(graceMs: number): Promise<void> {
    this.stopping = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.ticking) await this.ticking.catch(() => undefined);

    if (this.running.size > 0) {
      log.info('draining running tasks', { count: this.running.size, graceMs });
      const finished = await this.waitIdle(graceMs);
      if (!finished) {
        log.warn('grace period over: aborting running tasks', { count: this.running.size });
        for (const r of this.running.values()) r.controller.abort();
        if (!(await this.waitIdle(ABORT_WAIT_MS))) {
          log.error('tasks did not stop after abort; reaper will recover them', { count: this.running.size });
        }
      }
    }
  }

  /** Resolves when no task is running (for tests and shutdown). */
  async idle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running.values()].map((r) => r.done));
    }
  }

  private async waitIdle(ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    try {
      return await Promise.race([this.idle().then(() => true as const), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
