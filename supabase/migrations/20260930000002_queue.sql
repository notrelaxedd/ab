-- claim_task: atomically claim the oldest runnable task for a worker.
-- Returns zero rows when the kill switch is on (second line of defence; the
-- worker also checks settings before calling) or when nothing is runnable.
-- Runnable = pending/deferred, run_after reached, and either no venture or a
-- venture that is active/scaling (paused and killed ventures never run).
create or replace function claim_task(p_worker_id text)
returns setof tasks
language plpgsql
set search_path = public
as $$
begin
  if p_worker_id is null or length(p_worker_id) = 0 then
    raise exception 'claim_task: worker_id is required';
  end if;

  if coalesce((select s.kill_switch from settings s where s.id = 1), true) then
    return;
  end if;

  return query
  with next_task as (
    select t.id
    from tasks t
    left join ventures v on v.id = t.venture_id
    where t.status in ('pending', 'deferred')
      and t.run_after <= now()
      and (t.venture_id is null or v.status in ('active', 'scaling'))
    order by t.created_at, t.id
    for update of t skip locked
    limit 1
  )
  update tasks t
     set status    = 'running',
         locked_by = p_worker_id,
         locked_at = now(),
         attempt   = t.attempt + 1,
         error     = null
    from next_task
   where t.id = next_task.id
  returning t.*;
end;
$$;
