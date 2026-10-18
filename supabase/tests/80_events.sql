-- Events fan-out: pg_notify doorbell, Supabase Realtime broadcast to
-- secret topics (ids/counts only), audience-scoped reads, emit_event
-- hardening, retention.
-- Locally realtime.send() is the @paceline/db shim (pg_notify on
-- paceline_realtime, which pgTAP cannot observe). For the duration of this
-- test, a shim (or a missing function) is replaced by a recording stand-in
-- with Supabase's signature and target table (realtime.messages), so the
-- same assertions run on Supabase, where the real function is left alone.
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.test', '{"user_name": "alice"}'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.test', '{"user_name": "bob"}'),
  ('33333333-3333-4333-8333-333333333333', 'carol@example.test', '{"user_name": "carol"}');
insert into public.agents (id, owner_user_id, handle, harness) values
  ('a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'alice-claude', 'claude_code'),
  ('b2222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'bob-codex', 'codex'),
  ('c3333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333333', 'carol-claude', 'claude_code');
-- alice and bob are teammates; carol is unrelated.
insert into public.teams (id, slug, name, created_by) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'team-a', 'Team A', '11111111-1111-4111-8111-111111111111');
insert into public.team_members (team_id, user_id) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', '22222222-2222-4222-8222-222222222222');

select lives_ok($$ insert into public.events (type, audience_user_ids, payload)
                  values ('presence', array['11111111-1111-4111-8111-111111111111']::uuid[], '{"agentId": "x", "presence": "live"}') $$,
  'events insert works with or without Supabase Realtime');
select ok((select prosrc from pg_proc where proname = 'on_event_insert') ilike '%pg_notify(''paceline_events'', new.id::text)%',
  'every event rings pg_notify(''paceline_events'', id)');

create temp table test_env as
  select to_regprocedure('realtime.send(jsonb, text, text, boolean)') is null
         or coalesce(obj_description(to_regnamespace('realtime')::oid, 'pg_namespace'), '') like 'paceline local shim%'
         as record_locally;
do $env$
begin
  if (select record_locally from test_env) then
    create schema if not exists realtime;
    create table if not exists realtime.messages (
      topic text not null, event text, payload jsonb, private boolean, extension text not null default 'broadcast',
      inserted_at timestamptz not null default now());
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
    language sql as $f$ insert into realtime.messages (topic, event, payload, private) values (topic, event, payload, private) $f$;
  end if;
end
$env$;

select lives_ok($$ select api.emit_system_event('review.new', array['a1111111-1111-4111-8111-111111111111']::uuid[],
                                                array['11111111-1111-4111-8111-111111111111', '99999999-9999-4999-8999-999999999999']::uuid[],
                                                '{"reviewId": "rv_00000000000000000000RVW001"}') $$,
  'the worker emits an event that fans out');
select set_eq(
  $$ select m.topic from realtime.messages m where m.payload ->> 'type' = 'review.new' $$,
  $$ select c.owner_kind || ':' || c.owner_id || ':' || c.secret from public.realtime_channels c
     where (c.owner_kind, c.owner_id) in (('agent', 'a1111111-1111-4111-8111-111111111111'::uuid),
                                          ('user', '11111111-1111-4111-8111-111111111111'::uuid)) $$,
  'one broadcast per audience member with a channel, on agent:<id>:<secret> / user:<id>:<secret>');
select ok((select bool_and(m.event = 'review.new' and m.private = false
                           and (select array_agg(k order by k) from jsonb_object_keys(m.payload) k) = array['id', 'payload', 'type']
                           and m.payload -> 'payload' = '{"reviewId": "rv_00000000000000000000RVW001"}'::jsonb)
           from realtime.messages m where m.payload ->> 'type' = 'review.new'),
  'broadcasts are public-channel {id, type, payload} with ids only (RealtimeBroadcast)');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","via":"web"}', true);
select isnt(api.rotate_channel_secret('user', '11111111-1111-4111-8111-111111111111'), null, 'a user rotates their channel secret');
select throws_ok($$ select api.rotate_channel_secret('user', '22222222-2222-4222-8222-222222222222') $$, '42501', null,
  'nobody rotates someone else''s channel');
select set_eq($$ select type from api.my_events(0, 100) $$, array['presence', 'review.new'],
  'the web session sees user-addressed events');

-- emit_event (user context) ------------------------------------------------------------
select cmp_ok(api.emit_event('presence', array['b2222222-2222-4222-8222-222222222222']::uuid[],
                             array['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']::uuid[],
                             '{"agentId": "a_00000000000000000000AGT001", "presence": "live"}'), '>', 0::bigint,
  'core may notify the caller, a teammate and a teammate''s agent');
select cmp_ok(api.emit_event('thread.escalated', '{}', array['11111111-1111-4111-8111-111111111111']::uuid[],
                             '{"threadId": "t_00000000000000000000THR001"}'), '>', 0::bigint,
  'an agent''s escalation reaches its owner (thread.escalated)');
select throws_ok($$ select api.emit_event('presence', '{}', array['33333333-3333-4333-8333-333333333333']::uuid[], '{}') $$,
  '42501', null, 'a user context cannot ping an unrelated user');
select throws_ok($$ select api.emit_event('presence', array['c3333333-3333-4333-8333-333333333333']::uuid[], '{}', '{}') $$,
  '42501', null, 'a user context cannot ping an unrelated user''s agent');
select throws_ok($$ select api.emit_event('presence', array['99999999-9999-4999-8999-999999999999']::uuid[], '{}', '{}') $$,
  '42501', null, 'unknown agent ids are refused');
select throws_ok($$ select api.emit_event('review.new', '{}', array['11111111-1111-4111-8111-111111111111']::uuid[],
                                          '{"reviewId": "rv_00000000000000000000RVW002"}') $$,
  '42501', null, 'review.new, review.decided and change.updated are trigger-owned');
select throws_ok($$ select api.emit_event('change.updated', '{}', '{}', '{}') $$, '42501', null,
  'change.updated cannot be spoofed by core either');

select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","agent_id":"a1111111-1111-4111-8111-111111111111","via":"install"}', true);
select set_eq($$ select type from api.my_events(0, 100) $$, array['review.new'],
  'the agent sees only agent-addressed events');
select set_config('request.jwt.claims',
  '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated","via":"web"}', true);
select is_empty($$ select * from api.my_events(0, 100) $$, 'other users see none of these events');

reset role;
delete from realtime.messages where payload ->> 'type' = 'review.decided';
insert into public.events (type, audience_user_ids, payload)
  values ('review.decided', array['11111111-1111-4111-8111-111111111111']::uuid[], '{"reviewId": "rv_00000000000000000000RVW001"}');
select is((select m.topic from realtime.messages m where m.payload ->> 'type' = 'review.decided'),
  (select 'user:' || owner_id || ':' || secret from public.realtime_channels
   where owner_kind = 'user' and owner_id = '11111111-1111-4111-8111-111111111111'),
  'after rotation, broadcasts use the new secret');

select throws_ok($$ insert into public.events (type, audience_user_ids)
                   select 'presence', array_agg(gen_random_uuid()) from generate_series(1, 101) $$,
  '23514', null, 'audiences are capped at 100 ids (NOTIFY payload size)');

-- The worker's catch-up read (EventRecord shape).
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select ok((select bool_and((select array_agg(k order by k) from jsonb_object_keys(e.notify) k)
                            = array['audienceAgentIds', 'audienceUserIds', 'id', 'payload', 'type']
                           and jsonb_typeof(e.notify -> 'id') = 'string')
           from api.events_since(0, 100) e),
  'events_since returns EventRecord JSON (camelCase, string id)');
select is((select count(*)::int from api.events_since((select max(id) from public.events) - 1, 100)), 1,
  'events_since pages after a cursor');

-- Retention.
reset role;
insert into public.sessions (id, agent_id, harness_session_id)
  values ('5e551011-0000-4000-8000-000000000001', 'a1111111-1111-4111-8111-111111111111', 's1');
insert into public.activity_chunks (session_id, seq, digest_enc, error_episodes, local_distill, received_at) values
  ('5e551011-0000-4000-8000-000000000001', 0, '\x00', '[{"signature": "etimedout <n>s"}]', '{"mode": "local"}',
   now() - interval '25 hours'),
  ('5e551011-0000-4000-8000-000000000001', 1, '\x00', '[]', null, now()),
  ('5e551011-0000-4000-8000-000000000001', 2, null, '[]', '{"mode": "local"}', now() - interval '25 hours');
insert into public.events (type, created_at) values ('presence', now() - interval '8 days');
set local role service_role;
select is((api.purge_expired() ->> 'events')::int, 1, 'purge_expired drops events older than 7 days');
reset role;
select results_eq(
  $$ select seq, digest_enc is null, error_episodes = '[]'::jsonb, local_distill is null, digest_purged_at is not null
     from public.activity_chunks order by seq $$,
  $$ values (0, true, true, true, true), (1, false, true, true, false), (2, true, true, true, true) $$,
  'digests, error excerpts and local distill results older than 24 h are purged (I6); recent ones stay');

select lives_ok($$ select paceline_private.broadcast('user:x:y', 'presence', '{}') $$,
  'broadcast never raises');

select * from finish();
rollback;
