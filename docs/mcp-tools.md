# MCP Tools & External Services

## Claude Code CLI (verified)

**Minimum version**: 2.1.285

**Verified end to end** (2026-09-30): `npm run smoke:noop` ran the NOOP stage through the real 2.1.285 CLI with the complete flag set below (stdin prompt, `--setting-sources ''`, `--permission-prompts none`, `--tools ""`, `--json-schema`, `--append-system-prompt`, empty `--mcp-config` + `--strict-mcp-config`) and an allowlisted env; the result validated against the zod schema on the first try.

**Verification**: Version printed by `claude --version` must be ≥ 2.1.285. Worker startup calls `checkClaudeInstall` which runs `claude --version` and `claude --help` and aborts if flags are missing.

### Flags used by the worker

The worker builds Claude Code invocations with the following flags, all verified to exist in version 2.1.285:

| Flag | Value | Purpose | Required | Notes |
|------|-------|---------|----------|-------|
| `-p` | (none) | Prompt mode; prompt comes from stdin | Yes | Prompt is NOT an argv argument |
| `--output-format` | json | Machine-readable result | Yes | Only json is used; text and stream-json are available |
| `--model` | e.g., `haiku`, `sonnet`, `opus` | Model choice | Yes | Worker builds this per stage |
| `--max-turns` | integer ≥1 | Max conversation turns | Yes | Hidden from `--help` but present in flag table |
| `--permission-mode` | acceptEdits | Permission handling | Yes | Only acceptEdits is used; other modes available: manual, auto, bypassPermissions (never used), dontAsk, plan |
| `--permission-prompts` | none | Suppress permission UI | Yes | Only none is used; host, none available |
| `--settings` | /abs/path/to/worker-settings.json | Policy file | Yes | Must be absolute path |
| `--setting-sources` | (empty string) | Load which settings | Yes | Empty string loads none (user/project/local). Managed policy settings still apply. |
| `--mcp-config` | /abs/path/to/.mcp.json | MCP servers file | Yes | Must be absolute path; even for NOOP, an empty `{"mcpServers":{}}` is passed |
| `--strict-mcp-config` | (flag only) | Only use servers from `--mcp-config` | Yes | Ignores every other MCP configuration (user, project, plugins) |
| `--tools` | comma-separated list or "" | Default tools | Yes | Can be empty string to disable all tools |
| `--allowedTools` | tool patterns | Allow these tools | Conditional | Only when needed; variadic flag (multiple values) |
| `--disallowedTools` | tool patterns | Deny these tools | Conditional | Only when needed; variadic flag (multiple values) |
| `--append-system-prompt` | text | Extra system instructions | Conditional | Only when stage defines it |
| `--json-schema` | JSON string | Zod schema for output | Conditional | Only when stage defines it; draft-2020-12 URI is stripped before passing |
| `--max-budget-usd` | number > 0 | Spending limit | Conditional | Only when stage defines it and binary supports it |
| `--resume` | session-id | Resume past session | Conditional | Only on retry after invalid output |

### Result JSON structure

A successful `claude -p --output-format json` produces a single JSON object with these fields:

| Field | Type | Always present? | Usage |
|-------|------|-----------------|-------|
| `type` | string | Yes | Always `"result"` |
| `subtype` | string | No | Error subtype, e.g., "error_max_budget_usd" |
| `is_error` | boolean | No | True if the run failed |
| `result` | string | No | Main text output from Claude |
| `session_id` | string | No | Session ID for resuming; null if no session started |
| `structured_output` | unknown | No | Parsed output when `--json-schema` is used and valid |
| `total_cost_usd` | number | No | Total spend for the run |
| `num_turns` | number | No | Number of conversation turns |
| `terminal_reason` | string | No | Why the run ended; see below |
| `api_error_status` | number | No | HTTP status if an API error occurred (e.g., 429, 529) |
| `errors` | string[] | No | Error messages when `subtype` is error_during_execution or similar |

### Usage limit & rate limit classification

The worker classifies a result as a usage limit in any of these cases:

1. `terminal_reason` is `blocking_limit` or `rapid_refill_breaker`
2. `api_error_status` is 429
3. Output text (stdout, stderr, or result field) matches the regex `/usage limit|hit your limit|rate.?limit|rate_limit_error/i`

A 529 (`overloaded`) and bare status numbers in crash text are NOT limits: they are ordinary errors (counted attempt, 2 min retry), so a transient overload cannot pause all AI for 30 min.

**Important**: A successful response (`is_error === false`, `exitCode === 0`, no signal) that happens to mention "rate limit" or "429" in the text is NOT classified as a limit—only non-successful results or missing result objects trigger the heuristic.

