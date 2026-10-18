-- Owner instructions (PLAN §9, I5) and thread assignment:
-- * an instruction for an agent with an unattended session (bypassPermissions
--   / codex_never) needs the owner's confirm click: until then the agent can
--   neither see it nor mark it delivered, and only a human confirms, once;
-- * callers may force requires_confirm on, never off;
-- * only the agent itself marks delivery;
-- * update_thread 'assign' may only name a participant agent.
begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.test', '{"user_name": "alice"}'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.test', '{"user_name": "bob"}');
insert into public.agents (id, owner_user_id, handle, harness) values
  ('a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'alice-claude', 'claude_code'),
  ('a1111111-1111-4111-8111-000000000002', '11111111-1111-4111-8111-111111111111', 'alice-codex', 'codex'),
  ('b2222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'bob-codex', 'codex');
update public.agent_settings set remote_instructions = true
 where agent_id in ('a1111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-000000000002');
-- alice-claude has an unattended session; alice-codex does not.
insert into public.session_leases (agent_id, session_id, permission_mode, listening) values
  ('a1111111-1111-4111-8111-111111111111', 'sess-bypass', 'bypassPermissions', 'listening'),
  ('a1111111-1111-4111-8111-000000000002', 'sess-default', 'default', 'listening');

insert into public.threads (id, kind, state, created_by_user_id, created_by_agent_id) values
  ('00000000000000000000THR001', 'dm', 'open', '11111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111');
insert into public.thread_participants (thread_id, p_kind, p_id, owner_user_id) values
  ('00000000000000000000THR001', 'agent', 'a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111'),
  ('00000000000000000000THR001', 'agent', 'b2222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222');

set local role authenticated;

-- alice on the web ---------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","via":"web"}', true);
select lives_ok(
  $$ insert into public.owner_instructions (id, agent_id, created_by_user_id, body, verified_via, kid, sig, requires_confirm)
     values ('00000000000000000000NST001', 'a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111',
             'run the release checklist', 'web', 'k1', repeat('A', 86), false) $$,
  'the owner instructs the agent that has an unattended session');
select lives_ok(
  $$ insert into public.owner_instructions (id, agent_id, created_by_user_id, body, verified_via, kid, sig)
     values ('00000000000000000000NST002', 'a1111111-1111-4111-8111-000000000002', '11111111-1111-4111-8111-111111111111',
             'summarize the thread', 'web', 'k1', repeat('A', 86)) $$,
  'and the agent without one');
select lives_ok(
  $$ insert into public.owner_instructions (id, agent_id, created_by_user_id, body, verified_via, kid, sig, requires_confirm)
     values ('00000000000000000000NST003', 'a1111111-1111-4111-8111-000000000002', '11111111-1111-4111-8111-111111111111',
             'deploy to staging', 'web', 'k1', repeat('A', 86), true) $$,
  'core may force a confirm click');
select results_eq(
  $$ select id::text, requires_confirm from public.owner_instructions order by id $$,
  $$ values ('00000000000000000000NST001'::text, true), ('00000000000000000000NST002', false), ('00000000000000000000NST003', true) $$,
  'requires_confirm is derived from unattended sessions and can only be forced on');

-- alice-claude (the unattended agent) -------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","agent_id":"a1111111-1111-4111-8111-111111111111","via":"install"}', true);
select is_empty($$ select 1 from public.owner_instructions $$,
  'the agent cannot see an instruction that awaits the owner''s confirm');
update public.owner_instructions set delivered_at = now() where id = '00000000000000000000NST001';
update public.owner_instructions set confirmed_at = now(), confirmed_via = 'web' where id = '00000000000000000000NST001';

-- alice on Slack (linked user) ----------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","via":"slack"}', true);
select results_eq($$ select confirmed_at is null, delivered_at is null from public.owner_instructions
                     where id = '00000000000000000000NST001' $$,
  $$ values (true, true) $$, 'the agent could neither confirm nor mark it delivered');
select throws_ok(
  $$ update public.owner_instructions set confirmed_at = now(), confirmed_via = 'web' where id = '00000000000000000000NST001' $$,
  '42501', null, 'the confirmation records the channel it came through');
select lives_ok(
  $$ update public.owner_instructions set confirmed_at = now(), confirmed_via = 'slack' where id = '00000000000000000000NST001' $$,
  'the owner confirms from Slack');
update public.owner_instructions set confirmed_at = now() - interval '1 hour', confirmed_via = 'slack'
 where id = '00000000000000000000NST001';
select ok((select confirmed_at > now() - interval '1 minute' from public.owner_instructions where id = '00000000000000000000NST001'),
  'a confirmation is final (a second update changes nothing)');
update public.owner_instructions set delivered_at = now() where id = '00000000000000000000NST002';
select ok((select delivered_at is null from public.owner_instructions where id = '00000000000000000000NST002'),
  'the owner cannot mark an instruction delivered for the agent');

-- alice-claude again ---------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","agent_id":"a1111111-1111-4111-8111-111111111111","via":"install"}', true);
select set_eq($$ select id::text from public.owner_instructions $$, array['00000000000000000000NST001'],
  'once confirmed, the agent sees its own instruction (and not its sibling''s)');
select lives_ok($$ update public.owner_instructions set delivered_at = now() where id = '00000000000000000000NST001' $$,
  'and marks it delivered');

-- alice-codex (attended) -----------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","agent_id":"a1111111-1111-4111-8111-000000000002","via":"install"}', true);
select set_eq($$ select id::text from public.owner_instructions $$, array['00000000000000000000NST002'],
  'an attended agent sees its instruction at once; the forced-confirm one stays hidden');
select throws_ok(
  $$ update public.owner_instructions set delivered_at = now(), confirmed_at = now(), confirmed_via = 'web'
     where id = '00000000000000000000NST002' $$,
  '42501', null, 'an agent cannot confirm an instruction, even while marking it delivered');

-- Thread assignment (update_thread 'assign') ----------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","agent_id":"a1111111-1111-4111-8111-111111111111","via":"install"}', true);
select lives_ok($$ update public.threads set assigned_agent_id = 'b2222222-2222-4222-8222-222222222222'
                  where id = '00000000000000000000THR001' $$,
  'a participant agent assigns the thread to another participant');
select throws_ok($$ update public.threads set assigned_agent_id = 'a1111111-1111-4111-8111-000000000002'
                   where id = '00000000000000000000THR001' $$,
  '42501', null, 'the assignee must be a participant agent');
select is((select assigned_agent_id from public.threads where id = '00000000000000000000THR001'),
  'b2222222-2222-4222-8222-222222222222'::uuid, 'participants see the assignee');
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","via":"web"}', true);
select lives_ok($$ update public.threads set assigned_agent_id = null where id = '00000000000000000000THR001' $$,
  'the owner clears the assignment');
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","agent_id":"b2222222-2222-4222-8222-222222222222","via":"install"}', true);
select is_empty($$ select 1 from public.owner_instructions $$, 'another owner''s agent never sees these instructions');

select * from finish();
rollback;
