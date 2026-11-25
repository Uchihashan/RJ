-- RJ durable stage leases.
-- Prevent concurrent cron/worker invocations from executing and charging the same stage.
-- Feature branch only; do not apply to hosted Supabase without explicit approval.

create or replace function public.rj_claim_job_stage(
  p_job_id uuid,
  p_user_id uuid,
  p_stage_key text,
  p_lease_seconds integer default 600
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_claimed uuid;
  v_lease_seconds integer := greatest(30, least(coalesce(p_lease_seconds, 600), 1800));
begin
  if p_job_id is null or p_user_id is null or p_stage_key is null then
    return false;
  end if;

  update public.job_stages
     set status = 'running',
         locked_at = clock_timestamp(),
         started_at = coalesce(started_at, clock_timestamp()),
         attempt_count = attempt_count + 1,
         error_code = null,
         error_message = null,
         updated_at = clock_timestamp()
   where job_id = p_job_id
     and user_id = p_user_id
     and stage_key = p_stage_key
     and (
       status in ('pending', 'queued', 'waiting_retry')
       or (
         status = 'running'
         and (
           locked_at is null
           or locked_at < clock_timestamp() - make_interval(secs => v_lease_seconds)
         )
       )
     )
  returning id into v_claimed;

  return v_claimed is not null;
end;
$$;

revoke all on function public.rj_claim_job_stage(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.rj_claim_job_stage(uuid, uuid, text, integer) to service_role;

comment on function public.rj_claim_job_stage(uuid, uuid, text, integer) is
  'Atomically leases a user-owned pipeline stage to one trusted worker. Expired running leases can be reclaimed after the bounded lease interval.';
