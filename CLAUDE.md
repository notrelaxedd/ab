# Venture Engine

Venture Engine turns business ideas into live digital products with no human approval step. A worker
process claims tasks from a Supabase queue and runs each stage as a headless `claude -p` session.
This file is appended to the system prompt of every stage run, and it is also the context for anyone
developing this repo. The full spec is `BUILD_PROMPT.md`; design decisions are in `docs/decisions.md`.

## Rules for stage runs

1. **Output.** Your final message must contain exactly one JSON block that matches your stage's schema.
   If you are asked to correct it, reply with a single corrected ```json block and nothing else.
2. **No secrets.** You are given no credentials, and you must never ask for, look for, print or pass
   secrets (API keys, tokens, passwords, connection strings). Integrations are authenticated by the worker
   and the MCP servers, not by you.
3. **Denials are final.** When a hook or permission rule denies a tool call, do not try to reach the same
   effect another way (a different tool, a shell command, a script). Adapt the plan, or report the denial
   in your output.
4. **Stay in your working directory.** It is the venture's repo (`ventures/<slug>`), or `ventures/_portfolio`
   for portfolio-wide tasks. Do not read or modify files outside it.
5. **Money limits are enforced by code**, not by you: every spend-capable call is checked against the
   venture and portfolio budgets before it runs. Do not try to work around a budget denial.
6. **Policies.** Content, ads, spend and category rules live in `policies/*.md`. Follow them exactly;
   an action that breaks a policy will be blocked by the reviewer.

Environment available to a run: `TASK_ID`, `STAGE`, `DRY_RUN` (`true`/`false`; while true, no ad writes
or live payments are allowed), and `VENTURE_ID` (the venture's UUID; absent for portfolio tasks).

## Developing this repo

- Layout: `worker/` (loop, task runner, `lib/claude.ts` is the only code that spawns Claude),
  `supabase/migrations/`, `prompts/stages/`, `scripts/`, `test/`, `docs/`. Worker runs use
  `.claude/worker-settings.json` via `--settings`; `.claude/settings.json` is for developers only.
- Commands: `npm run typecheck`, `npm test` (needs `TEST_DATABASE_URL`, see `docs/SETUP.md`),
  `npm run build`, `npm run db:migrate`, `npm run worker`, `npm run smoke:noop`.
- Conventions: ESM with `.js` extensions on relative imports; zod at every JSON boundary; fail closed
  when a guard cannot decide; record every non-obvious choice in `docs/decisions.md`.
- Every new migration must revoke access from `anon` and `authenticated` for the objects it creates
  (see D5 in `docs/decisions.md`).
