// Live check for the owner's machine: runs the NOOP stage through the real claude CLI.
// No database needed. Usage: npm run smoke:noop   (CLAUDE_BIN=claude by default)
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from '../worker/lib/config.js';
import { checkClaudeInstall, runStage } from '../worker/lib/claude.js';
import { buildClaudeSpec } from '../worker/runTask.js';
import { getStage } from '../worker/stages/registry.js';
import type { SettingsRow, TaskRow } from '../worker/types.js';

async function main(): Promise<number> {
  const claudeBin = process.env.CLAUDE_BIN ?? 'claude';
  const def = getStage('NOOP');
  if (!def || def.kind !== 'claude') throw new Error('NOOP stage missing from registry');

  const { version } = await checkClaudeInstall(claudeBin);
  console.log(`claude ${version} (${claudeBin})`);

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 've-smoke-'));
  const now = new Date();
  const task: TaskRow = {
    id: 'smoke-noop',
    venture_id: null,
    stage: 'NOOP',
    status: 'running',
    attempt: 1,
    defer_count: 0,
    run_after: now,
    claude_session_id: null,
    input: { message: 'smoke test' },
    output: null,
    error: null,
    locked_by: 'smoke',
    locked_at: now,
    dedupe_key: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
  };
  const settings: SettingsRow = {
    kill_switch: false,
    dry_run: true,
    monthly_budget_usd: 0,
    venture_budget_usd: 0,
    max_active_ventures: 0,
    max_concurrency: 1,
    auto_refund_limit_usd: 0,
    brand_domain: null,
    support_email: null,
    owner_email: null,
    timezone: 'UTC',
    ai_paused_until: null,
  };
  try {
    const ctx = { task, venture: null, settings, cwd, signal: new AbortController().signal };
    const spec = await buildClaudeSpec(def, ctx, { claudeBin, repoRoot: REPO_ROOT }, process.env, true);
    const result = await runStage(spec, def.outputSchema);
    console.log(JSON.stringify(result, null, 2));
    return result.kind === 'ok' ? 0 : 1;
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
