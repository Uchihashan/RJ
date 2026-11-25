-- Enforce RJ agent tool permissions and auditable confirmed actions.
-- Apply only after reviewing this feature-branch migration.

alter table public.agent_action_audit
  drop constraint if exists agent_action_audit_tool_key_check;
alter table public.agent_action_audit
  add constraint agent_action_audit_tool_key_check
  check (tool_key = any (array[
    'video.create','reminder.create','navigation.open','youtube.upload',
    'youtube.schedule','provider.connect','provider.disconnect'
  ]));

create index if not exists agent_tool_permissions_user_enabled_idx
  on public.agent_tool_permissions(user_id, enabled, tool_key);

comment on table public.agent_tool_permissions is
  'Per-user allowlist for RJ agent tools. New tools are disabled until explicitly enabled by the user.';
comment on table public.agent_action_audit is
  'Append-oriented audit trail for user-confirmed RJ agent actions. safe_arguments must never contain credentials or secrets.';
