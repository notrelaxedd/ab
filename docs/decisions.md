# Decisions

Non-obvious choices, with the reason for each. Add to this file whenever you make one.

## Data and database

**D1. The worker talks to Postgres directly, not through supabase-js.**
It connects with `DATABASE_URL` (the Supabase *session* pooler) using the `postgres` library, with `prepare: false`.
Why: the budget checks in Phase 2 need real transactions, and tests can run against plain local Postgres.
Logic that must be atomic lives in SQL functions (`claim_task`, and `reserve_spend` later), so any client can call it.
Session mode is required because the worker's advisory lock (D19) is held per session.

**D2. We use our own migrator (`npm run db:migrate`), not `supabase db push`.**
It applies `supabase/migrations/*.sql` in filename order, one transaction per file, and records each file in `public._migrations`.
Why: the owner doesn't need the Supabase CLI, and tests use exactly the same code path.
Don't mix it with `supabase db push`: the CLI keeps its own history table and would try to re-apply everything.

**D3. Enumerations are `text` columns with `CHECK` constraints.**
`tasks.stage` and `ventures.stage` only check the shape (`^[A-Z_]+$`). The real list of stages is the zod enum in `worker/types.ts`.
Why: adding a stage becomes a code change, not a migration.

**D4. Budgets default to 0 and `dry_run` defaults to true.**
Nothing can spend until the owner sets real limits (see `docs/SETUP.md`).
The §8 decision thresholds are seeded with the spec's values.
`settings.timezone` defaults to UTC and sets the month boundary in `monthly_spend` and the scheduler times.

**D5. Row-level security is on for every table, and access for `anon` and `authenticated` is revoked explicitly.**
Views are `security_invoker`, and `claim_task` / `set_updated_at` are revoked from `public`.
Why: on Supabase, RLS alone doesn't protect views or RPC functions. Supabase's default privileges grant everything in `public` to `anon` and `authenticated`.
Migration 4 also revokes those default privileges for the role that runs migrations, and removes PUBLIC's default EXECUTE on new functions.
Consequence: every future migration must still revoke access on the objects it creates. Default privileges owned by `supabase_admin` are outside our control.
The Phase 6 dashboard will get its own read-only role with explicit grants.
Tests reproduce Supabase's default grants so these revokes are actually exercised.

**D6. Money in the ledger.**
`amount_usd` is always ≥ 0, and `kind` (`reservation` | `actual` | `release`) gives the direction.
An open reservation per `(venture, category, ref)` is reservations − releases, floored at 0.
`monthly_spend` counts this month's actuals plus *all* open reservations, whenever they were made, because reserved money can still be spent.

**D7. Slugs match `^[a-z][a-z0-9-]{1,30}[a-z0-9]$`.**
A venture's Supabase schema is `v_` + the slug with `-` replaced by `_`, because unquoted SQL identifiers can't contain hyphens.

## Queue and worker

**D8. How attempts are counted.**
`claim_task` increments `attempt`. A usage-limit deferral or a shutdown release decrements it again, so neither counts.
A crash still counts: when the worker restarts, it treats its own orphaned tasks as failed attempts.
After 3 counted attempts the task is `failed` and its venture is `paused`, with `paused_reason` set for the weekly digest.
Ordinary failures retry after 2 min × attempt.

**D9. How usage limits are handled.**
A result counts as a usage or rate limit in any of these cases:
- `terminal_reason` is `blocking_limit` or `rapid_refill_breaker`
- `api_error_status` is 429
- the text says so (`usage limit`, `hit your limit`, `rate limit`, `rate_limit_error`)

These checks are only applied when the run did not succeed.
The task becomes `deferred` with a backoff of 30, 60, 120 and 240 min, then capped at 5 h. If the CLI reports a later reset time, the task waits for that instead, still capped at 5 h.
`settings.ai_paused_until` is set to the same time, and the worker claims nothing until then. Otherwise every queued task would burn a Claude startup just to hit the same limit.
A 529 "overloaded" response is an ordinary retryable error, so a transient overload can't pause all AI for 30 min.

