-- Spend views. security_invoker so they respect the caller's RLS/grants
-- (a plain view would run with the owner's rights and leak ledger rows).

-- Open reservation per (venture, category, ref) = reservations - releases, floored at 0.
create view ledger_open_reservations
with (security_invoker = true) as
select venture_id,
       category,
       ref,
       greatest(
         coalesce(sum(amount_usd) filter (where kind = 'reservation'), 0)
         - coalesce(sum(amount_usd) filter (where kind = 'release'), 0),
         0
       )::numeric(12,2) as open_usd
from ledger
where kind in ('reservation', 'release')
group by venture_id, category, ref;

-- venture_spend: remaining = cap - actuals - open reservations.
create view venture_spend
with (security_invoker = true) as
select v.id   as venture_id,
       v.slug,
       v.status,
       v.budget_cap_usd,
       coalesce(a.actual_usd, 0)::numeric(12,2)   as actual_usd,
       coalesce(r.reserved_usd, 0)::numeric(12,2) as reserved_usd,
       (v.budget_cap_usd - coalesce(a.actual_usd, 0) - coalesce(r.reserved_usd, 0))::numeric(12,2)
         as remaining_usd
from ventures v
left join (
  select venture_id, sum(amount_usd) as actual_usd
  from ledger where kind = 'actual'
  group by venture_id
) a on a.venture_id = v.id
left join (
  select venture_id, sum(open_usd) as reserved_usd
  from ledger_open_reservations
  group by venture_id
) r on r.venture_id = v.id;

-- monthly_spend: portfolio spend in the current calendar month (settings.timezone)
-- vs monthly_budget_usd. Open reservations count in full regardless of when they
-- were made, because they are money that may still be spent.
create view monthly_spend
with (security_invoker = true) as
with s as (
  select monthly_budget_usd,
         date_trunc('month', now() at time zone timezone) at time zone timezone as month_start
  from settings where id = 1
),
actuals as (
  select
    coalesce(sum(l.amount_usd), 0)                                          as actual_usd,
    coalesce(sum(l.amount_usd) filter (where l.category = 'ads'), 0)        as actual_ads_usd,
    coalesce(sum(l.amount_usd) filter (where l.category = 'runtime_ai'), 0) as actual_runtime_ai_usd,
    coalesce(sum(l.amount_usd) filter (where l.category = 'other'), 0)      as actual_other_usd
  from ledger l, s
  where l.kind = 'actual' and l.created_at >= s.month_start
),
reserved as (
  select coalesce(sum(open_usd), 0) as reserved_usd
  from ledger_open_reservations
)
select s.month_start,
       s.monthly_budget_usd,
       actuals.actual_usd::numeric(12,2),
       actuals.actual_ads_usd::numeric(12,2),
       actuals.actual_runtime_ai_usd::numeric(12,2),
       actuals.actual_other_usd::numeric(12,2),
       reserved.reserved_usd::numeric(12,2),
       (s.monthly_budget_usd - actuals.actual_usd - reserved.reserved_usd)::numeric(12,2) as remaining_usd
from s, actuals, reserved;
