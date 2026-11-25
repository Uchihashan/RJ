-- Store YouTube refresh tokens in Supabase Vault, never in public table columns.
create table if not exists private.rj_youtube_refresh_tokens (
  channel_ref uuid primary key references public.youtube_channels(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  secret_id uuid not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table private.rj_youtube_refresh_tokens enable row level security;
revoke all on private.rj_youtube_refresh_tokens from public, anon, authenticated;
grant select, insert, update, delete on private.rj_youtube_refresh_tokens to service_role;

create or replace function public.rj_store_youtube_refresh_token(
  p_user_id uuid,
  p_channel_id text,
  p_channel_title text,
  p_channel_handle text,
  p_refresh_token text,
  p_scopes text[],
  p_timezone text default 'Asia/Colombo'
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, private, vault, auth
as $$
declare
  v_channel_ref uuid;
  v_secret_id uuid;
  v_secret_name text;
begin
  if p_user_id is null or p_channel_id is null or length(btrim(p_channel_id)) < 3 then
    raise exception 'YouTube user and channel identifiers are required';
  end if;
  if p_refresh_token is null or length(p_refresh_token) < 10 or length(p_refresh_token) > 4096 then
    raise exception 'YouTube refresh token is invalid';
  end if;

  select id into v_channel_ref
  from public.youtube_channels
  where user_id = p_user_id and channel_id = p_channel_id
  for update;

  if v_channel_ref is null then
    insert into public.youtube_channels(
      user_id, channel_id, channel_title, channel_handle,
      encrypted_refresh_token, token_key_version, granted_scopes, timezone, is_active
    ) values (
      p_user_id, p_channel_id, coalesce(nullif(btrim(p_channel_title), ''), 'YouTube channel'),
      nullif(btrim(p_channel_handle), ''), 'vault_pending', 1,
      coalesce(p_scopes, '{}'), coalesce(nullif(p_timezone, ''), 'Asia/Colombo'), true
    ) returning id into v_channel_ref;
  else
    update public.youtube_channels
    set channel_title = coalesce(nullif(btrim(p_channel_title), ''), channel_title),
        channel_handle = nullif(btrim(p_channel_handle), ''),
        granted_scopes = coalesce(p_scopes, '{}'),
        timezone = coalesce(nullif(p_timezone, ''), timezone),
        is_active = true,
        updated_at = now()
    where id = v_channel_ref;
  end if;

  select secret_id into v_secret_id
  from private.rj_youtube_refresh_tokens
  where channel_ref = v_channel_ref
  for update;

  if v_secret_id is null then
    v_secret_name := 'rj_youtube_refresh_' || v_channel_ref::text;
    v_secret_id := vault.create_secret(p_refresh_token, v_secret_name, 'Encrypted RJ YouTube OAuth refresh token');
    insert into private.rj_youtube_refresh_tokens(channel_ref, user_id, secret_id)
    values (v_channel_ref, p_user_id, v_secret_id);
  else
    perform vault.update_secret(v_secret_id, p_refresh_token);
    update private.rj_youtube_refresh_tokens
    set updated_at = now()
    where channel_ref = v_channel_ref;
  end if;

  update public.youtube_channels
  set encrypted_refresh_token = 'vault:' || v_secret_id::text,
      token_key_version = 1,
      updated_at = now()
  where id = v_channel_ref;
  return v_channel_ref;
end;
$$;

create or replace function public.rj_get_youtube_refresh_token(p_channel_ref uuid)
returns text
language sql
security definer
set search_path = pg_catalog, public, private, vault
as $$
  select d.decrypted_secret
  from private.rj_youtube_refresh_tokens t
  join vault.decrypted_secrets d on d.id = t.secret_id
  join public.youtube_channels c on c.id = t.channel_ref and c.user_id = t.user_id
  where t.channel_ref = p_channel_ref and c.is_active = true;
$$;

revoke all on function public.rj_store_youtube_refresh_token(uuid, text, text, text, text, text[], text) from public, anon, authenticated;
revoke all on function public.rj_get_youtube_refresh_token(uuid) from public, anon, authenticated;
grant execute on function public.rj_store_youtube_refresh_token(uuid, text, text, text, text, text[], text) to service_role;
grant execute on function public.rj_get_youtube_refresh_token(uuid) to service_role;