**D10. `max_concurrency` is enforced per worker process.**
pm2 runs a single fork-mode instance, so this is also the global limit. `claim_task` itself is safe with any number of processes.

**D11. Kill switch.**
Each tick reads `settings` before claiming, and `claim_task` checks the switch again in SQL, so new claims stop within one tick.
The switch also skips the reaper and scheduler for that tick.
It does not kill runs already in progress; the Phase 2 hooks will deny their writes.
Meta campaigns that are already live keep spending until they are paused in Meta. That goes in the runbook.

**D12. Worker identity and startup recovery.**
`WORKER_ID` defaults to `hostname:pm_id` under pm2, which is stable across restarts, and `hostname:pid<pid>` otherwise.
At startup the worker takes a session advisory lock on its id and refuses to start if another live process holds it. Two processes sharing an id would otherwise steal each other's tasks during recovery.
If the lock connection drops, the worker exits and pm2 restarts it.

**D13. The reaper.**
A `running` task whose lock is older than `2 × (stage timeout + 15 s) + 5 min` is treated as a crashed attempt.
The factor of 2 covers `runStage` possibly running Claude twice (first run plus one correction).
The age check is repeated under the row lock, so a task its owner re-claimed in the meantime is left alone.
If saving a task's outcome fails (for example, the database is down), the task stays `running` and the reaper recovers it later.

**D14. Shutdown (SIGTERM / SIGINT).**
The worker stops claiming and gives running tasks 45 s. It then aborts them: SIGTERM to the Claude process group, SIGKILL 10 s later. Aborted tasks go back to `pending` without counting an attempt.
The pm2 `kill_timeout` is 60 s and must stay above that total.
A second signal forces exit after SIGKILLing every child group.

**D15. Tasks with no venture run in `ventures/_portfolio/`.**
This applies to IDEATE, RESEARCH and DIGEST. It's a plain directory created on demand, not a git repo.

## Running Claude (`worker/lib/claude.ts`)

**D16. Spawned Claude gets an allowlisted env, never the worker's.** *(Deviation from the spec.)*
The child env is built from scratch:
- system basics: PATH, HOME, USER, LOGNAME, SHELL, locale, TERM, TZ, temp dirs
- proxy and CA variables, `CLAUDE_CONFIG_DIR`, the XDG dirs
- `CLAUDE_CODE_OAUTH_TOKEN` if set
- `TASK_ID`, `STAGE`, `DRY_RUN`, `VENTURE_ID`, and `DISABLE_AUTOUPDATER=1`

`ANTHROPIC_API_KEY`, `DATABASE_URL` and every other worker secret are never passed. The model can read its env through Bash, so the allowlist is what actually enforces "never pass a secret to the model".
The spec asked for the Supabase URL and key to be in the env for the hooks. We deliberately don't: with that key a model could run `UPDATE settings` and raise its own budget.
Instead, Phase 2 hooks will be thin clients of a guard endpoint that the worker hosts on 127.0.0.1. Each task gets its own token, the endpoint fails closed, and the budget math lives in TypeScript.
Residual risk: when used, `CLAUDE_CODE_OAUTH_TOKEN` is visible to the model. Headless subscription auth needs it; the alternative is the interactive login stored on the machine.

**D17. Worker runs use `.claude/worker-settings.json`, passed with `--settings` and `--setting-sources ''`.**
The empty value loads no user, project or local settings (verified against 2.1.285). Managed settings and `--settings` still apply.
Why:
- The venture cwd is its own git repo, so the engine's project settings wouldn't load there anyway.
- A model-writable project `settings.json` must not change a run's rules.
- Fail-closed worker hooks in `.claude/settings.json` would block developers.

`.claude/settings.json` is for developers only.

