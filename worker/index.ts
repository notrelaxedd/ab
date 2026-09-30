import fs from 'node:fs/promises';
import path from 'node:path';
import { checkClaudeInstall, killAllChildrenSync, markWorkerStopping } from './lib/claude.js';
import { loadConfig } from './lib/config.js';
import { acquireWorkerLock, createDb, requeueOwnOrphans } from './lib/db.js';
import { log } from './lib/log.js';
import { Worker } from './loop.js';
import { executeTask } from './runTask.js';
import { noopScheduler } from './scheduler.js';
import { stageTimeoutMs } from './stages/registry.js';

async function main(): Promise<void> {
  if (process.env.ANTHROPIC_API_KEY) {
    // Would bill the API instead of the subscription. Also never forwarded to children.
    log.warn('ANTHROPIC_API_KEY is set; ignoring and removing it (the worker uses the subscription login)');
    delete process.env.ANTHROPIC_API_KEY;
  }

  const config = loadConfig();

  try {
    const { version } = await checkClaudeInstall(config.claudeBin);
    log.info('claude cli ok', { bin: config.claudeBin, version });
  } catch (e) {
    log.error('claude cli check failed; refusing to start', { error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  }

  const lock = await acquireWorkerLock(config.databaseUrl, config.workerId, () =>
    fatal('worker lock connection lost', new Error('advisory lock connection closed; exiting so a fresh process re-acquires it')),
  );
  if (!lock) {
    log.error('another worker process already uses this WORKER_ID; refusing to start', { workerId: config.workerId });
    process.exit(1);
  }

  const sql = createDb(config.databaseUrl);
  const requeued = await requeueOwnOrphans(sql, config.workerId);
  if (requeued > 0) log.warn('requeued tasks left running by a previous run', { count: requeued });
  await fs.mkdir(path.join(config.venturesDir, '_portfolio'), { recursive: true });

  const worker = new Worker({
    sql,
    workerId: config.workerId,
    tickMs: config.tickMs,
    stageTimeoutMs,
    scheduler: noopScheduler,
    execute: (task, signal) => executeTask(task, { sql, config }, signal),
  });

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) {
      log.error('second signal: forcing exit', { signal: sig });
      killAllChildrenSync();
      process.exit(1);
    }
    shuttingDown = true;
    markWorkerStopping();
    log.info('shutting down', { signal: sig, graceMs: config.shutdownGraceMs });
    try {
      await worker.stop(config.shutdownGraceMs);
      await sql.end({ timeout: 5 });
      await lock.release();
    } catch (e) {
      log.error('error during shutdown', { error: e instanceof Error ? e.message : String(e) });
      killAllChildrenSync();
      process.exit(1);
    }
    log.info('stopped');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  worker.start();
  log.info('worker started', { workerId: config.workerId, tickMs: config.tickMs, venturesDir: config.venturesDir });
}

function fatal(kind: string, e: unknown): never {
  log.error(kind, { error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
  // The claude children are detached and would outlive us, and keep spending.
  killAllChildrenSync();
  process.exit(1);
}

process.on('unhandledRejection', (e) => fatal('unhandledRejection', e));
process.on('uncaughtException', (e) => fatal('uncaughtException', e));

main().catch((e) => fatal('startup failed', e));
