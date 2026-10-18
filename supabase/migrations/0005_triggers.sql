-- 0005_triggers.sql
--
-- Triggers:
-- * events insert  -> pg_notify('y_events', id::text) (local push bus;
--   core then reads the row via api.events_since) and, when Supabase
--   Realtime exists, one BROADCAST per audience member on
--   'agent:<agent_id>:<secret>' / 'user:<user_id>:<secret>' with
--   {id, type, payload}: ids and counts only (I3).
-- * jobs insert    -> pg_notify('y_jobs', topic) (wakes server-mode workers).
-- * updated_at maintenance.
-- * Provisioning: auth.users -> public.users; users/agents/teams/orgs get
--   their companion rows (private attributes, settings, presence, Realtime
--   secrets, team salt, creator membership).
-- * Ownership derivation: owner_user_id / sender_owner_id are always derived
--   from the agent, so a caller cannot claim someone else's ownership.
-- * Guards for authenticated callers: status/visibility transitions on
--   owner-edited content, thread state machine and assignee, member roles and
--   opt-in flags, owner-instruction confirm/delivery, install revocation,
--   append-only audit log.
-- * Review queue: change requests create their review item; review items and
--   change requests emit review.new / review.decided / change.updated events.
--   Core must NOT emit those three itself.

-- ================================================================ fan-out

-- Send one Supabase Realtime broadcast (public channel; the topic carries
-- the secret). A no-op where realtime.send() does not exist (PGlite, plain
-- Postgres): there the pg_notify doorbell feeds core's in-process bus.
-- Broadcast failures are reported as warnings and never abort the write.
create or replace function y_private.broadcast(topic text, event text, payload jsonb)
returns void
language plpgsql volatile security definer
set search_path = ''
as $fn$
begin
  if to_regprocedure('realtime.send(jsonb, text, text, boolean)') is null then
    return;
  end if;
  begin
    perform realtime.send(payload, event, topic, false);
  exception when others then
    -- Never log the topic: it contains the channel secret.
    raise warning 'y broadcast (%) failed: %', split_part(topic, ':', 1), sqlerrm;
  end;
end
$fn$;
comment on function y_private.broadcast(text, text, jsonb) is
  'realtime.send(payload, event, topic, false) when Supabase Realtime exists; otherwise a no-op (pg_notify carries local fan-out).';

create or replace function y_private.on_event_insert()
returns trigger
language plpgsql volatile security definer
set search_path = ''
as $fn$
declare
  v_message jsonb := jsonb_build_object('id', new.id::text, 'type', new.type, 'payload', new.payload);
  v_channel record;
begin
  perform pg_catalog.pg_notify('y_events', new.id::text);
  if to_regprocedure('realtime.send(jsonb, text, text, boolean)') is null then
    return null;
  end if;
  for v_channel in
    select c.owner_kind, c.owner_id, c.secret
    from public.realtime_channels c
    where (c.owner_kind = 'agent' and c.owner_id = any (new.audience_agent_ids))
       or (c.owner_kind = 'user' and c.owner_id = any (new.audience_user_ids))
  loop
    perform y_private.broadcast(
      v_channel.owner_kind || ':' || v_channel.owner_id::text || ':' || v_channel.secret, new.type, v_message);
  end loop;
  return null;
end
$fn$;

create trigger events_fanout
  after insert on public.events
  for each row execute function y_private.on_event_insert();

create or replace function y_private.on_job_insert()
returns trigger
language plpgsql volatile
set search_path = ''
as $fn$
begin
  perform pg_catalog.pg_notify('y_jobs', new.topic);
  return null;
end
$fn$;

create trigger jobs_notify
  after insert on public.jobs
  for each row execute function y_private.on_job_insert();

-- ============================================================== updated_at

create or replace function y_private.touch_updated_at()
returns trigger
language plpgsql volatile
set search_path = ''
as $fn$
begin
  new.updated_at := now();
  return new;
end
$fn$;

-- Every table with an updated_at column except rate_buckets, whose
-- updated_at is the bucket clock maintained by api.take_token.
do $touch$
declare
  t text;
