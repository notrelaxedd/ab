-- Core tables for Venture Engine.
-- Enumerations are text + CHECK constraints (see docs/decisions.md D5).
-- Stage names are validated in TypeScript (worker/stages/registry.ts); SQL only checks the shape.

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- settings: exactly one row (id = 1). Budgets default to 0 so nothing can spend
-- until the owner sets real limits (fail closed).
-- ---------------------------------------------------------------------------
create table settings (
  id                        smallint primary key default 1 check (id = 1),
  kill_switch               boolean       not null default false,
  dry_run                   boolean       not null default true,
  monthly_budget_usd        numeric(12,2) not null default 0 check (monthly_budget_usd >= 0),
  venture_budget_usd        numeric(12,2) not null default 0 check (venture_budget_usd >= 0),
  max_active_ventures       integer       not null default 3 check (max_active_ventures between 0 and 50),
  max_concurrency           integer       not null default 2 check (max_concurrency between 0 and 16),
  auto_refund_limit_usd     numeric(12,2) not null default 0 check (auto_refund_limit_usd >= 0),
  brand_domain              text,
  support_email             text,
  owner_email               text,
  timezone                  text          not null default 'UTC',
  -- Decision thresholds (§8). Read by worker/decide.ts.
  decide_visitors_check_day integer       not null default 14,
  decide_min_visitors       integer       not null default 300,
  decide_min_checkout_conversion numeric(6,4) not null default 0.01,
  decide_scale_roas         numeric(6,2)  not null default 1.5,
  decide_scale_min_orders   integer       not null default 5,
  decide_scale_window_days  integer       not null default 7,
  decide_scale_cap_increase_pct numeric(6,4) not null default 0.5,
  decide_kill_day           integer       not null default 30,
  decide_kill_roas_at_cap   numeric(6,2)  not null default 1.0,
  max_iterations            integer       not null default 2,
  -- Set when Claude reports a usage/rate limit; the worker claims nothing until then.
  ai_paused_until           timestamptz,
  updated_at                timestamptz   not null default now()
);

create trigger settings_updated_at before update on settings
  for each row execute function set_updated_at();

