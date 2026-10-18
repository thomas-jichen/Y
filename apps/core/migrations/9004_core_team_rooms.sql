-- apps/core local migration (owner: core messaging). One team room per team.
--
-- Every team gets one `group` thread (the "room"). Its participants are the
-- team's members (as users, so a human without an agent can read and comment)
-- and every active agent those members own. Strangers are never added: rows
-- come only from team_members (I4). The mapping lives in a private table so a
-- partial unique index on public.threads is not needed.
--
-- System setup only, like 9003: definer functions, no new write path for the
-- API roles, no policy changes (I7).

create table if not exists y_private.team_rooms (
  team_id uuid primary key references public.teams (id) on delete cascade,
  thread_id y_private.ulid not null unique references public.threads (id) on delete cascade
);
alter table y_private.team_rooms enable row level security;
grant all on y_private.team_rooms to service_role;

-- Create the room if missing (when the team has at least one member) and add
-- every member and their active agents. Idempotent. Returns the room thread
-- id, or null for a team with no members.
create or replace function y_private.ensure_team_room(p_team uuid)
returns text
language plpgsql volatile security definer
set search_path = ''
as $fn$
declare
  v_thread text;
  v_creator uuid;
  v_name text;
begin
  select r.thread_id into v_thread from y_private.team_rooms r where r.team_id = p_team;
  if v_thread is null then
    select m.user_id into v_creator from public.team_members m
     where m.team_id = p_team
     order by (m.role = 'owner') desc, m.joined_at, m.user_id
     limit 1;
    if v_creator is null then
      return null;
    end if;
    select left(t.name, 120) into v_name from public.teams t where t.id = p_team;
    if v_name is null then
      return null;
    end if;
    insert into public.threads (kind, team_id, subject, state, created_by_user_id)
    values ('group', p_team, v_name, 'open', v_creator)
    returning id into v_thread;
    insert into y_private.team_rooms (team_id, thread_id) values (p_team, v_thread);
  end if;

  insert into public.thread_participants (thread_id, p_kind, p_id, role)
  select v_thread, 'user', m.user_id, 'member' from public.team_members m where m.team_id = p_team
  on conflict do nothing;
  insert into public.thread_participants (thread_id, p_kind, p_id, role)
  select v_thread, 'agent', a.id, 'member'
    from public.team_members m join public.agents a on a.owner_user_id = m.user_id
   where m.team_id = p_team and a.status = 'active'
  on conflict do nothing;
  return v_thread;
end
$fn$;
revoke all on function y_private.ensure_team_room(uuid) from public;

-- The room's created_by_user_id must never be a departing account:
-- threads.created_by_user_id cascades on user delete (the whole room would
-- go), and thread_created_by_me() is what thread_participants_insert checks.
-- Hand it to another current member (owner first, then earliest joiner). With
-- no other member left, keep it; the participant guard below still applies.
create or replace function y_private.team_room_handover(p_team uuid, p_leaving uuid)
returns void
language plpgsql volatile security definer
set search_path = ''
as $fn$
declare
  v_next uuid;
begin
  select m.user_id into v_next from public.team_members m
   where m.team_id = p_team and m.user_id <> p_leaving
   order by (m.role = 'owner') desc, m.joined_at, m.user_id
   limit 1;
  if v_next is null then
    return;
  end if;
  update public.threads t set created_by_user_id = v_next, updated_at = now()
    from y_private.team_rooms r
   where r.team_id = p_team and t.id = r.thread_id and t.created_by_user_id = p_leaving;
end
$fn$;
revoke all on function y_private.team_room_handover(uuid, uuid) from public;

-- Deleting an account: hand over every room it created before the cascade runs.
create or replace function y_private.team_room_on_user_delete()
returns trigger
language plpgsql volatile security definer
set search_path = ''
as $fn$
declare
  v_team uuid;
begin
  for v_team in select r.team_id from y_private.team_rooms r join public.threads t on t.id = r.thread_id
                 where t.created_by_user_id = old.id loop
    perform y_private.team_room_handover(v_team, old.id);
  end loop;
  return old;
end
$fn$;
revoke all on function y_private.team_room_on_user_delete() from public;

drop trigger if exists users_team_room_handover on public.users;
create trigger users_team_room_handover
  before delete on public.users
  for each row execute function y_private.team_room_on_user_delete();