begin
  foreach t in array array[
    'users', 'user_private', 'teams', 'agents', 'agent_settings', 'agent_presence', 'oauth_grants', 'orgs',
    'org_members', 'kill_switches', 'segments', 'sessions', 'session_leases', 'shared_components', 'activities',
    'highlights', 'daily_rollups', 'segment_stats', 'products', 'threads', 'messages', 'message_deliveries',
    'dm_permissions', 'review_items', 'setup_suggestions', 'change_requests', 'adoptions', 'builder_tasks', 'jobs',
    'notification_prefs'
  ] loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function y_private.touch_updated_at()',
      t || '_touch_updated_at', t);
  end loop;
end
$touch$;

-- ================================================================== handles

-- Users and agents share one handle namespace. Claims the handle in
-- handle_registry (primary key => a taken handle raises unique_violation).
create or replace function y_private.claim_handle()
returns trigger
language plpgsql volatile security definer
set search_path = ''
as $fn$
declare
  v_kind text := tg_argv[0];
begin
  if tg_op = 'DELETE' then
    delete from public.handle_registry r where r.owner_kind = v_kind and r.owner_id = old.id;
    return null;
  end if;
  if tg_op = 'UPDATE' then
    if new.handle = old.handle then
      return null;
    end if;
    delete from public.handle_registry r where r.owner_kind = v_kind and r.owner_id = new.id;
  end if;
  begin
    insert into public.handle_registry (handle, owner_kind, owner_id) values (new.handle, v_kind, new.id);
  exception when unique_violation then
    raise exception using errcode = '23505', message = format('handle "%s" is already taken', new.handle);
  end;
  return null;
end
$fn$;

create trigger users_claim_handle
  after insert or update of handle or delete on public.users
  for each row execute function y_private.claim_handle('user');
create trigger agents_claim_handle
  after insert or update of handle or delete on public.agents
  for each row execute function y_private.claim_handle('agent');

-- ============================================================= provisioning

-- auth.users -> public.users. The handle comes from the GitHub login
-- (user_name / preferred_username), lowercased to [a-z0-9-], with a numeric
-- suffix on collision; never from the email address.
create or replace function y_private.handle_new_auth_user()
returns trigger
language plpgsql volatile security definer
set search_path = ''
as $fn$
declare
  v_meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_app jsonb := coalesce(new.raw_app_meta_data, '{}'::jsonb);
  v_login text := nullif(coalesce(v_meta ->> 'user_name', v_meta ->> 'preferred_username'), '');
  v_github_id bigint;
  v_base text;
  v_handle text;
  v_attempt int := 0;
begin
  if v_login is not null and v_login !~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$' then
    v_login := null;
  end if;
  if (v_app ->> 'provider' = 'github' or v_app -> 'providers' ? 'github')
     and (v_meta ->> 'provider_id') ~ '^[0-9]{1,18}$' then
    v_github_id := (v_meta ->> 'provider_id')::bigint;
    if exists (select 1 from public.users u where u.github_id = v_github_id) then
      v_github_id := null;
    end if;
  end if;

  v_base := btrim(regexp_replace(lower(coalesce(v_login, '')), '[^a-z0-9-]+', '-', 'g'), '-');
  if char_length(v_base) < 3 then
    v_base := 'user-' || substr(replace(new.id::text, '-', ''), 1, 8);
  end if;
  v_base := left(v_base, 28);

  loop
    v_attempt := v_attempt + 1;
    v_handle := case
      when v_attempt = 1 then v_base
      when v_attempt <= 50 then left(v_base, 28) || '-' || v_attempt::text
      else 'user-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
    end;
    continue when exists (select 1 from public.handle_registry r where r.handle = v_handle);
    begin
      insert into public.users (id, github_id, github_login, handle, display_name, avatar_url)
      values (
        new.id,
        v_github_id,
        v_login,
        v_handle,
        nullif(left(coalesce(v_meta ->> 'full_name', v_meta ->> 'name', ''), 80), ''),
        nullif(left(coalesce(v_meta ->> 'avatar_url', ''), 2048), '')
      )
      on conflict (id) do nothing;
      return new;
    exception when unique_violation then
      -- Lost a race for the handle; try the next candidate.
      if v_attempt > 60 then
        raise;
      end if;
    end;
  end loop;
end
$fn$;

create trigger y_on_auth_user_created
  after insert on auth.users
  for each row execute function y_private.handle_new_auth_user();

