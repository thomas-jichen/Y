-- Cross-tenant isolation for activities and their dependents: team content
-- stays in the team, repo visibility needs verified repo_access, public is
-- readable signed-out, drafts and unscreened rows stay with the owner, and
-- writes start in their initial state only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(34);

-- Fixtures -----------------------------------------------------------------------------
-- alice (team A owner), bob (team A member, access to repo key b...), carol (team B).
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.test', '{"user_name": "alice"}'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.test', '{"user_name": "bob"}'),
  ('33333333-3333-4333-8333-333333333333', 'carol@example.test', '{"user_name": "carol"}');
insert into public.teams (id, slug, name, created_by) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'team-a', 'Team A', '11111111-1111-4111-8111-111111111111'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'team-b', 'Team B', '33333333-3333-4333-8333-333333333333');
insert into public.team_members (team_id, user_id) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', '22222222-2222-4222-8222-222222222222');
insert into public.agents (id, owner_user_id, handle, harness, variant) values
  ('a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'alice-claude', 'claude_code', 1),
  ('b2222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'bob-codex', 'codex', 1),
  ('b2222222-2222-4222-8222-000000000002', '22222222-2222-4222-8222-222222222222', 'bob-claude', 'claude_code', 1),
  ('c3333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333333', 'carol-claude', 'claude_code', 1);
insert into public.sessions (id, agent_id, harness_session_id) values
  ('5e551011-0000-4000-8000-0000000000b2', 'b2222222-2222-4222-8222-222222222222', 'bob-session-1');
insert into public.repo_access (user_id, team_id, repo_key, verified_at) values
  ('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-0000-4000-8000-00000000000a', repeat('b', 64), now());
insert into public.setup_versions (id, agent_id, hash, snapshot) values
  ('00000000000000000000SETP01', 'a1111111-1111-4111-8111-111111111111', repeat('5', 64), '{"v": 1}'),
  ('00000000000000000000SETP02', 'a1111111-1111-4111-8111-111111111111', repeat('6', 64), '{"v": 1}');
insert into public.setup_components (setup_version_id, kind, name) values
  ('00000000000000000000SETP01', 'skill', 'vitest-fixer'), ('00000000000000000000SETP02', 'skill', 'secret-sauce');

-- Owner is derived from the agent (owner_user_id below is overwritten by trigger).
insert into public.activities (id, agent_id, owner_user_id, team_id, visibility, status, screen_action, published_at,
                               title, repo_key, setup_version_id) values
  ('00000000000000000000ACTTM1', 'a1111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333',
   'aaaaaaaa-0000-4000-8000-00000000000a', 'team', 'published', 'allow', now() - interval '5 minutes', 'team published', null,
   '00000000000000000000SETP01'),
  ('00000000000000000000ACTRP1', 'a1111111-1111-4111-8111-111111111111', null,
   'aaaaaaaa-0000-4000-8000-00000000000a', 'repo', 'published', 'allow', now() - interval '4 minutes', 'repo c', repeat('c', 64), null),
  ('00000000000000000000ACTRP2', 'a1111111-1111-4111-8111-111111111111', null,
   'aaaaaaaa-0000-4000-8000-00000000000a', 'repo', 'published', 'label', now() - interval '3 minutes', 'repo b', repeat('b', 64), null),
  ('00000000000000000000ACTPB1', 'a1111111-1111-4111-8111-111111111111', null,
   null, 'public', 'published', 'allow', now() - interval '2 minutes', 'public', null, null),
  ('00000000000000000000ACTDR1', 'a1111111-1111-4111-8111-111111111111', null,
   'aaaaaaaa-0000-4000-8000-00000000000a', 'team', 'draft', null, null, 'team draft', null, '00000000000000000000SETP02'),
  ('00000000000000000000ACTPV1', 'a1111111-1111-4111-8111-111111111111', null,
   null, 'private', 'published', 'allow', now() - interval '1 minute', 'private', null, null),
  ('00000000000000000000ACTQR1', 'a1111111-1111-4111-8111-111111111111', null,
   'aaaaaaaa-0000-4000-8000-00000000000a', 'team', 'published', 'quarantine', now(), 'team quarantined', null, null),
  ('00000000000000000000ACTCB1', 'c3333333-3333-4333-8333-333333333333', null,
   'bbbbbbbb-0000-4000-8000-00000000000b', 'team', 'published', 'allow', now(), 'carol team', null, null);

select is((select owner_user_id from public.activities where id = '00000000000000000000ACTTM1'),
  '11111111-1111-4111-8111-111111111111'::uuid, 'owner_user_id is always derived from the agent');

-- bob: teammate of alice, repo access to b only -------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","via":"web"}', true);

select set_eq($$ select id::text from public.activities where agent_id = 'a1111111-1111-4111-8111-111111111111' $$,
  array['00000000000000000000ACTTM1', '00000000000000000000ACTRP2', '00000000000000000000ACTPB1'],
  'a teammate sees published team content, repo content with repo_access, and public content');
select is_empty($$ select 1 from public.activities where id = '00000000000000000000ACTRP1' $$,
  'repo visibility requires repo_access for that repo');
select is_empty($$ select 1 from public.activities where id = '00000000000000000000ACTDR1' $$,
  'drafts are visible to the owner only');
select is_empty($$ select 1 from public.activities where id = '00000000000000000000ACTQR1' $$,
  'quarantined (screen_action quarantine) content is hidden from teammates');
select is_empty($$ select 1 from public.activities where id = '00000000000000000000ACTCB1' $$,
  'another team''s content is invisible');
select set_eq($$ select setup_version_id::text from public.setup_components $$, array['00000000000000000000SETP01'],
  'setup cards are visible only through visible activities');
select is((select array_agg(id::text order by published_at desc, id desc) from api.feed_activities(null, null, 10, 'team',
            'aaaaaaaa-0000-4000-8000-00000000000a')),
  array['00000000000000000000ACTRP2', '00000000000000000000ACTTM1'],
  'feed_activities returns the visible team page, newest first');
select is((select array_agg(id::text) from api.feed_activities(now() - interval '210 seconds', '00000000000000000000ACTRP2', 10, 'all')),
  array['00000000000000000000ACTTM1'], 'feed_activities continues after a keyset cursor');

-- Writes as bob
select throws_ok(
  $$ insert into public.activities (agent_id, owner_user_id, status, visibility)
     values ('a1111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'open', 'private') $$,
  '42501', null, 'cannot create an activity for someone else''s agent');
select throws_ok(
  $$ insert into public.activities (agent_id, owner_user_id, status, visibility, team_id)
     values ('b2222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'published', 'team',
             'aaaaaaaa-0000-4000-8000-00000000000a') $$,
  '42501', null, 'cannot create an already-published activity');
select throws_ok(
  $$ insert into public.activities (agent_id, owner_user_id, status, visibility)
     values ('b2222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'open', 'public') $$,
  '42501', null, 'cannot create public content directly');
select throws_ok(
  $$ insert into public.activities (agent_id, owner_user_id, status, visibility, team_id)
     values ('b2222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'open', 'team',
             'bbbbbbbb-0000-4000-8000-00000000000b') $$,
  '42501', null, 'cannot post into a team you are not in');
select throws_ok(
  $$ insert into public.activities (agent_id, owner_user_id, status, visibility, screen_action)
     values ('b2222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'open', 'private', 'allow') $$,
  '42501', null, 'cannot pre-screen your own content');
select lives_ok(
  $$ insert into public.activities (id, agent_id, owner_user_id, status, visibility, team_id, title)
     values ('00000000000000000000ACTBB1', 'b2222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222',
             'open', 'team', 'aaaaaaaa-0000-4000-8000-00000000000a', '12 tool calls') $$,
  'an owner creates an open team activity for their own agent');
select throws_ok(
  $$ insert into public.activities (agent_id, owner_user_id, status, visibility, setup_version_id)
     values ('b2222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'open', 'private',
             '00000000000000000000SETP02') $$,
  '42501', null, 'cannot attach another agent''s setup version (it would leak that setup card)');
select throws_ok(
  $$ insert into public.activity_chunks (session_id, seq, activity_id)
     values ('5e551011-0000-4000-8000-0000000000b2', 0, '00000000000000000000ACTTM1') $$,
  '42501', null, 'cannot attach chunks (stats) to someone else''s activity');
select lives_ok(
  $$ insert into public.activity_chunks (session_id, seq, activity_id, stats_delta)
     values ('5e551011-0000-4000-8000-0000000000b2', 0, '00000000000000000000ACTBB1', '{"turns": 3}') $$,
  'chunks attach to the session agent''s own activity');
select lives_ok($$ insert into public.kudos (activity_id, user_id) values ('00000000000000000000ACTTM1', '22222222-2222-4222-8222-222222222222') $$,
  'kudos on a visible activity');
select throws_ok($$ insert into public.kudos (activity_id, user_id) values ('00000000000000000000ACTDR1', '22222222-2222-4222-8222-222222222222') $$,
  '42501', null, 'no kudos on an invisible activity');

update public.activities set visibility = 'private' where id = '00000000000000000000ACTTM1';

-- Agent context: an agent token acts only as its own agent.
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","agent_id":"b2222222-2222-4222-8222-222222222222","via":"install"}', true);
select throws_ok(
  $$ insert into public.activities (agent_id, owner_user_id, status, visibility)
     values ('b2222222-2222-4222-8222-000000000002', '22222222-2222-4222-8222-222222222222', 'open', 'private') $$,
  '42501', null, 'an agent cannot post as its owner''s other agent');
update public.activities set visibility = 'private' where id = '00000000000000000000ACTBB1';
select throws_ok($$ insert into public.kudos (activity_id, user_id) values ('00000000000000000000ACTPB1', '22222222-2222-4222-8222-222222222222') $$,
  '42501', null, 'agents cannot give kudos (human only)');

-- alice: the owner -------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","via":"web"}', true);
select is((select count(*)::int from public.activities where agent_id = 'a1111111-1111-4111-8111-111111111111'), 7,
  'the owner sees all of their activities in every status');
select throws_ok($$ update public.activities set visibility = 'public' where id = '00000000000000000000ACTTM1' $$,
  '42501', null, 'the owner cannot raise visibility to public directly');
select throws_ok($$ update public.activities set status = 'published' where id = '00000000000000000000ACTDR1' $$,
  '42501', null, 'the owner cannot publish a draft by update');
select lives_ok($$ update public.activities set status = 'archived' where id = '00000000000000000000ACTQR1' $$,
  'the owner can archive (unpost)');
select throws_ok($$ update public.activities set title = 'edited' where id = '00000000000000000000ACTTM1' $$,
  '42501', null, 'stats-card titles are not editable by API roles');

-- carol: another team ----------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated","via":"web"}', true);
select set_eq($$ select id::text from public.activities $$,
  array['00000000000000000000ACTPB1', '00000000000000000000ACTCB1'],
  'a user of another team sees only public content and their own');
select is_empty($$ select 1 from public.setup_versions where id = '00000000000000000000SETP02' $$,
  'setup versions behind drafts are invisible to others');

-- anon -------------------------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select set_eq($$ select id::text from public.activities $$, array['00000000000000000000ACTPB1'],
  'signed-out callers see only published, screened, public activities');
select is((select count(*)::int from api.feed_activities(null, null, 50, 'all')), 1, 'the anon feed is public-only');
select throws_ok($$ select * from public.sessions $$, '42501', null, 'anon cannot read sessions');

-- Effects checked as the owner role --------------------------------------------------------
reset role;
select results_eq(
  $$ select id::text, visibility::text from public.activities
     where id in ('00000000000000000000ACTTM1', '00000000000000000000ACTBB1') order by id $$,
  $$ values ('00000000000000000000ACTBB1'::text, 'team'::text), ('00000000000000000000ACTTM1', 'team') $$,
  'updates by non-owners and by agents (visibility is human-only) change nothing');
select is((select status from public.activities where id = '00000000000000000000ACTQR1'), 'archived',
  'the archive went through');

select * from finish();
rollback;
