-- apps/core local migration (owner: core). Red-team fixes: RLS, triggers and
-- membership guards. Applied after every other migration. Every statement is
-- create-or-replace / drop-if-exists, so the file is safe to re-run.
--
-- 1. Default team (9003). Every new user that dev login did not create
--    (GitHub, or any other provider) still joins the team with slug 'dev'
--    when it exists: one team for everyone, as in 9003. Dev-login users are
--    placed by /api/v1/dev/login itself ('dev' by default, its `team`, or no
--    team with team:null). API roles cannot create a team with slug 'dev'
--    (only service code, i.e. dev login, can), so no signed-in user can make
--    itself the owner of the team every sign-up joins. On the hosted
--    door-code demo (Y_DEMO_SECRET), dev login creates 'dev' with no owner.
-- 2. thread_participants: API roles add participants only while the thread
--    is a new 'request', and at most ONE participant they do not own (the
--    addressee agent; the product's builder for support threads). No
--    foreign users, no foreign owner/customer/observer roles (I4). The check
--    locks the thread row, so concurrent inserts cannot each add one.
-- 3. change_requests: an API-role insert must carry the referenced
--    suggestion's patch_hash and patch (only `target` may differ), and
--    expires_at is capped at 7 days (I1, I11).
-- 4. team_members: API roles cannot add other people (joining is by invite,
--    api.accept_team_invite) and joined_at is always now() (no backdating
--    into "first team" order).
-- 5. team_members / org_members: only an owner removes an owner, and the
--    last owner can neither leave nor step down. The team/org row is locked
--    first, so two co-owners leaving at once cannot both succeed.
--
-- Guards apply to the API roles (authenticated, anon) only; service_role and
-- definer functions keep making the trusted writes, as in 0005.

-- ============================================================ 1. default team

-- Signed in through POST /api/v1/dev/login (auth provider 'dev').
create or replace function y_private.is_dev_login_user(a_user uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $fn$
  select exists (
    select 1 from auth.users a
     where a.id = a_user
       and coalesce(a.raw_app_meta_data, '{}'::jsonb) ->> 'provider' = 'dev')
$fn$;
revoke all on function y_private.is_dev_login_user(uuid) from public, anon, authenticated;
grant execute on function y_private.is_dev_login_user(uuid) to service_role;

create or replace function y_private.join_default_team()
returns trigger
language plpgsql security definer
set search_path = ''
as $fn$
begin
  -- Dev login places its own users ('dev' by default, a named team, or none).
  if y_private.is_dev_login_user(new.id) then
    return new;
  end if;
  insert into public.team_members (team_id, user_id)
  select t.id, new.id from public.teams t where t.slug = 'dev'
  on conflict do nothing;
  return new;
end
$fn$;
revoke all on function y_private.join_default_team() from public;

-- Only service code (dev login) creates the default team: an API-role caller
-- creating 'dev' would own the team that every sign-up joins.
create or replace function y_private.guard_default_team_insert()
returns trigger
language plpgsql volatile
set search_path = ''
as $fn$
begin
  if current_user in ('authenticated', 'anon') and lower(new.slug::text) = 'dev' then
    raise exception using errcode = '42501',
      message = 'teams: the default team ''dev'' is created by the server only';
  end if;
  return new;
end
$fn$;
revoke all on function y_private.guard_default_team_insert() from public;

drop trigger if exists teams_guard_default_team on public.teams;
create trigger teams_guard_default_team
  before insert on public.teams
  for each row execute function y_private.guard_default_team_insert();

-- ===================================================== 2. thread participants

-- Null when an API-role caller may add (thread, kind, id, role); otherwise
-- the reason. Definer: the creator cannot yet SELECT its own new thread
-- (threads_select needs a participant row), and products are team-scoped.
create or replace function y_private.thread_participant_insert_error(
  a_thread text, a_kind text, a_id uuid, a_role text
) returns text
language plpgsql volatile security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := auth.uid();
  v_kind text;
  v_state text;
  v_product text;
  v_owner uuid;
begin
  -- Lock the thread so concurrent inserts are checked one after another
  -- (each would otherwise miss the other's uncommitted addressee).
  select t.kind, t.state, t.product_id into v_kind, v_state, v_product
    from public.threads t where t.id = a_thread
     for no key update;
  if not found then
    return null; -- the foreign key reports it
  end if;
  if v_state <> 'request' then
    return 'participants are added only while the thread is a new request';
  end if;
  if a_kind = 'agent' then
    select a.owner_user_id into v_owner from public.agents a where a.id = a_id;
  else
    select u.id into v_owner from public.users u where u.id = a_id;
  end if;
  if v_owner is null then
    return null; -- set_participant_owner reports it
  end if;
  if a_role = 'builder' and not (
       v_kind = 'support' and a_kind = 'agent'
       and exists (select 1 from public.products p where p.id = v_product and p.builder_agent_id = a_id)) then
    return 'only the product''s builder agent joins as builder';
  end if;
  if v_owner = v_uid then
    return null; -- the caller's own user or agents
  end if;
  -- Someone else's participant: exactly one addressee agent per new thread.
  if a_kind <> 'agent' then
    return 'only an agent can be addressed';
  end if;
  if (v_kind = 'support' and a_role <> 'builder') or (v_kind <> 'support' and a_role <> 'member') then
    return 'the addressee joins as member (builder for support threads)';
  end if;
  if exists (select 1 from public.thread_participants p
              where p.thread_id = a_thread and p.owner_user_id <> v_uid
                and not (p.p_kind = a_kind and p.p_id = a_id)) then
    return 'a new thread has one addressee';
  end if;
  return null;
end
$fn$;
revoke all on function y_private.thread_participant_insert_error(text, text, uuid, text) from public;
grant execute on function y_private.thread_participant_insert_error(text, text, uuid, text) to authenticated, anon, service_role;

create or replace function y_private.guard_thread_participant_insert()
returns trigger
language plpgsql volatile
set search_path = ''
as $fn$
declare
  v_err text;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  v_err := y_private.thread_participant_insert_error(new.thread_id, new.p_kind, new.p_id, new.role);
  if v_err is not null then
    raise exception using errcode = '42501', message = 'thread_participants: ' || v_err;
  end if;
  return new;
end
$fn$;

-- Named to sort after thread_participants_team_room_guard (9004), so a team
-- room keeps its own error.
drop trigger if exists thread_participants_zz_addressee_guard on public.thread_participants;
create trigger thread_participants_zz_addressee_guard
  before insert on public.thread_participants
  for each row execute function y_private.guard_thread_participant_insert();

-- ========================================================= 3. change requests

create or replace function y_private.guard_change_request_insert()
returns trigger
language plpgsql volatile
set search_path = ''
as $fn$
declare
  v_patch jsonb;
  v_hash text;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  -- RLS applies here: an invisible or unready suggestion finds nothing, and
  -- change_requests_insert rejects the row.
  select g.patch, g.patch_hash into v_patch, v_hash
    from public.setup_suggestions g where g.id = new.suggestion_id;
  if found then
    if new.patch_hash is distinct from v_hash or (new.patch - 'target') is distinct from (v_patch - 'target') then
      raise exception using errcode = '42501',
        message = 'change_requests: the patch must be the suggestion''s patch (agents never supply patch content)';
    end if;
  end if;
  new.expires_at := least(coalesce(new.expires_at, now() + interval '7 days'), now() + interval '7 days');
  return new;
end
$fn$;

drop trigger if exists change_requests_guard_insert on public.change_requests;
create trigger change_requests_guard_insert
  before insert on public.change_requests
  for each row execute function y_private.guard_change_request_insert();

-- ======================================================== 4. joining a team

create or replace function y_private.guard_team_member_join()
returns trigger
language plpgsql volatile
set search_path = ''
as $fn$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.user_id is distinct from auth.uid() then
    raise exception using errcode = '42501',
      message = 'team_members: people join a team themselves (invite link)';
  end if;
  new.joined_at := now();
  return new;
end
$fn$;

drop trigger if exists team_members_guard_join on public.team_members;
create trigger team_members_guard_join
  before insert on public.team_members
  for each row execute function y_private.guard_team_member_join();

-- ================================================== 5. removing an owner

-- Serializes owner changes per team/org (definer: the caller may not be
-- allowed to lock the row itself under RLS).
create or replace function y_private.lock_membership_parent(a_kind text, a_id uuid)
returns void
language plpgsql volatile security definer
set search_path = ''
as $fn$
begin
  if a_kind = 'team' then
    perform 1 from public.teams t where t.id = a_id for no key update;
  else
    perform 1 from public.orgs o where o.id = a_id for no key update;
  end if;
end
$fn$;
revoke all on function y_private.lock_membership_parent(text, uuid) from public;
grant execute on function y_private.lock_membership_parent(text, uuid) to authenticated, anon, service_role;

create or replace function y_private.guard_team_member_owner()
returns trigger
language plpgsql volatile
set search_path = ''
as $fn$
begin
  if current_user not in ('authenticated', 'anon') or old.role <> 'owner'
     or (tg_op = 'UPDATE' and new.role = 'owner' and new.team_id = old.team_id and new.user_id = old.user_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' and not y_private.is_team_owner(old.team_id) then
    raise exception using errcode = '42501', message = 'team_members: only an owner can remove an owner';
  end if;
  perform y_private.lock_membership_parent('team', old.team_id);
  if not exists (select 1 from public.team_members m
                  where m.team_id = old.team_id and m.role = 'owner' and m.user_id <> old.user_id) then
    raise exception using errcode = '42501', message = 'team_members: the last owner cannot leave or step down';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$fn$;

drop trigger if exists team_members_guard_owner on public.team_members;
create trigger team_members_guard_owner
  before update or delete on public.team_members
  for each row execute function y_private.guard_team_member_owner();

create or replace function y_private.guard_org_member_owner()
returns trigger
language plpgsql volatile
set search_path = ''
as $fn$
begin
  if current_user not in ('authenticated', 'anon') or old.role <> 'owner'
     or (tg_op = 'UPDATE' and new.role = 'owner' and new.org_id = old.org_id and new.user_id = old.user_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' and not y_private.is_org_owner(old.org_id) then
    raise exception using errcode = '42501', message = 'org_members: only an owner can remove an owner';
  end if;
  perform y_private.lock_membership_parent('org', old.org_id);
  if not exists (select 1 from public.org_members m
                  where m.org_id = old.org_id and m.role = 'owner' and m.user_id <> old.user_id) then
    raise exception using errcode = '42501', message = 'org_members: the last owner cannot leave or step down';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$fn$;

drop trigger if exists org_members_guard_owner on public.org_members;
create trigger org_members_guard_owner
  before update or delete on public.org_members
  for each row execute function y_private.guard_org_member_owner();
