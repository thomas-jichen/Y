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
-- 4. public.user_posting_team: the one team a person's agents post to
--    (captured activities, create_post, team-visibility post_activity,
--    scrolls, the brief's team and repo-key salt). It used to be the oldest
--    membership; now it is chosen by the human. Core resolves it
--    (postingTeamId in messaging/util.ts): the chosen team while still a
--    member, else the only team, else none (private). Adding a second membership pins the first, so a
--    new team never takes over silently; existing multi-team users are pinned
--    to the team they post to today (their oldest membership).

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

-- ===================================================== 4. posting team

create table if not exists public.user_posting_team (
  user_id uuid primary key references public.users (id) on delete cascade,
  team_id uuid not null references public.teams (id) on delete cascade,
  updated_at timestamptz not null default now()
);
create index if not exists user_posting_team_team_idx on public.user_posting_team (team_id);

alter table public.user_posting_team enable row level security;

-- Your own row only; changing it is a human act (I11: agents never pick where they publish).
drop policy if exists user_posting_team_select on public.user_posting_team;
create policy user_posting_team_select on public.user_posting_team for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists user_posting_team_insert on public.user_posting_team;
create policy user_posting_team_insert on public.user_posting_team for insert to authenticated
  with check (user_id = (select auth.uid()) and y_private.is_human() and y_private.is_team_member(team_id));
drop policy if exists user_posting_team_update on public.user_posting_team;
create policy user_posting_team_update on public.user_posting_team for update to authenticated
  using (user_id = (select auth.uid()) and y_private.is_human())
  with check (user_id = (select auth.uid()) and y_private.is_human() and y_private.is_team_member(team_id));
drop policy if exists user_posting_team_delete on public.user_posting_team;
create policy user_posting_team_delete on public.user_posting_team for delete to authenticated
  using (user_id = (select auth.uid()) and y_private.is_human());

grant select, delete on public.user_posting_team to authenticated;
grant insert (user_id, team_id, updated_at), update (team_id, updated_at) on public.user_posting_team to authenticated;
grant all on public.user_posting_team to service_role;

-- A second membership (invite, new team, dev routes) pins the team the user posted to until
-- now, so joining or creating a team never moves their agents' work by itself.
create or replace function y_private.pin_posting_team() returns trigger
language plpgsql security definer
set search_path = ''
as $fn$
declare
  v_prev uuid;
begin
  if exists (select 1 from public.user_posting_team p where p.user_id = new.user_id) then
    return new;
  end if;
  -- Only when this is the second membership: with one team before, that team was where they posted.
  if (select count(*) from public.team_members m where m.user_id = new.user_id and m.team_id <> new.team_id) <> 1 then
    return new;
  end if;
  select m.team_id into v_prev from public.team_members m where m.user_id = new.user_id and m.team_id <> new.team_id;
  insert into public.user_posting_team (user_id, team_id) values (new.user_id, v_prev)
  on conflict (user_id) do nothing;
  return new;
end
$fn$;
revoke all on function y_private.pin_posting_team() from public;

drop trigger if exists team_members_pin_posting_team on public.team_members;
create trigger team_members_pin_posting_team after insert on public.team_members
  for each row execute function y_private.pin_posting_team();

-- Users already on several teams keep posting where they do today (the oldest membership),
-- now as a visible, changeable choice.
insert into public.user_posting_team (user_id, team_id)
select distinct on (m.user_id) m.user_id, m.team_id
  from public.team_members m
 where m.user_id in (select user_id from public.team_members group by user_id having count(*) > 1)
 order by m.user_id, m.joined_at, m.team_id
on conflict (user_id) do nothing;
