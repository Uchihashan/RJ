-- RJ autonomous video operations: durable stages, provider health, destinations and schedules.
-- Apply only after reviewing on the feature branch; this migration is not deployed automatically.

create extension if not exists pgcrypto;

alter table public.jobs
  add column if not exists idempotency_key text,
  add column if not exists current_stage text,
  add column if not exists deadline_at timestamptz,
  add column if not exists last_heartbeat_at timestamptz;

create unique index if not exists jobs_user_idempotency_key_uidx
  on public.jobs(user_id, idempotency_key)
  where idempotency_key is not null;

alter table public.jobs drop constraint if exists jobs_status_check;
alter table public.jobs add constraint jobs_status_check
  check (status = any (array[
    'queued','running','waiting_retry','paused','blocked','completed','failed','cancelled'
  ]));

create table if not exists public.job_stages (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  stage_key text not null check (stage_key = any (array[
    'brief','script_storyboard','scene_assets','voice_audio','captions',
    'timeline_edit','render_export','quality_check','metadata_thumbnail',
    'youtube_upload','youtube_schedule_verify'
  ])),
  stage_order smallint not null check (stage_order between 1 and 11),
  status text not null default 'pending' check (status = any (array[
    'pending','queued','running','waiting_retry','succeeded','blocked','failed','skipped'
  ])),
  required_capability text,
  selected_provider text,
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  idempotency_key text not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(job_id, stage_key),
  unique(user_id, idempotency_key)
);

create index if not exists job_stages_ready_idx
  on public.job_stages(status, run_after, stage_order)
  where status in ('pending','queued','waiting_retry');

alter table public.job_stages enable row level security;
drop policy if exists "Users can view their own job stages" on public.job_stages;
create policy "Users can view their own job stages"
  on public.job_stages for select to authenticated
  using (user_id = (select auth.uid()));

create table if not exists public.provider_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_key text not null,
  display_name text not null,
  capabilities text[] not null default '{}',
  enabled boolean not null default true,
  priority integer not null default 100,
  budget_mode text not null default 'free_only'
    check (budget_mode in ('free_only','paid_allowed')),
  encrypted_credentials text,
  credential_version integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, provider_key)
);

alter table public.provider_connections enable row level security;
-- Credentials are only read/written by trusted server functions using service_role.
revoke all on public.provider_connections from anon, authenticated;
grant select, insert, update, delete on public.provider_connections to service_role;

create table if not exists public.provider_health (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_key text not null,
  capability text not null,
  state text not null default 'available'
    check (state in ('available','cooldown','needs_attention','disabled')),
  cooldown_until timestamptz,
  last_http_status integer,
  last_error_code text,
  updated_at timestamptz not null default now(),
  unique(user_id, provider_key, capability)
);

alter table public.provider_health enable row level security;
revoke all on public.provider_health from anon, authenticated;
grant select, insert, update, delete on public.provider_health to service_role;

create table if not exists public.youtube_channels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  channel_id text not null,
  channel_title text not null,
  channel_handle text,
  encrypted_refresh_token text not null,
  token_key_version integer not null default 1,
  granted_scopes text[] not null default '{}',
  timezone text not null default 'Asia/Colombo',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, channel_id)
);

alter table public.youtube_channels enable row level security;
-- OAuth refresh tokens must never be exposed to the mobile client.
revoke all on public.youtube_channels from anon, authenticated;
grant select, insert, update, delete on public.youtube_channels to service_role;

alter table public.schedules
  add column if not exists channel_ref uuid references public.youtube_channels(id) on delete set null,
  add column if not exists timezone text not null default 'Asia/Colombo',
  add column if not exists plan_group_id uuid,
  add column if not exists publish_visibility text not null default 'private'
    check (publish_visibility in ('private','unlisted','public')),
  add column if not exists generation_start_at timestamptz,
  add column if not exists last_error_code text,
  add column if not exists last_error_message text;

create index if not exists schedules_due_idx
  on public.schedules(scheduled_at)
  where status in ('scheduled','processing');

create index if not exists schedules_channel_due_idx
  on public.schedules(channel_ref, scheduled_at)
  where status in ('scheduled','processing');

-- The worker remains the only actor allowed to move pipeline stages and publish.
grant select, insert, update, delete on public.job_stages to service_role;
