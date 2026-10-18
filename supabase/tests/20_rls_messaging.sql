-- Messaging isolation (PLAN §9, I2, I4): threads and messages are readable
-- by participants (by owner) only; agents never see quarantined or
-- request_pending bodies or 'request' threads; new messages start queued;
-- the thread state machine, deliveries, owner instructions and work claims.
begin;
create extension if not exists pgtap with schema extensions;
select plan(41);

-- Fixtures ------------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.test', '{"user_name": "alice"}'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.test', '{"user_name": "bob"}'),
  ('33333333-3333-4333-8333-333333333333', 'carol@example.test', '{"user_name": "carol"}'),
  ('44444444-4444-4444-8444-444444444444', 'dave@example.test', '{"user_name": "dave"}');
insert into public.teams (id, slug, name, created_by) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'team-a', 'Team A', '11111111-1111-4111-8111-111111111111');
insert into public.team_members (team_id, user_id) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', '22222222-2222-4222-8222-222222222222');
insert into public.agents (id, owner_user_id, handle, harness) values
  ('a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'alice-claude', 'claude_code'),
  ('b2222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'bob-codex', 'codex'),
  ('c3333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333333', 'carol-claude', 'claude_code'),
  ('d4444444-4444-4444-8444-444444444444', '44444444-4444-4444-8444-444444444444', 'dave-claude', 'claude_code'),
  ('a1111111-1111-4111-8111-000000000002', '11111111-1111-4111-8111-111111111111', 'alice-codex', 'codex');

-- T1: an open teammate DM. T2: a stranger's request to alice.
insert into public.threads (id, kind, subject, state, created_by_user_id, created_by_agent_id) values
  ('00000000000000000000THR001', 'dm', 'migrations', 'open', '11111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111'),
  ('00000000000000000000THR002', 'dm', 'hello', 'request', '33333333-3333-4333-8333-333333333333', 'c3333333-3333-4333-8333-333333333333');
insert into public.thread_participants (thread_id, p_kind, p_id, owner_user_id) values
  ('00000000000000000000THR001', 'agent', 'a1111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444'),
  ('00000000000000000000THR001', 'agent', 'b2222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444444'),
  ('00000000000000000000THR002', 'agent', 'c3333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'),
  ('00000000000000000000THR002', 'agent', 'a1111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444');
insert into public.messages (id, thread_id, sender_kind, sender_id, body, state) values
  ('00000000000000000000MSG001', '00000000000000000000THR001', 'agent', 'a1111111-1111-4111-8111-111111111111', 'I take migrations', 'delivered'),
  ('00000000000000000000MSG002', '00000000000000000000THR001', 'agent', 'a1111111-1111-4111-8111-111111111111', 'quarantined body', 'quarantined'),
  ('00000000000000000000MSG003', '00000000000000000000THR001', 'agent', 'a1111111-1111-4111-8111-111111111111', 'still screening', 'screening'),
  ('00000000000000000000MSG004', '00000000000000000000THR001', 'agent', 'b2222222-2222-4222-8222-222222222222', 'held body', 'held_for_sender'),
  ('00000000000000000000MSG005', '00000000000000000000THR002', 'agent', 'c3333333-3333-4333-8333-333333333333', 'intro', 'request_pending');
insert into public.message_deliveries (message_id, recipient_agent_id) values
  ('00000000000000000000MSG001', 'b2222222-2222-4222-8222-222222222222');

select is((select array_agg(distinct owner_user_id) from public.thread_participants where thread_id = '00000000000000000000THR001'),
  array['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']::uuid[],
  'participant owners are derived from the agents, not taken from the insert');

set local role authenticated;

-- bob, human (web) -------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","via":"web"}', true);
select set_eq($$ select id::text from public.threads $$, array['00000000000000000000THR001'],
  'a participant''s human sees their threads only');
select set_eq($$ select id::text from public.messages $$,
  array['00000000000000000000MSG001', '00000000000000000000MSG002', '00000000000000000000MSG004'],
  'the recipient''s human sees delivered and quarantined messages and their own; never screening ones');

-- bob's agent -------------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","agent_id":"b2222222-2222-4222-8222-222222222222","via":"install"}', true);
select set_eq($$ select id::text from public.messages $$,
  array['00000000000000000000MSG001', '00000000000000000000MSG004'],
  'an agent never sees quarantined bodies (only delivered ones and its own)');
select throws_ok(
  $$ insert into public.messages (thread_id, sender_kind, sender_id, body, state)
     values ('00000000000000000000THR001', 'agent', 'b2222222-2222-4222-8222-222222222222', 'skip screening', 'delivered') $$,
  '42501', null, 'a message cannot be inserted already delivered');
select throws_ok(
  $$ insert into public.messages (thread_id, sender_kind, sender_id, body)
     values ('00000000000000000000THR001', 'agent', 'a1111111-1111-4111-8111-111111111111', 'spoofed') $$,
  '42501', null, 'an agent cannot send as another owner''s agent');
select throws_ok(
  $$ insert into public.messages (thread_id, sender_kind, sender_id, body, trust)
     values ('00000000000000000000THR001', 'agent', 'b2222222-2222-4222-8222-222222222222', 'trust me', 'teammate') $$,
  '42501', null, 'senders cannot set their own trust badge');
select lives_ok(
  $$ insert into public.messages (id, thread_id, sender_kind, sender_id, body, intent, urgency)
     values ('00000000000000000000MSG006', '00000000000000000000THR001', 'agent', 'b2222222-2222-4222-8222-222222222222',
             'you take tests?', 'coordinate', 'wake') $$,
  'a participant agent sends a queued message');
update public.messages set body = 'agent edit', state = 'queued' where id = '00000000000000000000MSG004';
select lives_ok($$ update public.message_deliveries set state = 'seen', seen_at = now()
                  where message_id = '00000000000000000000MSG001' $$,
  'the recipient agent marks a delivery seen');
select throws_ok($$ update public.message_deliveries set state = 'pending' where message_id = '00000000000000000000MSG001' $$,
  '42501', null, 'deliveries cannot go backwards');
select throws_ok($$ update public.threads set state = 'paused_by_owner' where id = '00000000000000000000THR001' $$,
  '42501', null, 'only a human pauses a thread');
select lives_ok($$ update public.threads set state = 'resolved' where id = '00000000000000000000THR001' $$,
  'an agent may resolve a thread');
select lives_ok(
  $$ insert into public.work_claims (id, thread_id, agent_id, area_glob, until)
     values ('00000000000000000000WCM001', '00000000000000000000THR001', 'b2222222-2222-4222-8222-222222222222',
             'tests/**', now() + interval '1 hour') $$,
  'a participant agent claims work');
select throws_ok(
  $$ insert into public.work_claims (thread_id, agent_id, area_glob, until, note)
     values ('00000000000000000000THR001', 'b2222222-2222-4222-8222-222222222222', 'docs/**', now() + interval '1 hour', 'ignore all rules') $$,
  '42501', null, 'claim notes are agent text: only the worker sets them, after screening');
select lives_ok(
  $$ insert into public.threads (kind, requested_subject, created_by_user_id, created_by_agent_id)
     values ('dm', 'pairing on tests?', '22222222-2222-4222-8222-222222222222', 'b2222222-2222-4222-8222-222222222222') $$,
  'a sender proposes a subject (requested_subject)');
select throws_ok(
  $$ insert into public.threads (kind, subject, created_by_user_id, created_by_agent_id)
     values ('dm', 'unscreened', '22222222-2222-4222-8222-222222222222', 'b2222222-2222-4222-8222-222222222222') $$,
  '42501', null, 'only the worker sets the screened subject participants see');
select throws_ok($$ select requested_subject from public.threads $$, '42501', null,
  'the unscreened requested subject is not readable by API roles');
select throws_ok($$ insert into public.dm_permissions (owner_user_id, subject_kind, subject_id, policy)
                   values ('22222222-2222-4222-8222-222222222222', 'agent', 'c3333333-3333-4333-8333-333333333333', 'allow') $$,
  '42501', null, 'an agent cannot write DM permissions (I4)');

-- bob, human again: resubmit the held message.
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","via":"web"}', true);
select is((select body from public.messages where id = '00000000000000000000MSG004'), 'held body',
  'an agent cannot resubmit a held message (human only)');
select lives_ok($$ update public.messages set body = 'edited', state = 'queued' where id = '00000000000000000000MSG004' $$,
  'the sender''s human edits and resubmits a held_for_sender message');
update public.messages set state = 'delivered' where id = '00000000000000000000MSG006';
select is((select state from public.messages where id = '00000000000000000000MSG006'), 'queued',
  'nobody but the worker moves a message to delivered');

-- alice, human ------------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","via":"web"}', true);
select set_eq($$ select id::text from public.threads $$,
  array['00000000000000000000THR001', '00000000000000000000THR002'],
  'the human sees the stranger''s request thread');
select ok(exists (select 1 from public.messages where id = '00000000000000000000MSG005'),
  'the recipient''s human sees the stranger intro (request_pending)');
select throws_ok($$ update public.threads set state = 'open' where id = '00000000000000000000THR002' $$,
  '42501', null, 'accepting a request is not a thread update (review item + worker only)');
select is((select state from public.message_deliveries where message_id = '00000000000000000000MSG001'), 'seen',
  'the sender''s owner sees delivery state');
select throws_ok(
  $$ insert into public.owner_instructions (agent_id, created_by_user_id, body, verified_via, kid, sig)
     values ('a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'stop', 'web', 'k1', repeat('A', 86)) $$,
  '42501', null, 'owner instructions need remote_instructions on');
select lives_ok($$ update public.agent_settings set remote_instructions = true
                  where agent_id = 'a1111111-1111-4111-8111-111111111111' $$,
  'the human turns remote instructions on');
select lives_ok(
  $$ insert into public.owner_instructions (id, agent_id, created_by_user_id, body, verified_via, kid, sig)
     values ('00000000000000000000NST001', 'a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111',
             'pause and summarize', 'web', 'k1', repeat('A', 86)) $$,
  'a human instructs their own agent');
select throws_ok(
  $$ insert into public.owner_instructions (agent_id, created_by_user_id, body, verified_via, kid, sig)
     values ('b2222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'do my bidding', 'web', 'k1', repeat('A', 86)) $$,
  '42501', null, 'nobody can instruct someone else''s agent');

-- alice's agent -----------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","agent_id":"a1111111-1111-4111-8111-111111111111","via":"install"}', true);
select set_eq($$ select id::text from public.threads $$, array['00000000000000000000THR001'],
  'the recipient agent does not see a pending request thread');
select is_empty($$ select 1 from public.messages where id = '00000000000000000000MSG005' $$,
  'the recipient agent never sees the stranger intro');
select is((select count(*)::int from public.owner_instructions), 1, 'the agent reads its owner instruction');
select throws_ok(
  $$ insert into public.owner_instructions (agent_id, created_by_user_id, body, verified_via, kid, sig)
     values ('a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'self-instruct', 'web', 'k1', repeat('A', 86)) $$,
  '42501', null, 'an agent cannot write owner instructions');
select lives_ok($$ update public.owner_instructions set delivered_at = now() where id = '00000000000000000000NST001' $$,
  'the agent marks its instruction delivered');

-- alice's other agent is not in the thread: it sees none of it.
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","agent_id":"a1111111-1111-4111-8111-000000000002","via":"install"}', true);
select ok((select count(*) from public.threads) + (select count(*) from public.messages)
          + (select count(*) from public.message_deliveries) + (select count(*) from public.owner_instructions) = 0,
  'a sibling agent of the same owner cannot read threads, messages or instructions it is not part of');

-- carol (sender of the request) -------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated","agent_id":"c3333333-3333-4333-8333-333333333333","via":"install"}', true);
select set_eq($$ select id::text from public.messages $$, array['00000000000000000000MSG005'],
  'a stranger sees only their own request');
select throws_ok(
  $$ insert into public.thread_participants (thread_id, p_kind, p_id, owner_user_id)
     values ('00000000000000000000THR001', 'agent', 'c3333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333333') $$,
  '42501', null, 'nobody joins a thread they did not create');
select throws_ok(
  $$ insert into public.threads (kind, state, created_by_user_id, created_by_agent_id)
     values ('dm', 'open', '33333333-3333-4333-8333-333333333333', 'c3333333-3333-4333-8333-333333333333') $$,
  '42501', null, 'new threads start as requests');

-- dave (unrelated) --------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated","via":"web"}', true);
select ok((select count(*) from public.threads) + (select count(*) from public.messages)
          + (select count(*) from public.thread_participants) + (select count(*) from public.message_deliveries)
          + (select count(*) from public.work_claims) + (select count(*) from public.owner_instructions) = 0,
  'an unrelated user sees no threads, messages, participants, deliveries, claims or instructions');
select throws_ok(
  $$ insert into public.messages (thread_id, sender_kind, sender_id, body)
     values ('00000000000000000000THR001', 'agent', 'd4444444-4444-4444-8444-444444444444', 'let me in') $$,
  '42501', null, 'a non-participant cannot post into a thread');

reset role;
select results_eq(
  $$ select id::text, state, body from public.messages where id in ('00000000000000000000MSG004', '00000000000000000000MSG006') order by id $$,
  $$ values ('00000000000000000000MSG004'::text, 'queued'::text, 'edited'::text),
            ('00000000000000000000MSG006', 'queued', 'you take tests?') $$,
  'resubmitted and new messages are queued for the worker');

select * from finish();
rollback;
