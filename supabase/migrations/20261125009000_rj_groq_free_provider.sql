-- Add Groq as a supported encrypted credential for RJ's Free-only text fallback.
-- Feature branch only. Do not apply to hosted Supabase without explicit approval.

alter table private.rj_provider_credentials
  drop constraint if exists rj_provider_credentials_provider_check;

alter table private.rj_provider_credentials
  add constraint rj_provider_credentials_provider_check
  check (provider in ('gemini', 'openrouter', 'groq'));

create or replace function public.rj_store_provider_key(p_provider text, p_api_key text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, private, vault, auth
as $$
declare
  v_user_id uuid := auth.uid();
  v_secret_id uuid;
  v_secret_name text;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_provider not in ('gemini', 'openrouter', 'groq') then raise exception 'Unsupported provider'; end if;
  if p_api_key is null or length(btrim(p_api_key)) < 20 or length(btrim(p_api_key)) > 512 then
    raise exception 'API key length is invalid';
  end if;

  select secret_id into v_secret_id
  from private.rj_provider_credentials
  where user_id = v_user_id and provider = p_provider
  for update;

  if v_secret_id is null then
    v_secret_name := 'rj_provider_' || v_user_id::text || '_' || p_provider;
    v_secret_id := vault.create_secret(btrim(p_api_key), v_secret_name, 'Encrypted RJ AI provider credential');
    insert into private.rj_provider_credentials(user_id, provider, secret_id)
    values (v_user_id, p_provider, v_secret_id);
  else
    perform vault.update_secret(v_secret_id, btrim(p_api_key));
    update private.rj_provider_credentials
    set updated_at = now()
    where user_id = v_user_id and provider = p_provider;
  end if;
  return true;
end;
$$;

create or replace function public.rj_provider_status()
returns table(provider text, configured boolean)
language sql
security definer
set search_path = pg_catalog, public, private
as $$
  select p.provider,
         exists (
           select 1 from private.rj_provider_credentials c
           where c.user_id = auth.uid() and c.provider = p.provider
         ) as configured
  from (values ('gemini'::text), ('openrouter'::text), ('groq'::text)) p(provider);
$$;

create or replace function public.rj_get_provider_keys(p_user_id uuid)
returns table(provider text, api_key text)
language sql
security definer
set search_path = pg_catalog, public, private, vault
as $$
  select c.provider, d.decrypted_secret
  from private.rj_provider_credentials c
  join vault.decrypted_secrets d on d.id = c.secret_id
  where c.user_id = p_user_id;
$$;

create or replace function public.rj_requeue_paused_jobs(p_limit integer default 5)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, private, pgmq
as $$
declare
  v_job record;
  v_count integer := 0;
begin
  for v_job in
    select j.id, j.user_id
    from public.jobs j
    where j.status = 'paused'
      and j.error_code in ('provider_not_configured', 'paid_provider_consent_required')
      and exists (
        select 1 from private.rj_provider_credentials c
        where c.user_id = j.user_id and c.provider in ('openrouter', 'groq')
      )
    order by j.created_at
    limit least(greatest(coalesce(p_limit, 5), 1), 10)
    for update of j skip locked
  loop
    update public.jobs
    set status = 'queued', error_code = null, error_message = null, updated_at = now()
    where id = v_job.id;
    perform pgmq.send('rj_jobs', jsonb_build_object('job_id', v_job.id::text, 'user_id', v_job.user_id::text));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.rj_store_provider_key(text, text) from public, anon;
revoke all on function public.rj_provider_status() from public, anon;
revoke all on function public.rj_get_provider_keys(uuid) from public, anon, authenticated;
revoke all on function public.rj_requeue_paused_jobs(integer) from public, anon, authenticated;
grant execute on function public.rj_store_provider_key(text, text) to authenticated;
grant execute on function public.rj_provider_status() to authenticated;
grant execute on function public.rj_get_provider_keys(uuid) to service_role;
grant execute on function public.rj_requeue_paused_jobs(integer) to service_role;

update public.provider_capability_catalog
set availability = 'available',
    notes = 'Use only with a Groq Free-tier organization and never upgrade to Developer/PayGo. RJ falls back on free-tier quota responses.'
where provider_key = 'groq_free' and capability = 'text' and model_key = 'openai/gpt-oss-20b';
