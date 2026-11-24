drop function if exists public.rj_read_jobs(integer);

create function public.rj_read_jobs(p_qty integer default 2)
returns table(
  msg_id bigint,
  read_ct integer,
  enqueued_at timestamptz,
  vt timestamptz,
  message jsonb,
  headers jsonb
)
language sql
security definer
set search_path = pg_catalog, pgmq
as $$
  select m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message, m.headers
  from pgmq.read('rj_jobs', 120, least(greatest(coalesce(p_qty, 2), 1), 2), null) m;
$$;

revoke all on function public.rj_read_jobs(integer) from public, anon, authenticated;
grant execute on function public.rj_read_jobs(integer) to service_role;
