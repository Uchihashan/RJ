-- One-time OAuth state and PKCE verifier for secure YouTube account linking.
create table if not exists public.youtube_oauth_states (
  state_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  code_verifier text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.youtube_oauth_states enable row level security;
revoke all on public.youtube_oauth_states from anon, authenticated;
grant select, insert, update, delete on public.youtube_oauth_states to service_role;
create index if not exists youtube_oauth_states_expiry_idx on public.youtube_oauth_states(expires_at);
