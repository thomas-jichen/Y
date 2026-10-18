-- I4: DM permissions are default-deny, readable by their owner only, and
-- writable only by the owner in a human context (web or Slack). No agent,
-- MCP/OAuth client or raw JWT can write them.
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.test', '{"user_name": "alice"}'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.test', '{"user_name": "bob"}');
insert into public.agents (id, owner_user_id, handle, harness) values
  ('a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'alice-claude', 'claude_code'),
  ('b2222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'bob-codex', 'codex');

set local role authenticated;

-- The owner, on the web.
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","via":"web"}', true);
select ok(paceline_private.is_human(), 'a web session is a human context');
select lives_ok(
  $$ insert into public.dm_permissions (owner_user_id, subject_kind, subject_id, policy, delivery)
     values ('11111111-1111-4111-8111-111111111111', 'agent', 'b2222222-2222-4222-8222-222222222222', 'allow', 'next_turn') $$,
  'the owner adds a DM rule on the web');
select throws_ok(
  $$ insert into public.dm_permissions (owner_user_id, subject_kind, subject_id, policy)
     values ('11111111-1111-4111-8111-111111111111', 'relationship', 'everyone', 'allow') $$,
  '23514', null, 'relationship rules must name a known relationship');

-- The owner, through a linked Slack user.
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","via":"slack"}', true);
select lives_ok(
  $$ update public.dm_permissions set delivery = 'wake' where owner_user_id = '11111111-1111-4111-8111-111111111111' $$,
  'the owner changes a rule from Slack');

-- The owner's agent (install token).
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","agent_id":"a1111111-1111-4111-8111-111111111111","via":"install"}', true);
select ok(not paceline_private.is_human(), 'an install token is not a human context');
select is((select count(*)::int from public.dm_permissions), 1, 'the agent may read its owner''s rules');
select throws_ok(
  $$ insert into public.dm_permissions (owner_user_id, subject_kind, subject_id, policy)
     values ('11111111-1111-4111-8111-111111111111', 'relationship', 'stranger', 'allow') $$,
  '42501', null, 'an agent cannot add DM permissions');
update public.dm_permissions set policy = 'allow', delivery = 'wake' where owner_user_id = '11111111-1111-4111-8111-111111111111';
update public.dm_permissions set policy = 'deny' where owner_user_id = '11111111-1111-4111-8111-111111111111';
delete from public.dm_permissions where owner_user_id = '11111111-1111-4111-8111-111111111111';

-- An agent claiming via=web is still an agent.
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","agent_id":"a1111111-1111-4111-8111-111111111111","via":"web"}', true);
select ok(not paceline_private.is_human(), 'any agent_id claim means agent context, whatever via says');
select throws_ok(
  $$ insert into public.dm_permissions (owner_user_id, subject_kind, subject_id, policy)
     values ('11111111-1111-4111-8111-111111111111', 'relationship', 'stranger', 'allow') $$,
  '42501', null, 'an agent context with via=web cannot write DM permissions');

-- A malformed agent id never falls back to a human context.
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","agent_id":"not-a-uuid","via":"web"}', true);
select ok(not paceline_private.is_human() and paceline_private.acting_agent_id() = '00000000-0000-0000-0000-000000000000',
  'a malformed agent_id claim maps to the nil agent, not to a human');

-- An OAuth MCP client (ChatGPT/claude.ai) acting for the owner.
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","via":"oauth"}', true);
select throws_ok(
  $$ insert into public.dm_permissions (owner_user_id, subject_kind, subject_id, policy)
     values ('11111111-1111-4111-8111-111111111111', 'relationship', 'stranger', 'allow') $$,
  '42501', null, 'an OAuth MCP client cannot write DM permissions');

-- A raw Supabase JWT (e.g. straight to the Data API) carries no `via`.
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select throws_ok(
  $$ insert into public.dm_permissions (owner_user_id, subject_kind, subject_id, policy)
     values ('11111111-1111-4111-8111-111111111111', 'relationship', 'stranger', 'allow') $$,
  '42501', null, 'a raw JWT without via cannot write DM permissions');

-- Another user, on the web.
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","via":"web"}', true);
select is((select count(*)::int from public.dm_permissions), 0, 'other users cannot read someone''s DM rules');
select throws_ok(
  $$ insert into public.dm_permissions (owner_user_id, subject_kind, subject_id, policy)
     values ('11111111-1111-4111-8111-111111111111', 'agent', 'b2222222-2222-4222-8222-222222222222', 'allow') $$,
  '42501', null, 'nobody writes DM rules for someone else');
update public.dm_permissions set policy = 'allow' where owner_user_id = '11111111-1111-4111-8111-111111111111';
delete from public.dm_permissions where owner_user_id = '11111111-1111-4111-8111-111111111111';

-- Signed out.
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select * from public.dm_permissions $$, '42501', null, 'anon has no access to DM permissions');

reset role;
select results_eq(
  $$ select subject_kind, subject_id, policy, delivery from public.dm_permissions $$,
  $$ values ('agent'::text, 'b2222222-2222-4222-8222-222222222222'::text, 'allow'::text, 'wake'::text) $$,
  'agent, OAuth and other-user updates and deletes changed nothing');

-- The owner removes the rule on the web.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","via":"web"}', true);
select lives_ok($$ delete from public.dm_permissions where owner_user_id = '11111111-1111-4111-8111-111111111111' $$,
  'the owner deletes a rule on the web');
select is((select count(*)::int from public.dm_permissions), 0, 'the rule is gone');

-- No DM-permission path through the api schema either.
reset role;
select is_empty(
  $$ select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'api' and p.prosrc ilike '%dm_permissions%' $$,
  'no api function writes dm_permissions');
select ok(not has_table_privilege('anon', 'public.dm_permissions', 'SELECT'), 'anon has no grant on dm_permissions');

select * from finish();
rollback;