create or replace function y_private.on_user_insert()
returns trigger
language plpgsql volatile security definer
set search_path = ''
as $fn$
begin
  insert into public.user_private (user_id) values (new.id) on conflict do nothing;
  insert into public.notification_prefs (user_id) values (new.id) on conflict do nothing;
  insert into public.realtime_channels (owner_kind, owner_id) values ('user', new.id) on conflict do nothing;
  return null;
end
$fn$;

create trigger users_provision
  after insert on public.users
  for each row execute function y_private.on_user_insert();

create or replace function y_private.on_agent_insert()
returns trigger
language plpgsql volatile security definer
set search_path = ''
as $fn$
begin
  insert into public.agent_settings (agent_id) values (new.id) on conflict do nothing;
  insert into public.agent_presence (agent_id) values (new.id) on conflict do nothing;
  insert into public.realtime_channels (owner_kind, owner_id) values ('agent', new.id) on conflict do nothing;
  return null;
end
$fn$;

create trigger agents_provision
  after insert on public.agents
  for each row execute function y_private.on_agent_insert();

create or replace function y_private.on_team_insert()
returns trigger
language plpgsql volatile security definer
set search_path = ''
as $fn$
begin
  insert into public.team_secrets (team_id) values (new.id) on conflict do nothing;
  if new.created_by is not null then
    insert into public.team_members (team_id, user_id, role) values (new.id, new.created_by, 'owner')
    on conflict (team_id, user_id) do update set role = 'owner';
  end if;
  return null;
end
$fn$;

create trigger teams_provision
  after insert on public.teams
  for each row execute function y_private.on_team_insert();

create or replace function y_private.on_org_insert()
returns trigger
language plpgsql volatile security definer
set search_path = ''
as $fn$
begin
  if new.created_by is not null then
    insert into public.org_members (org_id, user_id, role) values (new.id, new.created_by, 'owner')
    on conflict (org_id, user_id) do update set role = 'owner';
  end if;
  return null;
end
$fn$;

create trigger orgs_provision
  after insert on public.orgs
  for each row execute function y_private.on_org_insert();

-- ================================================================ ownership

-- BEFORE INSERT: set column tg_argv[1] to the owner of the agent in column
-- tg_argv[0]. Runs before RLS WITH CHECK, so `owner_user_id = auth.uid()`
-- in policies means "the caller owns that agent".
create or replace function y_private.set_owner_from_agent()
returns trigger
language plpgsql volatile security definer
set search_path = ''
as $fn$
declare
  v_agent uuid := (to_jsonb(new) ->> tg_argv[0])::uuid;
  v_owner uuid;
begin
  select a.owner_user_id into v_owner from public.agents a where a.id = v_agent;
  if v_owner is null then
    raise exception using errcode = '23503', message = format('%s.%s: unknown agent', tg_table_name, tg_argv[0]);
  end if;
  new := jsonb_populate_record(new, jsonb_build_object(tg_argv[1], v_owner));
  return new;
end
$fn$;

create trigger activities_set_owner before insert on public.activities
  for each row execute function y_private.set_owner_from_agent('agent_id', 'owner_user_id');
create trigger highlights_set_owner before insert on public.highlights
  for each row execute function y_private.set_owner_from_agent('author_agent_id', 'owner_user_id');
create trigger shared_components_set_owner before insert on public.shared_components
  for each row execute function y_private.set_owner_from_agent('author_agent_id', 'owner_user_id');
create trigger setup_reviews_set_owner before insert on public.setup_reviews
  for each row execute function y_private.set_owner_from_agent('reviewer_agent_id', 'owner_user_id');
create trigger change_requests_set_owner before insert on public.change_requests
  for each row execute function y_private.set_owner_from_agent('agent_id', 'owner_user_id');

-- Messages: the sender's owner (agent -> its owner; user -> the user).
create or replace function y_private.set_message_sender_owner()
returns trigger
language plpgsql volatile security definer
set search_path = ''
as $fn$
begin
  if new.sender_kind = 'agent' then
    select a.owner_user_id into new.sender_owner_id from public.agents a where a.id = new.sender_id;
    if new.sender_owner_id is null then
      raise exception using errcode = '23503', message = 'messages.sender_id: unknown agent';
    end if;
  elsif new.sender_kind = 'user' then
    new.sender_owner_id := new.sender_id;
  else
    new.sender_owner_id := null;
  end if;
  return new;
end
$fn$;