insert into settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- ideas
-- ---------------------------------------------------------------------------
create table ideas (
  id          uuid primary key default gen_random_uuid(),
  source      text not null check (source in ('owner', 'generated')),
  text        text not null,
  scorecard   jsonb,
  score       numeric(5,2) check (score is null or score between 0 and 100),
  status      text not null default 'queued'
              check (status in ('queued', 'scored', 'rejected', 'promoted')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index ideas_status_score_idx on ideas (status, score desc nulls last);
create trigger ideas_updated_at before update on ideas
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- ventures
-- ---------------------------------------------------------------------------
create table ventures (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null unique
                      check (slug ~ '^[a-z][a-z0-9-]{1,30}[a-z0-9]$'),
  name                text not null,
  idea_id             uuid references ideas (id) on delete set null,
  stage               text not null default 'SPEC' check (stage ~ '^[A-Z_]+$'),
  status              text not null default 'active'
                      check (status in ('active', 'paused', 'killed', 'scaling')),
  budget_cap_usd      numeric(12,2) not null default 0 check (budget_cap_usd >= 0),
  iteration_count     integer not null default 0 check (iteration_count >= 0),
  repo_path           text,
  url                 text,
  vercel_project_id   text,
  stripe_product_id   text,
  meta_campaign_ids   jsonb not null default '[]'::jsonb
                      check (jsonb_typeof(meta_campaign_ids) = 'array'),
  mailerlite_group_id text,
  spec                jsonb,
  launched_at         timestamptz,
  killed_at           timestamptz,
  kill_reason         text,
  paused_reason       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index ventures_status_idx on ventures (status);
create trigger ventures_updated_at before update on ventures
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- tasks: the work queue. Claimed with claim_task() (FOR UPDATE SKIP LOCKED).
-- attempt is incremented on claim and decremented when a task is deferred
-- for a usage/rate limit, so limits never count as attempts.
-- ---------------------------------------------------------------------------
create table tasks (
  id                uuid primary key default gen_random_uuid(),
  venture_id        uuid references ventures (id) on delete cascade,
  stage             text not null check (stage ~ '^[A-Z_]+$'),
  status            text not null default 'pending'
                    check (status in ('pending', 'running', 'done', 'failed', 'deferred')),
  attempt           integer not null default 0 check (attempt >= 0),
  defer_count       integer not null default 0 check (defer_count >= 0),
  run_after         timestamptz not null default now(),
  claude_session_id text,
  input             jsonb not null default '{}'::jsonb,
  output            jsonb,
  error             text,
  locked_by         text,
  locked_at         timestamptz,
  dedupe_key        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz
);

create index tasks_runnable_idx on tasks (status, run_after, created_at);
create index tasks_venture_idx on tasks (venture_id, created_at desc);
create index tasks_running_idx on tasks (locked_by) where status = 'running';
-- The scheduler enqueues with ON CONFLICT DO NOTHING; a key can be reused once the
-- previous task with it is finished.
create unique index tasks_dedupe_open_idx on tasks (dedupe_key)
  where dedupe_key is not null and status not in ('done', 'failed');
create trigger tasks_updated_at before update on tasks
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- ledger: money. amount_usd is always positive; kind gives the direction.
--   reservation: written by budget-guard before a spend-capable call
--   actual:      observed spend (e.g. Meta insights, Gemini usage)
--   release:     frees (part of) a reservation, matched by (venture_id, ref)
-- ---------------------------------------------------------------------------
create table ledger (
  id          bigint generated always as identity primary key,
  venture_id  uuid references ventures (id) on delete restrict,
  task_id     uuid references tasks (id) on delete set null,
  category    text not null check (category in ('ads', 'runtime_ai', 'other')),
  kind        text not null check (kind in ('reservation', 'actual', 'release')),
  amount_usd  numeric(12,2) not null check (amount_usd >= 0),
  source      text not null,
  ref         text,
  created_at  timestamptz not null default now()
);

create index ledger_venture_idx on ledger (venture_id, kind, ref);
create index ledger_created_idx on ledger (created_at);

-- ---------------------------------------------------------------------------
-- actions_log: every MCP call seen by the hooks (secrets redacted before insert).
-- ---------------------------------------------------------------------------
create table actions_log (
  id           bigint generated always as identity primary key,
  venture_id   uuid references ventures (id) on delete set null,
  task_id      uuid references tasks (id) on delete set null,
  tool_name    text not null,
  tool_use_id  text,
  hook         text,
  input        jsonb,
  response     jsonb,
  decision     text not null check (decision in ('allowed', 'denied')),
  reason       text,
  created_at   timestamptz not null default now()
);

create index actions_log_venture_idx on actions_log (venture_id, created_at desc);
create index actions_log_task_idx on actions_log (task_id);

-- ---------------------------------------------------------------------------
-- reviews: reviewer verdicts. budget-guard requires a 'pass' for the exact
-- target_ref before a campaign can be enabled.
-- ---------------------------------------------------------------------------
create table reviews (
  id              uuid primary key default gen_random_uuid(),
  task_id         uuid references tasks (id) on delete set null,
  venture_id      uuid references ventures (id) on delete cascade,
  action          text not null,
  target_ref      text,
  verdict         text not null check (verdict in ('pass', 'block')),
  reasons         jsonb not null default '[]'::jsonb,
  required_fixes  jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now()
);

create index reviews_lookup_idx on reviews (venture_id, action, target_ref, created_at desc);

-- ---------------------------------------------------------------------------
-- metrics_daily
-- ---------------------------------------------------------------------------
create table metrics_daily (
  venture_id    uuid not null references ventures (id) on delete cascade,
  date          date not null,
  visitors      integer not null default 0,
  signups       integer not null default 0,
  checkouts     integer not null default 0,
  orders        integer not null default 0,
  revenue_usd   numeric(12,2) not null default 0,
  refunds_usd   numeric(12,2) not null default 0,
  ad_spend_usd  numeric(12,2) not null default 0,
  impressions   integer not null default 0,
  clicks        integer not null default 0,
  cpa_usd       numeric(12,2),
  roas          numeric(8,3),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (venture_id, date)
);

create trigger metrics_daily_updated_at before update on metrics_daily
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- learnings: portfolio-wide lessons; fed into IDEATE.
-- ---------------------------------------------------------------------------
create table learnings (
  id          uuid primary key default gen_random_uuid(),
  venture_id  uuid references ventures (id) on delete set null,
  kind        text not null check (kind in ('kill', 'scale', 'iterate', 'other')),
  lesson      text not null,
  details     jsonb not null default '{}'::jsonb,
  tags        text[] not null default '{}',
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- digests: weekly summaries.
-- ---------------------------------------------------------------------------
create table digests (
  id            uuid primary key default gen_random_uuid(),
  period_start  date not null,
  period_end    date not null,
  content       jsonb not null default '{}'::jsonb,
  markdown      text,
  emailed_at    timestamptz,
  created_at    timestamptz not null default now(),
  unique (period_start, period_end)
);
