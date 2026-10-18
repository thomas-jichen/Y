-- apps/core local migration (owner: core). Red-team fixes: RLS, triggers and
-- membership guards. Applied after every other migration. Every statement is
-- create-or-replace / drop-if-exists, so the file is safe to re-run.
--
-- 1. join_default_team (9003): real GitHub sign-ups no longer auto-join the
--    demo/dev team 'dev'. Dev-login users (no GitHub identity) still do.
-- 2. thread_participants: API roles add participants only while the thread
--    is a new 'request', and at most ONE participant they do not own (the
--    addressee agent; the product's builder for support threads). No
--    foreign users, no foreign owner/customer/observer roles (I4).
-- 3. change_requests: an API-role insert must carry the referenced
--    suggestion's patch_hash and patch (only `target` may differ), and
--    expires_at is capped at 7 days (I1, I11).
-- 4. team_members: API roles cannot add other people (joining is by invite,
--    api.accept_team_invite) and joined_at is always now() (no backdating
--    into "first team" order).
-- 5. team_members / org_members deletes: only an owner removes an owner, and
--    the last owner cannot leave.
-- 6. owner_instructions: an agent that starts an unattended session
--    (bypassPermissions / codex_never) after an instruction was queued gets
--    that undelivered, unconfirmed instruction flipped to requires_confirm
--    (PLAN §9), so it stays hidden until the owner confirms.
--
-- Guards apply to the API roles (authenticated, anon) only; service_role and
-- definer functions keep making the trusted writes, as in 0005.

-- ============================================================ 1. default team

create or replace function y_private.join_default_team()
returns trigger
language plpgsql security definer
set search_path = ''
as $fn$
begin
  -- A real GitHub account (github_id, or a GitHub identity on auth.users)
  -- never joins the shared dev/demo team automatically.
  if new.github_id is not null or exists (
    select 1 from auth.users a
     where a.id = new.id
       and (coalesce(a.raw_app_meta_data, '{}'::jsonb) ->> 'provider' = 'github'
            or coalesce(a.raw_app_meta_data, '{}'::jsonb) -> 'providers' ? 'github')
       and (coalesce(a.raw_user_meta_data, '{}'::jsonb) ->> 'provider_id') ~ '^[0-9]{1,18}$') then
    return new;
  end if;
  insert into public.team_members (team_id, user_id)
  select t.id, new.id from public.teams t where t.slug = 'dev'
  on conflict do nothing;
  return new;
end
$fn$;
revoke all on function y_private.join_default_team() from public;

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
  select t.kind, t.state, t.product_id into v_kind, v_state, v_product
    from public.threads t where t.id = a_thread;
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

create or replace function y_private.guard_team_member_delete()
returns trigger
language plpgsql volatile
set search_path = ''
as $fn$
begin
  if current_user not in ('authenticated', 'anon') or old.role <> 'owner' then
    return old;
  end if;
  if not y_private.is_team_owner(old.team_id) then
    raise exception using errcode = '42501', message = 'team_members: only an owner can remove an owner';
  end if;
  if not exists (select 1 from public.team_members m
                  where m.team_id = old.team_id and m.role = 'owner' and m.user_id <> old.user_id) then
    raise exception using errcode = '42501', message = 'team_members: the last owner cannot leave';
  end if;
  return old;
end
$fn$;

drop trigger if exists team_members_guard_delete on public.team_members;
create trigger team_members_guard_delete
  before delete on public.team_members
  for each row execute function y_private.guard_team_member_delete();

create or replace function y_private.guard_org_member_delete()
returns trigger
language plpgsql volatile
set search_path = ''
as $fn$
begin
  if current_user not in ('authenticated', 'anon') or old.role <> 'owner' then
    return old;
  end if;
  if not y_private.is_org_owner(old.org_id) then
    raise exception using errcode = '42501', message = 'org_members: only an owner can remove an owner';
  end if;
  if not exists (select 1 from public.org_members m
                  where m.org_id = old.org_id and m.role = 'owner' and m.user_id <> old.user_id) then
    raise exception using errcode = '42501', message = 'org_members: the last owner cannot leave';
  end if;
  return old;
end
$fn$;

drop trigger if exists org_members_guard_delete on public.org_members;
create trigger org_members_guard_delete
  before delete on public.org_members
  for each row execute function y_private.guard_org_member_delete();

-- ==================================== 6. unattended sessions after the fact

create or replace function y_private.lease_requires_instruction_confirm()
returns trigger
language plpgsql volatile security definer
set search_path = ''
as $fn$
begin
  if new.permission_mode in ('bypassPermissions', 'codex_never')
     and (tg_op = 'INSERT' or old.permission_mode not in ('bypassPermissions', 'codex_never')) then
    -- Delivered rows are left alone (the table check forbids flipping them).
    update public.owner_instructions o
       set requires_confirm = true
     where o.agent_id = new.agent_id
       and o.delivered_at is null and o.confirmed_at is null and not o.requires_confirm;
  end if;
  return null;
end
$fn$;
revoke all on function y_private.lease_requires_instruction_confirm() from public;

drop trigger if exists session_leases_instruction_confirm on public.session_leases;
create trigger session_leases_instruction_confirm
  after insert or update of permission_mode on public.session_leases
  for each row execute function y_private.lease_requires_instruction_confirm();