create trigger messages_set_sender_owner before insert on public.messages
  for each row execute function y_private.set_message_sender_owner();

-- Thread participants: owner_user_id (agent -> its owner; user -> the user).
create or replace function y_private.set_participant_owner()
returns trigger
language plpgsql volatile security definer
set search_path = ''
as $fn$
begin
  if new.p_kind = 'agent' then
    select a.owner_user_id into new.owner_user_id from public.agents a where a.id = new.p_id;
  else
    select u.id into new.owner_user_id from public.users u where u.id = new.p_id;
  end if;
  if new.owner_user_id is null then
    raise exception using errcode = '23503', message = format('thread_participants: unknown %s', new.p_kind);
  end if;
  return new;
end
$fn$;

create trigger thread_participants_set_owner before insert on public.thread_participants
  for each row execute function y_private.set_participant_owner();

-- =================================================================== guards
-- Guards apply to the API roles only. service_role (worker) and definer
-- functions (which run as the owner) make the trusted transitions.

create or replace function y_private.is_org_owner(p_org_id uuid) returns boolean
language sql stable security definer parallel safe
set search_path = ''
as $fn$
  select p_org_id is not null and exists (
    select 1 from public.org_members m
    where m.org_id = p_org_id and m.user_id = auth.uid() and m.role = 'owner')
$fn$;
revoke all on function y_private.is_org_owner(uuid) from public, anon, authenticated, service_role;
grant execute on function y_private.is_org_owner(uuid) to anon, authenticated, service_role;

-- Owner edits of activities / highlights / shared components: status may only
-- stay or become 'archived' (unpost); visibility may never be raised to public.
create or replace function y_private.guard_owner_content_update()
returns trigger
language plpgsql volatile
set search_path = ''
as $fn$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.status is distinct from old.status and new.status <> 'archived' then
    raise exception using errcode = '42501',
      message = format('%s: status can only be changed to archived (got %s -> %s)', tg_table_name, old.status, new.status);
  end if;
  if new.visibility = 'public' and old.visibility is distinct from 'public' then
    raise exception using errcode = '42501',
      message = format('%s: public visibility needs the publish flow (human click + stricter screen)', tg_table_name);
  end if;
  return new;
end
$fn$;

create trigger activities_guard_owner_update before update on public.activities
  for each row execute function y_private.guard_owner_content_update();
create trigger highlights_guard_owner_update before update on public.highlights
  for each row execute function y_private.guard_owner_content_update();
create trigger shared_components_guard_owner_update before update on public.shared_components
  for each row execute function y_private.guard_owner_content_update();

-- Thread state machine for participants (PLAN §9). 'request' threads are
-- opened or closed only by the worker after the human's decision.
create or replace function y_private.guard_thread_state()
returns trigger
language plpgsql volatile
set search_path = ''
as $fn$
declare
  v_human boolean := y_private.is_human();
begin
  if current_user not in ('authenticated', 'anon') or new.state = old.state then
    return new;
  end if;
  if (old.state = 'open' and new.state = 'resolved')
     or (v_human and old.state = 'open' and new.state = 'paused_by_owner')
     or (v_human and old.state = 'paused_by_owner' and new.state in ('open', 'resolved'))
     or (v_human and old.state = 'resolved' and new.state = 'open')
     or (v_human and old.state in ('open', 'paused_by_owner', 'resolved') and new.state = 'archived') then
    return new;
  end if;
  raise exception using errcode = '42501',
    message = format('threads: %s -> %s is not allowed here', old.state, new.state);
end
$fn$;

create trigger threads_guard_state before update on public.threads
  for each row execute function y_private.guard_thread_state();

-- Team roles: only owners grant or revoke 'owner'; admins manage the rest.
-- A member may record only their OWN policy acceptance.
create or replace function y_private.guard_team_members()
returns trigger
language plpgsql volatile
set search_path = ''
as $fn$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.role = 'owner' and not y_private.is_team_owner(new.team_id) then
      raise exception using errcode = '42501', message = 'team_members: only an owner can add an owner';
    end if;
    if new.policy_accepted_version is not null and new.user_id is distinct from auth.uid() then
      raise exception using errcode = '42501', message = 'team_members: members accept the policy themselves';
    end if;
    return new;
  end if;
  if new.role is distinct from old.role
     and not (y_private.is_team_owner(new.team_id)
              or (y_private.is_team_admin(new.team_id) and 'owner' not in (old.role, new.role))) then
    raise exception using errcode = '42501', message = 'team_members: not allowed to change this role';
  end if;
  if new.policy_accepted_version is distinct from old.policy_accepted_version
     and new.user_id is distinct from auth.uid() then
    raise exception using errcode = '42501', message = 'team_members: members accept the policy themselves';
  end if;
  return new;
