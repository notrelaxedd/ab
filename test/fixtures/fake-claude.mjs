#!/usr/bin/env node
// Scenario-driven stand-in for the claude CLI. The scenario comes from a "[fake:<name>]" marker in the
// prompt on stdin (the worker's child env is allowlisted, so env vars cannot carry it). Resumed calls
// reuse the scenario recorded for the session in the first call.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

const HELP = `Usage: claude [options] [command] [prompt]

Options:
  --allowedTools, --allowed-tools <tools...>  Comma or space-separated list of tool names to allow
  --append-system-prompt <prompt>             Append a system prompt to the default system prompt
  --disallowedTools, --disallowed-tools <tools...>  Tool names to deny
  --json-schema <schema>                      JSON Schema for structured output validation
  --max-budget-usd <amount>                   Maximum dollar amount to spend on API calls
  --mcp-config <configs...>                   Load MCP servers from JSON files or strings
  --model <model>                             Model for the current session
  --output-format <format>                    Output format (only works with --print)
  --permission-mode <mode>                    Permission mode to use for the session
  --permission-prompts <target>               Who answers permission prompts with --print
  -p, --print                                 Print response and exit
  -r, --resume [value]                        Resume a conversation by session ID
  --setting-sources <sources>                 Comma-separated list of setting sources to load
  --settings <file-or-json>                   Path to a settings JSON file or a JSON string
  --strict-mcp-config                         Only use MCP servers from --mcp-config
  --tools <tools...>                          Specify the list of available tools
  -v, --version                               Output the version number
`;

if (argv.includes('--version')) {
  process.stdout.write('2.1.285 (Claude Code)\n');
  process.exit(0);
}
if (argv.includes('--help')) {
  process.stdout.write(HELP);
  process.exit(0);
}

const result = (name) => fs.readFileSync(path.join(here, 'claude-results', `${name}.json`), 'utf8');

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (stdin += c));
process.stdin.on('end', () => main());

function main() {
  const cwd = process.cwd();
  fs.appendFileSync(
    path.join(cwd, '.fake-claude-calls.jsonl'),
    JSON.stringify({ argv, envKeys: Object.keys(process.env).sort(), stdin, cwd }) + '\n',
  );

  const sessionsFile = path.join(cwd, '.fake-claude-sessions.json');
  const sessions = fs.existsSync(sessionsFile) ? JSON.parse(fs.readFileSync(sessionsFile, 'utf8')) : {};
  const resumeIdx = argv.indexOf('--resume');
  const resumeId = resumeIdx >= 0 ? argv[resumeIdx + 1] : undefined;
  const marker = /\[fake:([a-z0-9_]+)\]/.exec(stdin);
  const scenario = marker ? marker[1] : resumeId ? sessions[resumeId] : undefined;
  if (!scenario) {
    process.stderr.write('fake-claude: no [fake:<scenario>] marker in prompt\n');
    process.exit(2);
  }
  sessions['fake-session-0001'] = scenario;
  fs.writeFileSync(sessionsFile, JSON.stringify(sessions));

  const emit = (name) => process.stdout.write(result(name).replace(/\s*\n\s*/g, '') + '\n');
  switch (scenario) {
    case 'ok':
      return emit('success_structured');
    case 'ok_text':
      return emit('success_text');
    case 'usage_limit':
      return emit('usage_limit');
    case 'rate_limit_429':
      process.exitCode = 1;
      return emit('rate_limit_429');
    case 'invalid_then_valid':
      return emit(resumeId ? 'success_text' : 'success_invalid');
    case 'invalid_twice':
      return emit('success_invalid');
    case 'ok_leave_grandchild': {
      // Like a Bash tool leaving a dev server running: same process group, detached from our pipes.
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      child.unref();
      fs.writeFileSync(path.join(process.cwd(), 'grandchild.pid'), String(child.pid));
      return emit('success_structured');
    }
    case 'echo_env': {
      const o = JSON.parse(result('success_text'));
      o.result = '```json\n' + JSON.stringify({ env: process.env }) + '\n```';
      return process.stdout.write(JSON.stringify(o) + '\n');
    }
    case 'crash':
      process.stderr.write('fake-claude: fatal: something exploded\n');
      process.exit(1);
      break;
    case 'hang':
      setInterval(() => {}, 1000);
      return;
    case 'hang_ignore_term':
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
      return;
    default:
      process.stderr.write(`fake-claude: unknown scenario ${scenario}\n`);
      process.exit(2);
  }
}