-- Room membership comes only from team_members (via the definer functions
-- here). API roles cannot add participants to a room, not even its creator
-- (thread_participants_insert would otherwise let them add anyone, I4).
create or replace function y_private.is_team_room(p_thread text)
returns boolean
language sql stable security definer
set search_path = ''
as $fn$
  select exists (select 1 from y_private.team_rooms r where r.thread_id = p_thread)
$fn$;
revoke all on function y_private.is_team_room(text) from public;
grant execute on function y_private.is_team_room(text) to authenticated, anon, service_role;

create or replace function y_private.guard_team_room_participants()
returns trigger
language plpgsql volatile
set search_path = ''
as $fn$
begin
  if current_user in ('authenticated', 'anon') and y_private.is_team_room(new.thread_id) then
    raise exception using errcode = '42501', message = 'team room participants come from team membership';
  end if;
  return new;
end
$fn$;

drop trigger if exists thread_participants_team_room_guard on public.thread_participants;
create trigger thread_participants_team_room_guard
  before insert on public.thread_participants
  for each row execute function y_private.guard_team_room_participants();

-- A quarantined room message files one review item per recipient owner, and
-- each owner's decision covers only their agents: one pending item per
-- (kind, ref, owner), not per (kind, ref). Every other review kind has a
-- single owner per ref, so this changes nothing for them.
drop index if exists public.review_items_pending_ref_idx;
create unique index if not exists review_items_pending_ref_owner_idx
  on public.review_items (kind, ref_id, owner_user_id) where state = 'pending';

-- New member: create the room if needed and add them (and their agents).
create or replace function y_private.team_room_on_member()
returns trigger
language plpgsql volatile security definer
set search_path = ''
as $fn$
begin
  perform y_private.ensure_team_room(new.team_id);
  return null;
end
$fn$;
revoke all on function y_private.team_room_on_member() from public;

drop trigger if exists team_members_team_room on public.team_members;
create trigger team_members_team_room
  after insert on public.team_members
  for each row execute function y_private.team_room_on_member();

-- A member who leaves stops being a room participant (with their agents),
-- unless they still belong through another membership row (there is none:
-- the primary key is (team_id, user_id)).
create or replace function y_private.team_room_on_member_leave()
returns trigger
language plpgsql volatile security definer
set search_path = ''
as $fn$
begin
  delete from public.thread_participants p
   using y_private.team_rooms r
   where r.team_id = old.team_id and p.thread_id = r.thread_id
     and ((p.p_kind = 'user' and p.p_id = old.user_id)
          or (p.p_kind = 'agent' and p.p_id in (select a.id from public.agents a where a.owner_user_id = old.user_id)));
  perform y_private.team_room_handover(old.team_id, old.user_id);
  return null;
end
$fn$;
revoke all on function y_private.team_room_on_member_leave() from public;

drop trigger if exists team_members_team_room_leave on public.team_members;
create trigger team_members_team_room_leave
  after delete on public.team_members
  for each row execute function y_private.team_room_on_member_leave();

-- An agent that becomes active joins each of its owner's team rooms.
create or replace function y_private.team_room_on_agent()
returns trigger
language plpgsql volatile security definer
set search_path = ''
as $fn$
declare
  v_team uuid;
begin
  if new.status <> 'active' then
    -- A paused or disabled agent stops being a room recipient (no pending
    -- deliveries piling up, no unread counts). It rejoins when active again.
    if tg_op = 'UPDATE' and old.status = 'active' then
      delete from public.thread_participants p
       using y_private.team_rooms r
       where p.thread_id = r.thread_id and p.p_kind = 'agent' and p.p_id = new.id;
    end if;
    return null;
  end if;
  for v_team in select m.team_id from public.team_members m where m.user_id = new.owner_user_id loop
    perform y_private.ensure_team_room(v_team);
  end loop;
  return null;
end
$fn$;
revoke all on function y_private.team_room_on_agent() from public;

drop trigger if exists agents_team_room on public.agents;
create trigger agents_team_room
  after insert or update of status on public.agents
  for each row execute function y_private.team_room_on_agent();

-- Backfill: a room for every team that has members.
select y_private.ensure_team_room(t.id) from public.teams t;
