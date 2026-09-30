import type { z } from 'zod';
import type { SettingsRow, StageName, TaskRow, VentureRow } from '../types.js';

export interface StageContext {
  task: TaskRow;
  venture: VentureRow | null;
  settings: SettingsRow;
  /** Working directory for this task: ventures/<slug> or ventures/_portfolio. */
  cwd: string;
  signal: AbortSignal;
}

/** A stage run by `claude -p` through worker/lib/claude.ts. */
export interface ClaudeStageDef {
  kind: 'claude';
  name: StageName;
  model: string;
  maxTurns: number;
  timeoutMs: number;
  /** Built-in tools made available (--tools). Empty array = no tools at all. */
  tools: string[];
  /** Pre-approved tool patterns (--allowedTools). */
  allowedTools: string[];
  /** Always-denied tool patterns (--disallowedTools). */
  disallowedTools: string[];
  /** Server names from .mcp.json this stage may see. Empty = no MCP servers. */
  mcpServers: string[];
  maxBudgetUsd?: number;
  /** Stage prompt file under prompts/stages/, appended to the system prompt. */
  promptFile: string;
  outputSchema: z.ZodType;
  buildPrompt(ctx: StageContext): string;
}

/** A stage implemented in TypeScript (e.g. DECIDE rules). */
export interface CodeStageDef {
  kind: 'code';
  name: StageName;
  timeoutMs: number;
  run(ctx: StageContext): Promise<unknown>;
}

export type StageDef = ClaudeStageDef | CodeStageDef;
