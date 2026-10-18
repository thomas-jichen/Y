-- PLAN §8 added features: company groups (orgs with per-member opt-in),
-- friendships (request/accept), prompt feedback (private), plus follows,
-- notification prefs and OAuth grants (all human-only writes).
begin;
create extension if not exists pgtap with schema extensions;
select plan(25);

insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.test', '{"user_name": "alice"}'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.test', '{"user_name": "bob"}'),
  ('33333333-3333-4333-8333-333333333333', 'carol@example.test', '{"user_name": "carol"}');
insert into public.agents (id, owner_user_id, handle, harness) values
  ('a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'alice-claude', 'claude_code'),
  ('b2222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'bob-codex', 'codex');
insert into public.teams (id, slug, name, created_by) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'team-a', 'Team A', '11111111-1111-4111-8111-111111111111');
insert into public.prompt_feedback (id, user_id, kind, observation, suggestion) values
  ('00000000000000000000PFB001', '22222222-2222-4222-8222-222222222222', 'context',
   'Sessions that named the failing test up front took fewer turns', 'Start with the failing test name');

set local role authenticated;

-- Orgs ----------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","via":"web"}', true);
select lives_ok($$ insert into public.orgs (slug, name, created_by) values ('acme', 'Acme', '11111111-1111-4111-8111-111111111111') $$,
  'a human creates an org');
select is((select role::text from public.org_members where user_id = '11111111-1111-4111-8111-111111111111'), 'owner',
  'the creator owns the org');
select throws_ok(
  $$ insert into public.org_members (org_id, user_id, share_aggregates)
     select id, '22222222-2222-4222-8222-222222222222', true from public.orgs where slug = 'acme' $$,
  '42501', null, 'an admin cannot opt a member in');
select lives_ok(
  $$ insert into public.org_members (org_id, user_id) select id, '22222222-2222-4222-8222-222222222222' from public.orgs where slug = 'acme' $$,
  'an admin adds a member with every opt-in off');
select throws_ok($$ update public.org_members set show_on_leaderboard = true where user_id = '22222222-2222-4222-8222-222222222222' $$,
  '42501', null, 'an admin cannot change a member''s opt-in flags');
select lives_ok(
  $$ insert into public.org_teams (org_id, team_id) select id, 'aaaaaaaa-0000-4000-8000-00000000000a' from public.orgs where slug = 'acme' $$,
  'an org admin who also administers the team attaches it');

select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","via":"web"}', true);
select lives_ok($$ update public.org_members set share_aggregates = true where user_id = '22222222-2222-4222-8222-222222222222' $$,
  'a member opts in themselves');
select throws_ok($$ update public.org_members set role = 'admin' where user_id = '22222222-2222-4222-8222-222222222222' $$,
  '42501', null, 'a member cannot promote themselves');
select ok(exists (select 1 from public.users where handle = 'alice'), 'org co-members see each other');

select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated","via":"web"}', true);
select ok((select count(*) from public.orgs) + (select count(*) from public.org_members) + (select count(*) from public.org_teams) = 0,
  'non-members see nothing of the org');

-- Friendships -------------------------------------------------------------------------------
select lives_ok(
  $$ insert into public.friendships (requester_id, addressee_id) values ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111') $$,
  'a human sends a friend request');
update public.friendships set state = 'accepted' where requester_id = '33333333-3333-4333-8333-333333333333';
select is((select state from public.friendships), 'pending', 'the requester cannot accept their own request');

select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","agent_id":"a1111111-1111-4111-8111-111111111111","via":"install"}', true);
update public.friendships set state = 'accepted' where addressee_id = '11111111-1111-4111-8111-111111111111';
select is((select state from public.friendships), 'pending', 'an agent cannot accept a friend request');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","via":"web"}', true);
select throws_ok(
  $$ insert into public.friendships (requester_id, addressee_id) values ('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333') $$,
  '23505', null, 'one friendship per pair, whichever direction');
select lives_ok($$ update public.friendships set state = 'accepted' where addressee_id = '11111111-1111-4111-8111-111111111111' $$,
  'the addressee accepts');
select ok((select responded_at is not null from public.friendships), 'the response is time-stamped');
select ok(exists (select 1 from public.users where handle = 'carol'), 'friends see each other''s profiles');

select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","via":"web"}', true);
select is((select count(*)::int from public.friendships), 0, 'third parties cannot see a friendship');

-- Follows ----------------------------------------------------------------------------------
select lives_ok($$ insert into public.follows (follower_user_id, agent_id) values ('22222222-2222-4222-8222-222222222222', 'a1111111-1111-4111-8111-111111111111') $$,
  'a human follows an agent');
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","agent_id":"b2222222-2222-4222-8222-222222222222","via":"install"}', true);
select throws_ok($$ delete from public.follows; insert into public.follows (follower_user_id, agent_id) values ('22222222-2222-4222-8222-222222222222', 'b2222222-2222-4222-8222-222222222222') $$,
  '42501', null, 'agents cannot follow (following grants DM access)');

-- Prompt feedback ---------------------------------------------------------------------------
select is((select count(*)::int from public.prompt_feedback), 1, 'prompt feedback is readable by its user');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","via":"web"}', true);
select lives_ok($$ update public.prompt_feedback set helpful = true where id = '00000000000000000000PFB001' $$,
  'the user rates their feedback');
select throws_ok($$ update public.prompt_feedback set observation = 'x' where id = '00000000000000000000PFB001' $$,
  '42501', null, 'feedback text is written by the worker only');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","via":"web"}', true);
select is((select count(*)::int from public.prompt_feedback), 0, 'prompt feedback is private to its user');

-- Notification prefs / OAuth grants ---------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","via":"oauth"}', true);
select throws_ok($$ insert into public.oauth_grants (user_id, client_id, permissions) values ('11111111-1111-4111-8111-111111111111', 'chatgpt', '{dm.send}') $$,
  '42501', null, 'an OAuth client cannot grant itself permissions');

reset role;
select * from finish();
rollback;
