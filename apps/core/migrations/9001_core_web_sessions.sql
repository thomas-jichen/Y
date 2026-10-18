-- apps/core local migration (owner: core platform). Applied by createDeps after
-- supabase/migrations. Dev-auth web sessions: only the sha256 of the bearer
-- (`pcl_web_<32 base62>`) is stored. No RLS policies: only the security
-- definer resolver below (and service_role) can read it.
create table if not exists paceline_private.web_sessions (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  revoked_at timestamptz
);
create index if not exists web_sessions_user_idx on paceline_private.web_sessions (user_id);
alter table paceline_private.web_sessions enable row level security;
grant all on paceline_private.web_sessions to service_role;

create or replace function api.resolve_web_session(p_token_hash text)
returns table (user_id uuid, user_status text)
language sql stable security definer
set search_path = ''
as $fn$
  select s.user_id, u.status
  from paceline_private.web_sessions s
  join public.users u on u.id = s.user_id
  where s.token_hash = p_token_hash and s.revoked_at is null and s.expires_at > now()
$fn$;
revoke all on function api.resolve_web_session(text) from public;
grant execute on function api.resolve_web_session(text) to anon, authenticated, service_role;
