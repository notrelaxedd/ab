-- RLS on everything. Only the worker (table owner / service role) touches these
-- tables; anon and authenticated get nothing. A restricted read-only role for the
-- Phase 6 dashboard is added in a later migration.

alter table settings      enable row level security;
alter table ideas         enable row level security;
alter table ventures      enable row level security;
alter table tasks         enable row level security;
alter table ledger        enable row level security;
alter table actions_log   enable row level security;
alter table reviews       enable row level security;
alter table metrics_daily enable row level security;
alter table learnings     enable row level security;
alter table digests       enable row level security;

-- Supabase grants anon/authenticated broad default privileges on public objects.
-- RLS (with no policies) already hides table rows, but views and functions are
-- not covered by RLS the same way, so revoke explicitly.
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
    end if;
  end loop;
end;
$$;

-- Objects created by LATER migrations must not be exposed either. Supabase's ALTER DEFAULT PRIVILEGES grant
-- ALL on new tables, sequences and functions in public to anon/authenticated, and Postgres gives PUBLIC
-- EXECUTE on new functions. Revoke both for the role running migrations (postgres on Supabase). A later
-- migration that needs service_role access must grant it explicitly. (The function revoke from public is
-- global: a schema-scoped one cannot remove the built-in default.)
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
    end if;
  end loop;
end;
$$;
alter default privileges revoke execute on functions from public;

revoke all on function claim_task(text) from public;
revoke all on function set_updated_at() from public;

-- Keep the service role able to use everything (Supabase's own worker role).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on all tables in schema public to service_role;
    grant all on all sequences in schema public to service_role;
    grant execute on function claim_task(text) to service_role;
  end if;
end;
$$;
