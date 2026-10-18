-- Presence derived from signals (0010, PLAN §9 Reachability): live from a
-- turn reported on a lease (active_at), or from a recent ingest on a session
-- whose lease does not report turns (older plugins); listening from a fresh
-- lease heartbeat; away otherwise. The stored value changes only through
-- api.refresh_agent_presence, which reports each change once and is
-- service_role only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(31);

insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.test', '{"user_name": "alice"}'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.test', '{"user_name": "bob"}');
insert into public.agents (id, owner_user_id, handle, harness) values
  ('a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'alice-claude', 'claude_code'),
  ('b2222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'bob-codex', 'codex');

create function pg_temp.p(p_window interval default interval '70 seconds') returns text language sql as $$
  select y_private.derive_presence('a1111111-1111-4111-8111-111111111111', interval '150 seconds', p_window, interval '10 minutes')::text $$;

-- derive_presence: ingest fallback (no turn-reporting lease) ----------------------------
select is(pg_temp.p(), 'away', 'no sessions and no leases: away');
select is((select presence::text from public.agent_presence where agent_id = 'a1111111-1111-4111-8111-111111111111'),
  'away', 'a new agent is stored as away');

insert into public.sessions (agent_id, harness_session_id, last_event_at) values
  ('a1111111-1111-4111-8111-111111111111', 'sess-1', now() - interval '2 minutes');
select is(pg_temp.p(), 'live', 'an open session with an ingest 2 min ago and no turn reports: live');

update public.sessions set last_event_at = now() - interval '11 minutes' where harness_session_id = 'sess-1';
select is(pg_temp.p(), 'away', 'no ingest for 11 min (> 10 min fallback window): away');

update public.sessions set last_event_at = now(), status = 'closed', ended_at = now(), close_reason = 'session_end'
 where harness_session_id = 'sess-1';
select is(pg_temp.p(), 'away', 'an ended session is not live, however recent');

-- listening ------------------------------------------------------------------------------
insert into public.session_leases (agent_id, session_id, listening, last_heartbeat_at) values
  ('a1111111-1111-4111-8111-111111111111', 'sess-1', 'listening', now() - interval '30 seconds');
select is(pg_temp.p(), 'listening', 'a listening lease heartbeat 30 s ago: listening');

update public.session_leases set last_heartbeat_at = now() - interval '2 minutes' where session_id = 'sess-1';
select is(pg_temp.p(), 'away', 'a heartbeat older than the long-poll window (70 s): away');
select is(pg_temp.p(interval '630 seconds'), 'listening', 'the doorbell window (630 s) still counts a 2 min old heartbeat');

update public.session_leases set listening = 'listening_needs_approval', last_heartbeat_at = now() where session_id = 'sess-1';
select is(pg_temp.p(), 'listening_needs_approval', 'a fresh lease that needs approval: listening_needs_approval');

update public.session_leases set listening = 'none' where session_id = 'sess-1';
select is(pg_temp.p(), 'away', 'a fresh lease that is not listening: away');

update public.sessions set status = 'open', ended_at = null, close_reason = null, last_event_at = now() where harness_session_id = 'sess-1';
update public.session_leases set listening = 'listening' where session_id = 'sess-1';
select is(pg_temp.p(), 'live', 'live (ingest fallback) wins over listening');

-- turn reports ---------------------------------------------------------------------------
update public.session_leases set reports_turns = true, active_at = null where session_id = 'sess-1';
select is(pg_temp.p(), 'listening', 'a turn-reporting lease that says idle: a fresh ingest (end of a turn) is not live');

update public.session_leases set active_at = now() - interval '1 minute' where session_id = 'sess-1';
select is(pg_temp.p(), 'live', 'a turn reported 1 min ago: live');

update public.session_leases set active_at = now() - interval '3 minutes' where session_id = 'sess-1';
select is(pg_temp.p(), 'listening', 'no turn report for 3 min (> 150 s): back to listening');

insert into public.session_leases (agent_id, session_id, listening, last_heartbeat_at, active_at, reports_turns) values
  ('a1111111-1111-4111-8111-111111111111', 'sess-2', 'listening', now(), now(), true);
select is(pg_temp.p(), 'live', 'any of the agent''s sessions in a turn makes it live');
delete from public.session_leases where session_id = 'sess-2';

select ok(exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'sessions_agent_live_idx'),
  'live sessions are indexed by agent');

-- refresh_agent_presence ----------------------------------------------------------------
update public.session_leases set active_at = now() where session_id = 'sess-1';
select results_eq(
  $$ select agent_id, owner_user_id, presence from api.refresh_agent_presence(array['a1111111-1111-4111-8111-111111111111']::uuid[]) $$,
  $$ values ('a1111111-1111-4111-8111-111111111111'::uuid, '11111111-1111-4111-8111-111111111111'::uuid, 'live') $$,
  'refresh returns the change with the owner');
select is((select presence::text from public.agent_presence where agent_id = 'a1111111-1111-4111-8111-111111111111'),
  'live', 'refresh stores the derived value');
select is_empty(
  $$ select * from api.refresh_agent_presence(array['a1111111-1111-4111-8111-111111111111']::uuid[]) $$,
  'an unchanged agent returns no row');
select is_empty(
  $$ select * from api.refresh_agent_presence(array['b2222222-2222-4222-8222-222222222222']::uuid[]) $$,
  'an agent that stays away returns no row');
select is_empty(
  $$ select * from api.refresh_agent_presence(array[]::uuid[]) $$,
  'no candidates: no rows');
select is_empty(
  $$ select * from api.refresh_agent_presence(array['a1111111-1111-4111-8111-111111111111']::uuid[],
       interval '150 seconds', interval '70 seconds', interval '10 minutes') $$,
  'the windows can be passed explicitly (still live: no change)');

-- Sweep: alice's signals go stale, bob starts listening.
update public.sessions set last_event_at = now() - interval '1 hour' where harness_session_id = 'sess-1';
update public.session_leases set last_heartbeat_at = now() - interval '1 hour', active_at = now() - interval '1 hour' where session_id = 'sess-1';
insert into public.session_leases (agent_id, session_id, listening, last_heartbeat_at) values
  ('b2222222-2222-4222-8222-222222222222', 'sess-b', 'listening', now());
select set_eq(
  $$ select agent_id::text || ':' || presence from api.refresh_agent_presence() $$,
  array['a1111111-1111-4111-8111-111111111111:away', 'b2222222-2222-4222-8222-222222222222:listening'],
  'the sweep decays stale agents and promotes ones with fresh signals');
select is_empty($$ select * from api.refresh_agent_presence() $$, 'a second sweep changes nothing');
select is((select updated_at = now() from public.agent_presence where agent_id = 'b2222222-2222-4222-8222-222222222222'),
  true, 'refresh bumps updated_at');

-- Grants -----------------------------------------------------------------------------------
select ok(has_function_privilege('service_role', 'api.refresh_agent_presence(uuid[], interval, interval, interval)', 'EXECUTE'),
  'service_role may refresh presence');
select ok(not has_function_privilege('anon', 'api.refresh_agent_presence(uuid[], interval, interval, interval)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'y_private.derive_presence(uuid, interval, interval, interval)', 'EXECUTE'),
  'anon cannot refresh and API roles cannot call derive_presence');
select ok(has_column_privilege('authenticated', 'public.session_leases', 'active_at', 'UPDATE')
          and has_column_privilege('authenticated', 'public.session_leases', 'reports_turns', 'UPDATE'),
  'the pulse (as the agent) may write its lease''s turn state');

update public.session_leases set active_at = null where session_id = 'sess-1';
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","agent_id":"a1111111-1111-4111-8111-111111111111","via":"install"}', true);
select throws_ok($$ select * from api.refresh_agent_presence() $$, '42501', null, 'an agent cannot run the refresh');
select is((select presence::text from public.agent_presence where agent_id = 'a1111111-1111-4111-8111-111111111111'),
  'away', 'the owner''s agent still reads its own stored presence (RLS unchanged)');
update public.session_leases set active_at = now(), reports_turns = true where session_id = 'sess-1';
select is((select active_at is not null from public.session_leases where session_id = 'sess-1'), true,
  'the agent can update its own lease''s turn state under RLS');

select * from finish();
rollback;
