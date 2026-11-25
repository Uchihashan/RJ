-- Per-channel YouTube daily publishing guard.
-- Default is two successful uploads per channel-local calendar day.
create table if not exists public.youtube_upload_limits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  channel_ref uuid not null references public.youtube_channels(id) on delete cascade,
  daily_limit integer not null default 2 check (daily_limit between 1 and 50),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel_ref),
  unique (user_id, channel_ref)
);

create table if not exists public.youtube_upload_daily_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  channel_ref uuid not null references public.youtube_channels(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  upload_day date not null,
  status text not null default 'reserved'
    check (status in ('reserved', 'published', 'failed', 'expired')),
  youtube_video_id text,
  reserved_at timestamptz not null default now(),
  published_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (channel_ref, job_id)
);

create index if not exists youtube_upload_daily_usage_count_idx
  on public.youtube_upload_daily_usage(channel_ref, upload_day, status);

alter table public.youtube_upload_limits enable row level security;
alter table public.youtube_upload_daily_usage enable row level security;
revoke all on public.youtube_upload_limits from anon, authenticated;
revoke all on public.youtube_upload_daily_usage from anon, authenticated;
grant select, insert, update, delete on public.youtube_upload_limits to service_role;
grant select, insert, update, delete on public.youtube_upload_daily_usage to service_role;

create or replace function public.rj_reserve_youtube_upload(
  p_user_id uuid,
  p_channel_ref uuid,
  p_job_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_timezone text;
  v_upload_day date;
  v_daily_limit integer;
  v_used integer;
  v_existing public.youtube_upload_daily_usage%rowtype;
begin
  -- Lock the channel row so concurrent workers cannot overbook the daily limit.
  select timezone into v_timezone
  from public.youtube_channels
  where id = p_channel_ref and user_id = p_user_id and is_active = true
  for update;

  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'youtube_channel_unavailable');
  end if;

  v_upload_day := (now() at time zone v_timezone)::date;

  insert into public.youtube_upload_limits(user_id, channel_ref, daily_limit)
  values (p_user_id, p_channel_ref, 2)
  on conflict (channel_ref) do nothing;

  select daily_limit into v_daily_limit
  from public.youtube_upload_limits
  where channel_ref = p_channel_ref and user_id = p_user_id;

  if not found then
    raise exception 'YouTube upload limit configuration is unavailable';
  end if;

  select * into v_existing
  from public.youtube_upload_daily_usage
  where channel_ref = p_channel_ref and job_id = p_job_id
  for update;

  if found and v_existing.status = 'published' then
    return jsonb_build_object(
      'allowed', false, 'reason', 'already_published',
      'limit', v_daily_limit, 'used', null, 'remaining', null,
      'youtube_video_id', v_existing.youtube_video_id
    );
  end if;

  if found and v_existing.status = 'reserved'
     and v_existing.upload_day = v_upload_day
     and v_existing.reserved_at > now() - interval '2 hours' then
    select count(*)::integer into v_used
    from public.youtube_upload_daily_usage
    where channel_ref = p_channel_ref
      and upload_day = v_upload_day
      and status in ('reserved', 'published');
    return jsonb_build_object(
      'allowed', true, 'reason', 'reservation_reused',
      'limit', v_daily_limit, 'used', v_used,
      'remaining', greatest(v_daily_limit - v_used, 0),
      'upload_day', v_upload_day
    );
  end if;

  update public.youtube_upload_daily_usage
  set status = 'expired', updated_at = now()
  where channel_ref = p_channel_ref
    and upload_day = v_upload_day
    and status = 'reserved'
    and reserved_at <= now() - interval '2 hours';

  select count(*)::integer into v_used
  from public.youtube_upload_daily_usage
  where channel_ref = p_channel_ref
    and upload_day = v_upload_day
    and status in ('reserved', 'published');

  if v_used >= v_daily_limit then
    return jsonb_build_object(
      'allowed', false, 'reason', 'daily_limit_reached',
      'limit', v_daily_limit, 'used', v_used, 'remaining', 0,
      'upload_day', v_upload_day
    );
  end if;

  insert into public.youtube_upload_daily_usage(
    user_id, channel_ref, job_id, upload_day, status, reserved_at, updated_at
  ) values (
    p_user_id, p_channel_ref, p_job_id, v_upload_day, 'reserved', now(), now()
  )
  on conflict (channel_ref, job_id) do update set
    upload_day = excluded.upload_day,
    status = 'reserved',
    youtube_video_id = null,
    reserved_at = now(),
    published_at = null,
    updated_at = now();

  v_used := v_used + 1;
  return jsonb_build_object(
    'allowed', true, 'reason', 'reserved',
    'limit', v_daily_limit, 'used', v_used,
    'remaining', greatest(v_daily_limit - v_used, 0),
    'upload_day', v_upload_day
  );
end;
$$;

create or replace function public.rj_complete_youtube_upload(
  p_user_id uuid,
  p_channel_ref uuid,
  p_job_id uuid,
  p_youtube_video_id text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.youtube_upload_daily_usage
  set status = 'published',
      youtube_video_id = p_youtube_video_id,
      published_at = now(),
      updated_at = now()
  where user_id = p_user_id
    and channel_ref = p_channel_ref
    and job_id = p_job_id
    and status = 'reserved';
  return found;
end;
$$;

create or replace function public.rj_release_youtube_upload(
  p_user_id uuid,
  p_channel_ref uuid,
  p_job_id uuid
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.youtube_upload_daily_usage
  set status = 'failed', updated_at = now()
  where user_id = p_user_id
    and channel_ref = p_channel_ref
    and job_id = p_job_id
    and status = 'reserved';
  return found;
end;
$$;

revoke all on function public.rj_reserve_youtube_upload(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.rj_complete_youtube_upload(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.rj_release_youtube_upload(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.rj_reserve_youtube_upload(uuid, uuid, uuid) to service_role;
grant execute on function public.rj_complete_youtube_upload(uuid, uuid, uuid, text) to service_role;
grant execute on function public.rj_release_youtube_upload(uuid, uuid, uuid) to service_role;
