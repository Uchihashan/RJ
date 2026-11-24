create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  language text not null default 'ta' check (language in ('ta','en','tanglish')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  language text not null default 'ta' check (language in ('ta','en','tanglish')),
  daily_reminder_enabled boolean not null default false,
  daily_reminder_time time,
  timezone text not null default 'Asia/Colombo',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_type text not null check (job_type in ('video_generation','youtube_upload','youtube_publish')),
  status text not null default 'queued' check (status in ('queued','running','waiting_retry','paused','completed','failed','cancelled')),
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  error_code text,
  error_message text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists jobs_user_created_idx on public.jobs(user_id, created_at desc);
create index if not exists jobs_queue_idx on public.jobs(status, run_after) where status in ('queued','waiting_retry');

create table if not exists public.job_attempts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  provider text not null,
  status text not null check (status in ('started','succeeded','failed','rate_limited','quota_exhausted')),
  error_code text,
  safe_error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists job_attempts_job_idx on public.job_attempts(job_id, started_at desc);

create table if not exists public.schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  title text not null,
  scheduled_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled','processing','published','failed','cancelled')),
  youtube_video_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists schedules_user_time_idx on public.schedules(user_id, scheduled_at);

alter table public.profiles enable row level security;
alter table public.user_settings enable row level security;
alter table public.jobs enable row level security;
alter table public.job_attempts enable row level security;
alter table public.schedules enable row level security;

create policy "profiles_select_own" on public.profiles for select to authenticated using (auth.uid() = id);
create policy "profiles_insert_own" on public.profiles for insert to authenticated with check (auth.uid() = id);
create policy "profiles_update_own" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

create policy "settings_select_own" on public.user_settings for select to authenticated using (auth.uid() = user_id);
create policy "settings_insert_own" on public.user_settings for insert to authenticated with check (auth.uid() = user_id);
create policy "settings_update_own" on public.user_settings for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "settings_delete_own" on public.user_settings for delete to authenticated using (auth.uid() = user_id);

create policy "jobs_select_own" on public.jobs for select to authenticated using (auth.uid() = user_id);
create policy "attempts_select_own_jobs" on public.job_attempts for select to authenticated
using (exists (select 1 from public.jobs j where j.id = job_id and j.user_id = auth.uid()));

create policy "schedules_select_own" on public.schedules for select to authenticated using (auth.uid() = user_id);
create policy "schedules_insert_own" on public.schedules for insert to authenticated with check (auth.uid() = user_id);
create policy "schedules_update_own" on public.schedules for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "schedules_delete_own" on public.schedules for delete to authenticated using (auth.uid() = user_id);
