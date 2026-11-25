-- RJ permission grants and auditable tool execution records.
-- Safe to apply after the autonomous operations migration; not deployed by this commit.

create table if not exists public.agent_tool_permissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  tool_key text not null check (tool_key = any (array[
    'video.create','reminder.create','navigation.open','youtube.upload',
    'youtube.schedule','provider.connect','provider.disconnect'
  ])),
  enabled boolean not null default false,
  requires_confirmation boolean not null default true,
  granted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, tool_key),
  check (not enabled or granted_at is not null)
);

alter table public.agent_tool_permissions enable row level security;
drop policy if exists "Users can view their own tool permissions" on public.agent_tool_permissions;
create policy "Users can view their own tool permissions"
  on public.agent_tool_permissions for select to authenticated
  using (user_id = (select auth.uid()));
revoke insert, update, delete on public.agent_tool_permissions from anon, authenticated;
grant select on public.agent_tool_permissions to authenticated;
grant select, insert, update, delete on public.agent_tool_permissions to service_role;

create table if not exists public.agent_action_audit (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  tool_key text not null,
  status text not null check (status = any (array[
    'proposed','confirmed','succeeded','failed','cancelled','denied'
  ])),
  safe_arguments jsonb not null default '{}'::jsonb,
  result_summary text,
  error_code text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique(user_id, request_id)
);

create index if not exists agent_action_audit_user_created_idx
  on public.agent_action_audit(user_id, created_at desc);
create index if not exists agent_action_audit_status_idx
  on public.agent_action_audit(status, created_at desc);

alter table public.agent_action_audit enable row level security;
drop policy if exists "Users can view their own agent action audit" on public.agent_action_audit;
create policy "Users can view their own agent action audit"
  on public.agent_action_audit for select to authenticated
  using (user_id = (select auth.uid()));
revoke insert, update, delete on public.agent_action_audit from anon, authenticated;
grant select on public.agent_action_audit to authenticated;
grant select, insert, update, delete on public.agent_action_audit to service_role;