end
$fn$;

create trigger team_members_guard before insert or update on public.team_members
  for each row execute function y_private.guard_team_members();

-- Org membership: opt-in flags (share_aggregates, share_individual,
-- show_on_leaderboard) are set ONLY by the member; roles as for teams.
create or replace function y_private.guard_org_members()
returns trigger
language plpgsql volatile
set search_path = ''
as $fn$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.role = 'owner' and not y_private.is_org_owner(new.org_id) then
      raise exception using errcode = '42501', message = 'org_members: only an owner can add an owner';
    end if;
    if (new.share_aggregates or new.share_individual or new.show_on_leaderboard)
       and new.user_id is distinct from auth.uid() then
      raise exception using errcode = '42501', message = 'org_members: only the member can opt in';
    end if;
    return new;
  end if;
  if (new.share_aggregates, new.share_individual, new.show_on_leaderboard)
       is distinct from (old.share_aggregates, old.share_individual, old.show_on_leaderboard)
     and new.user_id is distinct from auth.uid() then
    raise exception using errcode = '42501', message = 'org_members: only the member can change their opt-in flags';
  end if;
  if new.role is distinct from old.role
     and not (y_private.is_org_owner(new.org_id)
              or (y_private.is_org_admin(new.org_id) and 'owner' not in (old.role, new.role))) then
    raise exception using errcode = '42501', message = 'org_members: not allowed to change this role';
  end if;
  return new;
end
$fn$;

create trigger org_members_guard before insert or update on public.org_members
  for each row execute function y_private.guard_org_members();

-- update_thread 'assign': only a participant agent can be the assignee (FK
-- checks bypass RLS, so the guard checks it explicitly).
create or replace function y_private.guard_thread_assignee()
returns trigger
language plpgsql volatile
set search_path = ''
as $fn$
begin
  if current_user in ('authenticated', 'anon')
     and new.assigned_agent_id is distinct from old.assigned_agent_id
     and new.assigned_agent_id is not null
     and not y_private.is_agent_participant(new.id, new.assigned_agent_id) then
    raise exception using errcode = '42501', message = 'threads: the assignee must be a participant agent';
  end if;
  return new;
end
$fn$;

create trigger threads_guard_assignee before update of assigned_agent_id on public.threads
  for each row execute function y_private.guard_thread_assignee();

-- Owner instructions (PLAN §9): an instruction for an agent that has an
-- unattended session (bypassPermissions / codex_never) needs the owner's
-- confirm click before the agent can see it or be woken for it. Derived here
-- from session_leases; callers may only force it on, never off.
create or replace function y_private.derive_owner_instruction_confirm()
returns trigger
language plpgsql volatile security definer
set search_path = ''
as $fn$
begin
  new.requires_confirm := coalesce(new.requires_confirm, false) or exists (
    select 1 from public.session_leases l
    where l.agent_id = new.agent_id
      and l.permission_mode in ('bypassPermissions', 'codex_never'));
  return new;
end
$fn$;

create trigger owner_instructions_derive_confirm before insert on public.owner_instructions
  for each row execute function y_private.derive_owner_instruction_confirm();

-- Who may change what after insert: only a human (web/Slack) confirms, only
-- the agent itself marks delivered. Column grants already freeze the rest.
create or replace function y_private.guard_owner_instruction_update()
returns trigger
language plpgsql volatile
set search_path = ''
as $fn$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if (new.confirmed_at, new.confirmed_via) is distinct from (old.confirmed_at, old.confirmed_via)
     and not (y_private.is_human() and old.confirmed_at is null and old.requires_confirm) then
    raise exception using errcode = '42501', message = 'owner_instructions: only the owner confirms, once';
  end if;
  if new.delivered_at is distinct from old.delivered_at
     and y_private.acting_agent_id() is distinct from new.agent_id then
    raise exception using errcode = '42501', message = 'owner_instructions: only the agent itself marks delivery';
  end if;
  return new;
end
$fn$;

