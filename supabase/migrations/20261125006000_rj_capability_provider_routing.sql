-- RJ capability-aware provider routing, paid-use consent, and provider attempt history.
-- Feature-branch migration only. Do not apply to hosted Supabase without explicit approval.

create table if not exists public.provider_user_policies (
  user_id uuid primary key references auth.users(id) on delete cascade,
  allow_paid_providers boolean not null default false,
  monthly_budget_usd numeric(12,4) not null default 0 check (monthly_budget_usd >= 0),
  updated_at timestamptz not null default now(),
  check (not allow_paid_providers or monthly_budget_usd > 0)
);

alter table public.provider_user_policies enable row level security;
drop policy if exists "Users can view their own provider policy" on public.provider_user_policies;
create policy "Users can view their own provider policy"
  on public.provider_user_policies for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "Users can create their own provider policy" on public.provider_user_policies;
create policy "Users can create their own provider policy"
  on public.provider_user_policies for insert to authenticated
  with check (user_id = (select auth.uid()));
drop policy if exists "Users can update their own provider policy" on public.provider_user_policies;
create policy "Users can update their own provider policy"
  on public.provider_user_policies for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
grant select, insert, update on public.provider_user_policies to authenticated;

create table if not exists public.provider_capability_catalog (
  provider_key text not null,
  capability text not null check (capability = any (array[
    'text','image','video','speech','transcription','captions',
    'media_assembly','render','storage','youtube_upload','youtube_schedule','media_analysis'
  ])),
  model_key text not null,
  output_formats text[] not null default '{}',
  pricing_mode text not null check (pricing_mode = any (array[
    'free_route','free_tier','account_dependent','paid'
  ])),
  availability text not null default 'available' check (availability = any (array[
    'available','preview','region_limited','not_integrated'
  ])),
  notes text not null default '',
  updated_at timestamptz not null default now(),
  primary key(provider_key, capability, model_key)
);

alter table public.provider_capability_catalog enable row level security;
drop policy if exists "Authenticated users can view provider capability catalog" on public.provider_capability_catalog;
create policy "Authenticated users can view provider capability catalog"
  on public.provider_capability_catalog for select to authenticated using (true);
grant select on public.provider_capability_catalog to authenticated;
grant select, insert, update, delete on public.provider_capability_catalog to service_role;

insert into public.provider_capability_catalog
  (provider_key, capability, model_key, output_formats, pricing_mode, availability, notes)
values
  ('openrouter','text','openrouter/free',array['text'],'free_route','available',
   'Uses only OpenRouter free-model routing; model availability and free quotas can change.'),
  ('gemini','text','gemini-3.5-flash-lite',array['text'],'account_dependent','available',
   'Account billing tier may make usage billable; RJ requires explicit paid-provider consent and a positive monthly budget before using it.')
on conflict (provider_key, capability, model_key) do update set
  output_formats = excluded.output_formats,
  pricing_mode = excluded.pricing_mode,
  availability = excluded.availability,
  notes = excluded.notes,
  updated_at = now();

create table if not exists public.provider_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  stage_key text,
  capability text not null check (capability = any (array[
    'text','image','video','speech','transcription','captions',
    'media_assembly','render','storage','youtube_upload','youtube_schedule','media_analysis'
  ])),
  provider_key text not null,
  model_key text not null,
  attempt_number integer not null default 1 check (attempt_number > 0),
  status text not null check (status = any (array[
    'started','succeeded','quota_exhausted','rate_limited','failed','needs_attention','cancelled'
  ])),
  http_status integer,
  error_code text,
  safe_error_message text,
  estimated_cost_usd numeric(12,6),
  charged_cost_usd numeric(12,6),
  idempotency_key text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists provider_attempts_user_created_idx
  on public.provider_attempts(user_id, created_at desc);
create index if not exists provider_attempts_job_stage_idx
  on public.provider_attempts(job_id, stage_key, attempt_number);
alter table public.provider_attempts enable row level security;
drop policy if exists "Users can view their own provider attempts" on public.provider_attempts;
create policy "Users can view their own provider attempts"
  on public.provider_attempts for select to authenticated
  using (user_id = (select auth.uid()));
revoke insert, update, delete on public.provider_attempts from anon, authenticated;
grant select on public.provider_attempts to authenticated;
grant select, insert, update, delete on public.provider_attempts to service_role;

comment on table public.provider_user_policies is
  'Paid provider use is disabled by default. A positive monthly budget and explicit opt-in are both required.';
comment on table public.provider_attempts is
  'Provider decision history. Never store API keys, raw prompts, OAuth tokens, or secret request payloads here.';
