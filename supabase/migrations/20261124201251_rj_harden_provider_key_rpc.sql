drop function if exists public.rj_store_provider_key(text, text);
drop function if exists public.rj_provider_status();

create or replace function private.rj_store_provider_key_internal(p_provider text, p_api_key text)
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
  if p_provider not in ('gemini', 'openrouter') then raise exception 'Unsupported provider'; end if;
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

create or replace function private.rj_provider_status_internal()
returns table(provider text, configured boolean)
language sql
security definer
set search_path = pg_catalog, public, private, auth
as $$
  select p.provider,
         exists (
           select 1 from private.rj_provider_credentials c
           where c.user_id = auth.uid() and c.provider = p.provider
         ) as configured
  from (values ('gemini'::text), ('openrouter'::text)) p(provider);
$$;

create or replace function public.rj_store_provider_key(p_provider text, p_api_key text)
returns boolean
language sql
security invoker
set search_path = pg_catalog, public, private
as $$ select private.rj_store_provider_key_internal(p_provider, p_api_key); $$;

create or replace function public.rj_provider_status()
returns table(provider text, configured boolean)
language sql
security invoker
set search_path = pg_catalog, public, private
as $$ select * from private.rj_provider_status_internal(); $$;

revoke all on function private.rj_store_provider_key_internal(text, text) from public, anon;
revoke all on function private.rj_provider_status_internal() from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.rj_store_provider_key_internal(text, text) to authenticated;
grant execute on function private.rj_provider_status_internal() to authenticated;

revoke all on function public.rj_store_provider_key(text, text) from public, anon;
revoke all on function public.rj_provider_status() from public, anon;
grant execute on function public.rj_store_provider_key(text, text) to authenticated;
grant execute on function public.rj_provider_status() to authenticated;

drop policy if exists "rj_provider_credentials_service_role_only" on private.rj_provider_credentials;
create policy "rj_provider_credentials_service_role_only"
on private.rj_provider_credentials
for all to service_role
using (true)
with check (true);
