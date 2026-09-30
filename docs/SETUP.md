# Owner setup checklist

One-time setup for the machine that runs the worker. Later phases add steps: MCP server logins, Meta,
Stripe, domain and Gmail. Items marked **you decide** are values only you can provide.

## 1. Machine prerequisites

- Node.js 20.6 or newer (`node --version`). The worker uses `node --env-file`.
- Claude Code 2.1.285 or newer (`claude --version`; update with `claude update`), logged in with your
  **Claude Max** subscription.
- pm2: `npm install -g pm2`.

## 2. Code

```bash
git clone <this repo> venture-engine && cd venture-engine
npm ci
cp .env.example .env
```

## 3. Supabase

1. Create a Supabase project named **ventures**.
2. In **Connect → Session pooler**, copy the connection string. It must be the session pooler (port 5432),
   not the transaction pooler: the worker holds a per-session lock.
3. Put it in `.env` as `DATABASE_URL=...`. Only the worker reads it; it is never passed to Claude.
4. Create the schema:

   ```bash
   set -a; source .env; set +a
   npm run db:migrate          # prints each migration applied; re-running prints "database is up to date"
   ```

   Do not also run `supabase db push` (see D2 in `docs/decisions.md`).

## 4. Claude authentication (subscription, not API)

- `ANTHROPIC_API_KEY` must **not** be set for the worker, or usage bills the API instead of your
  subscription. The worker strips it from every child process and logs a warning if it sees it, but keep
  it out of `.env` and your shell profile.
- For a pm2-managed worker, the most reliable login is a long-lived subscription token:

  ```bash
  claude setup-token            # prints a token
  # add to .env:
  CLAUDE_CODE_OAUTH_TOKEN=<token>
  ```

  Alternatively, rely on the interactive `claude` login of the user that runs pm2.
- Check it works end to end. This runs one no-op stage through the real CLI with the worker's exact flags,
  no database needed:

  ```bash
  set -a; source .env; set +a
  npm run smoke:noop            # expect "kind": "ok" and output {"ok": true, "echo": "smoke test"}
  ```

## 5. Settings (you decide)

Budgets start at **0**, so nothing can spend until you set them. `dry_run` stays `true` until Phase 5.
Fill in your values and run this in the Supabase SQL editor:

```sql
update settings set
  monthly_budget_usd    = <portfolio spend cap per calendar month>,
  venture_budget_usd    = <default lifetime cap per venture>,
  auto_refund_limit_usd = <refunds up to this are issued automatically>,
  max_active_ventures   = 3,     -- default
  max_concurrency       = 2,     -- default: Claude runs in parallel
  timezone              = '<IANA zone, e.g. Europe/London>',
  brand_domain          = '<domain for venture sites, e.g. example.com>',
  support_email         = '<support inbox; ventures use support+<slug>@...>',
  owner_email           = '<where the weekly digest goes>'
where id = 1;
```

The kill switch is `update settings set kill_switch = true where id = 1;`. It takes effect within one
worker tick (60 s).

## 6. Run the worker

```bash
npm run build
pm2 start ecosystem.config.cjs  # app name: venture-worker
pm2 save && pm2 startup         # survive reboots; follow the printed instruction
pm2 logs venture-worker         # JSON lines; look for "claude cli ok" and "worker started"
```

- `pm2 stop venture-worker` shuts down gracefully. New claims stop at once, and running tasks get 45 s to
  finish, then are aborted and returned to the queue without counting an attempt.
- The worker refuses to start if `claude` is older than 2.1.285 or is missing a required flag, or if
  another live process uses the same `WORKER_ID`.

## Running the tests (developers)

Tests need a Postgres 15+ superuser connection; each test file creates and drops its own database.

```bash
export TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres   # e.g. `supabase start`
npm run typecheck && npm test
```