create trigger owner_instructions_guard_update before update on public.owner_instructions
  for each row execute function y_private.guard_owner_instruction_update();

-- A revoked install stays revoked.
create or replace function y_private.guard_install_revocation()
returns trigger
language plpgsql volatile
set search_path = ''
as $fn$
begin
  if current_user in ('authenticated', 'anon')
     and old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception using errcode = '42501', message = 'installs: a revoked install cannot be restored';
  end if;
  return new;
end
$fn$;

create trigger installs_guard_revocation before update on public.installs
  for each row execute function y_private.guard_install_revocation();

create or replace function y_private.stamp_friendship_response()
returns trigger
language plpgsql volatile
set search_path = ''
as $fn$
begin
  if new.state is distinct from old.state then
    new.responded_at := now();
  end if;
  return new;
end
$fn$;

create trigger friendships_stamp_response before update on public.friendships
  for each row execute function y_private.stamp_friendship_response();

-- The audit log is append-only.
create or replace function y_private.audit_log_append_only()
returns trigger
language plpgsql volatile
set search_path = ''
as $fn$
begin
  raise exception using errcode = '42501', message = 'audit_log is append-only';
end
$fn$;

create trigger audit_log_no_update before update on public.audit_log
  for each row execute function y_private.audit_log_append_only();

-- ============================================================= review queue

-- Every change request gets a pending review item for its owner (I5): the
-- human approves exactly this patch_hash on the web or in Slack.
create or replace function y_private.on_change_request_insert()
returns trigger
language plpgsql volatile security definer
set search_path = ''
as $fn$
begin
  insert into public.review_items (owner_user_id, kind, ref_id, agent_id, summary, expires_at, requires_step_up)
  values (new.owner_user_id, 'change_request', 'cr_' || new.id, new.agent_id, 'Setup change request', new.expires_at, true)
  on conflict do nothing;
  return null;
end
$fn$;

create trigger change_requests_review_item
  after insert on public.change_requests
  for each row execute function y_private.on_change_request_insert();

create or replace function y_private.on_change_request_state()
returns trigger
language plpgsql volatile security definer
set search_path = ''
as $fn$
begin
  insert into public.events (type, audience_agent_ids, audience_user_ids, payload)
  values ('change.updated', array[new.agent_id], array[new.owner_user_id],
          jsonb_build_object('changeRequestId', 'cr_' || new.id, 'state', new.state));
  return null;
end
$fn$;

create trigger change_requests_state_event
  after update of state on public.change_requests
  for each row when (old.state is distinct from new.state)
  execute function y_private.on_change_request_state();

create or replace function y_private.on_review_item_event()
returns trigger
language plpgsql volatile security definer
set search_path = ''
as $fn$
begin
  insert into public.events (type, audience_user_ids, payload)
  values (case when tg_op = 'INSERT' then 'review.new' else 'review.decided' end,
          array[new.owner_user_id],
          jsonb_build_object('reviewId', 'rv_' || new.id));
  return null;
end
$fn$;

create trigger review_items_new_event
  after insert on public.review_items
  for each row execute function y_private.on_review_item_event();
create trigger review_items_decided_event
  after update of state on public.review_items
  for each row when (old.state = 'pending' and new.state <> 'pending')
  execute function y_private.on_review_item_event();

-- Trigger functions are never called directly.
revoke all on function
  y_private.broadcast(text, text, jsonb),
  y_private.on_event_insert(), y_private.on_job_insert(), y_private.touch_updated_at(),
  y_private.claim_handle(), y_private.handle_new_auth_user(), y_private.on_user_insert(),
  y_private.on_agent_insert(), y_private.on_team_insert(), y_private.on_org_insert(),
  y_private.set_owner_from_agent(), y_private.set_message_sender_owner(),
  y_private.set_participant_owner(), y_private.guard_owner_content_update(),
  y_private.guard_thread_state(), y_private.guard_team_members(), y_private.guard_org_members(),
  y_private.guard_install_revocation(), y_private.stamp_friendship_response(),
  y_private.audit_log_append_only(), y_private.on_change_request_insert(),
  y_private.on_change_request_state(), y_private.on_review_item_event(),
  y_private.guard_thread_assignee(), y_private.derive_owner_instruction_confirm(),
  y_private.guard_owner_instruction_update()
  from public, anon, authenticated, service_role;
