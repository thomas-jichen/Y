-- apps/core local migration (owner: core). Teams people register on.
--
-- 1. Sign-ups no longer join the shared 'dev' team (9003/9102). A new user
--    creates a team or opens an invite link (team_invites, 0002/0004).
--    Existing memberships are untouched. Dev login (/api/v1/dev/login and
--    /dev/team) places its own users in 'dev' or a named dev team explicitly.
-- 2. public.team_repos: GitHub repos a team links by name (owner/repo, no
--    proof). Members read; owners and admins add and remove, as humans (I7, I11).
-- 3. api.preview_team_invite: what an invite link joins, for the human who
--    opened it (they are not a member yet, so RLS hides the team and invite).
--    Read-only: joining stays api.accept_team_invite behind a Join click (I5).

-- ================================================ 1. stop auto-joining 'dev'

-- No sign-up joins 'dev' any more (GitHub, email, any provider). The trigger
-- from 9003 goes; y_private.join_default_team() stays defined but unused.
drop trigger if exists users_join_default_team on public.users;

-- ======================================================== 2. team repos

create table if not exists public.team_repos (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  -- GitHub naming: owner 1-39 of [A-Za-z0-9-] (no hyphen at either end),
  -- repo 1-100 of [A-Za-z0-9._-], not '.' or '..', no '.git' suffix.
  repo text not null check (
    char_length(repo) <= 140
    and repo ~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9._-]{1,100}$'
    and repo !~ '/\.{1,2}$'
    and repo !~* '\.git$'),
  added_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now()
);
-- GitHub names compare case-insensitively: one row per repo per team.
create unique index if not exists team_repos_team_repo_idx on public.team_repos (team_id, lower(repo));

alter table public.team_repos enable row level security;

drop policy if exists team_repos_select on public.team_repos;
create policy team_repos_select on public.team_repos for select to authenticated
  using (y_private.is_team_member(team_id));
drop policy if exists team_repos_insert on public.team_repos;
create policy team_repos_insert on public.team_repos for insert to authenticated
  with check (y_private.is_team_admin(team_id) and y_private.is_human() and added_by = (select auth.uid()));
drop policy if exists team_repos_delete on public.team_repos;
create policy team_repos_delete on public.team_repos for delete to authenticated
  using (y_private.is_team_admin(team_id) and y_private.is_human());

grant select, delete on public.team_repos to authenticated;
grant insert (team_id, repo, added_by) on public.team_repos to authenticated;
grant all on public.team_repos to service_role;

-- ================================================= 3. invite link preview

-- The team an invite joins, for a human holding its token. No row when the
-- token is unknown, revoked, expired or used up (the caller cannot tell which).
create or replace function api.preview_team_invite(p_token_hash text)
returns table (team_id uuid, slug text, name text, role text, expires_at timestamptz, already_member boolean)
language plpgsql stable security definer
set search_path = ''
as $fn$
begin
  if not y_private.is_human() then
    raise exception using errcode = '42501', message = 'preview_team_invite: requires a human (web) context';
  end if;
  return query
    select t.id, t.slug::text, t.name, i.role, i.expires_at,
           exists (select 1 from public.team_members m where m.team_id = t.id and m.user_id = auth.uid())
      from public.team_invites i join public.teams t on t.id = i.team_id
     where i.token_hash = p_token_hash
       and i.revoked_at is null and i.expires_at > now() and i.uses < i.max_uses;
end
$fn$;
revoke all on function api.preview_team_invite(text) from public;
grant execute on function api.preview_team_invite(text) to authenticated;