**D18. Flags and prompt delivery.**
The prompt goes to the child's stdin, not argv. This avoids ARG_MAX limits, prompts starting with `-` being parsed as flags, and prompts showing up in `ps`.
`buildArgs` requires absolute `--settings` and `--mcp-config` paths.
It rejects `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions` and `bypassPermissions`, and rejects tool patterns that are empty, contain a comma or newline, or start with `-` (the tool flags take lists of values).
It always passes these flags:
- `--permission-mode acceptEdits`
- `--permission-prompts none` (anything that would prompt is denied)
- `--strict-mcp-config`
- `--tools ""` when the stage has no tools

**D19. Classifying results (fail closed).**
A run is `ok` only when `is_error` is false, the exit code is 0, and there was no signal.
Anything unparseable or unexpected is an `error`, which counts as a failed attempt.
The CLI output is scanned for the last line that parses as a `type:"result"` object.

**D20. Validating stage output.**
The stage's zod schema is converted to JSON Schema (without `$schema`) and passed to `--json-schema`. The zod schema is then applied again to whatever comes back.
The candidate output is `structured_output` if present, otherwise the last fenced JSON block, otherwise the whole result text.
If it is invalid, the same session is resumed once (`--resume`) with the zod issues and a request for a corrected block. The cost of both runs is summed.
A usage limit hit during the correction run still defers the task.

**D21. Claude runs in its own process group.**
Each Claude process is spawned `detached`, so a timeout can kill its whole tree. After *every* exit the group is SIGKILLed, so dev servers or MCP children can't outlive the run.
On a fatal error or process exit, the worker SIGKILLs all live groups (`killAllChildrenSync`).
pm2's `treekill` is off, because otherwise it would SIGINT the children before the graceful drain. A child interrupted while the worker is stopping counts as `aborted`, not as a failed attempt.
Residual risk: if the worker is SIGKILLed or OOM-killed, its children survive, and after restart the task is re-run while the orphan may still be going. A pidfile sweep at startup would close this gap later.

**D22. Per-stage MCP configs are written to `.generated/mcp/<STAGE>.json`.**
Each write goes to a temp file first and is renamed into place, because concurrent tasks of the same stage share the file.
In Phase 1 every config is empty. Any stage that asks for MCP servers fails closed until Phase 2 generates real configs from `.mcp.json`.

**D23. Minimum Claude Code version is 2.1.285.**
At startup the worker checks `claude --version` and that `--help` lists every visible flag it uses (`--max-turns` is hidden, so it isn't checked). It refuses to start otherwise.

**D24. Baseline deny rules in `.claude/worker-settings.json`, and the gap they leave.**
The rules deny:
- `Read(~/.claude/**)`, `Read(**/.env)`, `Read(**/.env.*)`
- `Edit(**/.claude/**)`, `Edit(**/.env)`, `Edit(**/.env.*)`
- `Bash(curl *)`, `Bash(wget *)`

Residual risk: allowing `Bash(npm:*)` or `Bash(npx:*)` amounts to running arbitrary code, because the model writes its own package scripts. Such code can read anything the worker's user can, and the Bash patterns don't catch `sh -c curl` or pipes.
Phase 2 must add Claude Code's Bash sandbox (filesystem and network limits) and the guard hooks. It must not rely on these patterns.

## Ops and tests

**D25. pm2 runs `dist/worker/index.js` with `node --env-file=.env` (Node ≥ 20.6).**
The app runs as a single fork-mode instance named `venture-worker`.
`.env` must exist, or the process crash-loops. If `ANTHROPIC_API_KEY` is set anyway, the worker logs a warning and removes it.

**D26. Tests.**
- `TEST_DATABASE_URL` must point at a Postgres ≥ 15 superuser connection. Each test file gets its own migrated throwaway database.
- `test/fixtures/fake-claude.mjs` stands in for the CLI. Its scenario comes from a `[fake:<name>]` marker in the prompt, because the allowlisted env can't carry it. Its output shapes come from `test/fixtures/claude-results/`, which mirror a real 2.1.285 result object.
- `npm run smoke:noop` is the only check that uses the real CLI.
