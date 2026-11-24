create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create schema if not exists private;

create or replace function private.enqueue_rj_video_job()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pgmq, auth
as $$
begin
  if new.job_type = 'video_generation' and new.status = 'queued' then
    if auth.uid() is not null and auth.uid() <> new.user_id then
      raise exception 'Cannot enqueue a job for another user';
    end if;
    perform pgmq.send('rj_jobs', jsonb_build_object('job_id', new.id::text, 'user_id', new.user_id::text));
  end if;
  return new;
end;
$$;

revoke all on function private.enqueue_rj_video_job() from public, anon, authenticated;
drop trigger if exists trg_enqueue_rj_video_job on public.jobs;
create trigger trg_enqueue_rj_video_job
after insert on public.jobs
for each row execute function private.enqueue_rj_video_job();

create or replace function public.rj_read_jobs(p_qty integer default 2)
returns setof pgmq.message_record
language sql security definer
set search_path = pg_catalog, pgmq
as $$ select * from pgmq.read('rj_jobs', 120, least(greatest(coalesce(p_qty, 2), 1), 2), null); $$;

create or replace function public.rj_archive_job(p_msg_id bigint)
returns boolean language sql security definer
set search_path = pg_catalog, pgmq
as $$ select pgmq.archive('rj_jobs', p_msg_id); $$;

create or replace function public.rj_retry_job(p_message jsonb, p_delay_seconds integer default 600)
returns bigint language sql security definer
set search_path = pg_catalog, pgmq
as $$ select pgmq.send('rj_jobs', p_message, greatest(60, least(coalesce(p_delay_seconds, 600), 86400))); $$;

create or replace function public.rj_validate_worker_token(p_token text)
returns boolean language sql security definer
set search_path = pg_catalog, vault
as $$
  select p_token is not null and exists (
    select 1 from vault.decrypted_secrets
    where name = 'rj_worker_cron_token' and decrypted_secret = p_token
  );
$$;

revoke all on function public.rj_read_jobs(integer) from public, anon, authenticated;
revoke all on function public.rj_archive_job(bigint) from public, anon, authenticated;
revoke all on function public.rj_retry_job(jsonb, integer) from public, anon, authenticated;
revoke all on function public.rj_validate_worker_token(text) from public, anon, authenticated;
grant execute on function public.rj_read_jobs(integer) to service_role;
grant execute on function public.rj_archive_job(bigint) to service_role;
grant execute on function public.rj_retry_job(jsonb, integer) to service_role;
grant execute on function public.rj_validate_worker_token(text) to service_role;

select vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'rj_worker_cron_token', 'Internal token used only by the RJ scheduled queue worker');
