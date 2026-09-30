import { z } from 'zod';
import type { ClaudeStageDef, StageDef } from './types.js';

const DEFAULT_TIMEOUT_MS = 30 * 60_000;

/** Connectivity check: proves queue -> claude -> schema-validated output works end to end. */
const NOOP: ClaudeStageDef = {
  kind: 'claude',
  name: 'NOOP',
  model: 'haiku',
  maxTurns: 2,
  timeoutMs: 120_000,
  tools: [],
  allowedTools: [],
  disallowedTools: [],
  mcpServers: [],
  promptFile: 'prompts/stages/NOOP.md',
  outputSchema: z.object({ ok: z.literal(true), echo: z.string() }),
  buildPrompt(ctx) {
    const message = String(ctx.task.input.message ?? 'ping');
    return [
      'Connectivity check. Reply with exactly one JSON object and nothing else:',
      `{"ok": true, "echo": ${JSON.stringify(message)}}`,
      'The message to echo, verbatim:',
      message,
    ].join('\n');
  },
};

const STAGES = new Map<string, StageDef>([[NOOP.name, NOOP]]);

export function getStage(name: string): StageDef | undefined {
  return STAGES.get(name);
}

/** Timeout used for lease/reaper math. Unknown stages get the longest default. */
export function stageTimeoutMs(name: string): number {
  return getStage(name)?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}
