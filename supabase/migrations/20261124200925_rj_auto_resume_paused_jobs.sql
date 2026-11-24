create or replace function public.rj_requeue_paused_jobs(p_limit integer default 5)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, pgmq
as $$
declare
  v_job record;
  v_count integer := 0;
begin
  for v_job in
    select id, user_id
    from public.jobs
    where status = 'paused'
      and error_code = 'provider_not_configured'
    order by created_at
    limit least(greatest(coalesce(p_limit, 5), 1), 10)
    for update skip locked
  loop
    update public.jobs
    set status = 'queued',
        error_code = null,
        error_message = null,
        updated_at = now()
    where id = v_job.id;

    perform pgmq.send('rj_jobs', jsonb_build_object('job_id', v_job.id::text, 'user_id', v_job.user_id::text));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.rj_requeue_paused_jobs(integer) from public, anon, authenticated;
grant execute on function public.rj_requeue_paused_jobs(integer) to service_role;