### Terminal reason enum (from binary inspection)

`terminal_reason` values in 2.1.285: `completed`, `max_turns`, `budget_exhausted`, `structured_output_retry_exhausted`,
`blocking_limit` and `rapid_refill_breaker` (usage limits), `api_error`, `model_error`, `image_error`, `prompt_too_long`,
`malformed_tool_use_exhausted`, `aborted_streaming`, `aborted_tools`, `stop_hook_prevented`, `hook_stopped`,
`tool_deferred`, `tool_deferred_unavailable`, `background_requested`, `turn_setup_failed`.

### Important implementation details

- **Prompt via stdin**: The prompt is passed via child process stdin, not as an argv argument. `claude -p --output-format json <other flags>` will read from stdin.
- **Empty `--setting-sources`**: The flag value `--setting-sources ''` is valid and loads none of the user/project/local sources. Verified live against 2.1.285.
- **Absolute paths required**: `--settings` and `--mcp-config` must be absolute paths; relative paths would resolve incorrectly if the child's cwd is different.
- **Tool pattern syntax**: Patterns like `Bash(curl *)`, `Read(~/.env)`, `Edit(**/*.json)` use glob syntax. Commas, newlines, and leading dashes in patterns are rejected.
- **No dangerously-skip-permissions**: The worker never uses `--dangerously-skip-permissions` or `bypassPermissions`; it relies on deny rules and permission mode `acceptEdits`.

---

## MCP servers

### Phase 1 status

MCP server integration comes in Phase 2. Phase 1 stages (NOOP only) use an empty MCP config: `{"mcpServers":{}}`.

### MCP servers (to be filled in Phase 2)

Tool names and parameters are recorded here only after reading each server's live tool list. None are
hardcoded yet.

| Server | Used by (spec §7) | Tool names / params | Auth |
|--------|-------------------|---------------------|------|
| Supabase | BUILD (one schema per venture) | TODO (Phase 2) | TODO |
| Stripe | BUILD (test mode), LAUNCH, SUPPORT, KILL, MEASURE | TODO | needs interactive auth |
| Vercel | BUILD, LAUNCH, KILL | TODO | TODO |
| Playwright | BUILD (e2e) | TODO | local |
| MailerLite | LAUNCH, MARKET, KILL | TODO | needs interactive auth |
| PostHog | LAUNCH, MEASURE | TODO | needs interactive auth |
| Canva | MARKET (creatives) | TODO | TODO |
| Meta Ads | MARKET, OPTIMIZE_ADS, MEASURE, KILL | TODO | TODO |
| Gmail | SUPPORT, DIGEST | TODO | TODO |

---

## Environment variables & configuration

### Worker environment

The worker process (started by pm2) reads these env vars via `loadConfig`:

- `DATABASE_URL` (required): Supabase session pooler PostgreSQL URL
- `WORKER_ID` (optional): Worker identifier; defaults to `hostname:pm_id` under pm2 and `hostname:pid<pid>` otherwise. The worker refuses to start if another live process holds the same id (advisory lock)
- `TICK_MS` (optional): Interval between claim cycles, ms; default 60000
- `CLAUDE_BIN` (optional): Path to claude binary; default "claude"
- `VENTURES_DIR` (optional): Where ventures live; default `<repo>/ventures`
- `SHUTDOWN_GRACE_MS` (optional): Grace period for graceful shutdown; default 45000
- `LOG_LEVEL` (optional): debug, info, warn, error; default info

### Child process environment (Claude runs)

The worker spawns Claude with `buildChildEnv`, which constructs a clean environment from scratch:

**Allowed (copied from parent env)**:
- PATH, HOME, USER, LOGNAME, SHELL
- LANG, LANGUAGE, TERM, TZ, TMPDIR, TMP, TEMP
- HTTP_PROXY, HTTPS_PROXY, NO_PROXY, http_proxy, https_proxy, no_proxy
- SSL_CERT_FILE, SSL_CERT_DIR, NODE_EXTRA_CA_CERTS
- CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN
- XDG_CONFIG_HOME, XDG_CACHE_HOME, XDG_DATA_HOME
- Any var starting with LC_

**Always added by worker**:
- TASK_ID, STAGE, DRY_RUN, VENTURE_ID (if task has a venture)
- DISABLE_AUTOUPDATER=1

**Never passed**:
- ANTHROPIC_API_KEY
- DATABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- AWS_SECRET_ACCESS_KEY, AWS_ACCESS_KEY_ID
- Any other secrets not explicitly allowlisted
