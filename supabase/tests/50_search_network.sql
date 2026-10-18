-- api.search_network and api.match_error_signature: RRF over vector, FTS and
-- trigram lists that respects RLS (security invoker) and only ever returns
-- active, allow|label highlights; highlight and component isolation.
begin;
create extension if not exists pgtap with schema extensions;
select plan(29);

-- A unit-ish 384-dim vector pointing mostly along dimension k.
create function pg_temp.vec(k int) returns vector
language sql immutable
as $$ select (select array_agg(case when i = k then 1.0 else 0.001 end order by i) from generate_series(1, 384) i)::real[]::vector $$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.test', '{"user_name": "alice"}'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.test', '{"user_name": "bob"}'),
  ('33333333-3333-4333-8333-333333333333', 'carol@example.test', '{"user_name": "carol"}');
insert into public.teams (id, slug, name, created_by) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'team-a', 'Team A', '11111111-1111-4111-8111-111111111111'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'team-b', 'Team B', '33333333-3333-4333-8333-333333333333');
insert into public.team_members (team_id, user_id) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', '22222222-2222-4222-8222-222222222222');
insert into public.agents (id, owner_user_id, handle, harness) values
  ('a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'alice-claude', 'claude_code'),
  ('b2222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'bob-codex', 'codex'),
  ('c3333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333333', 'carol-claude', 'claude_code');

insert into public.highlights (id, author_agent_id, owner_user_id, team_id, kind, title, summary, body, tags,
                               status, visibility, screen_action, embedding) values
  ('00000000000000000000HGH001', 'a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111',
   'aaaaaaaa-0000-4000-8000-00000000000a', 'gotcha', 'Run quarry migrations with QUARRY_DIRECT=1',
   'The pooled URL hangs during quarry migrate', '{"problem": "quarry migrate hangs on the pooler"}', '{quarry}',
   'active', 'team', 'allow', pg_temp.vec(1)),
  ('00000000000000000000HGH002', 'a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111',
   null, 'fix', 'Vitest worker segfault: use pool forks', 'Threads crash with native addons', '{}', '{vitest@3}',
   'active', 'public', 'label', pg_temp.vec(2)),
  ('00000000000000000000HGH003', 'a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111',
   'aaaaaaaa-0000-4000-8000-00000000000a', 'gotcha', 'Quarry migrations draft', 'draft about quarry migrate', '{}', '{}',
   'draft', 'team', 'allow', pg_temp.vec(1)),
  ('00000000000000000000HGH004', 'a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111',
   'aaaaaaaa-0000-4000-8000-00000000000a', 'gotcha', 'Quarry migrations quarantined', 'quarry migrate', '{}', '{}',
   'active', 'team', 'quarantine', pg_temp.vec(1)),
  ('00000000000000000000HGH005', 'a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111',
   null, 'gotcha', 'Quarry migrations unscreened', 'quarry migrate', '{}', '{}',
   'active', 'public', null, pg_temp.vec(1)),
  ('00000000000000000000HGH006', 'c3333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333333',
   'bbbbbbbb-0000-4000-8000-00000000000b', 'gotcha', 'Quarry migrations in team B', 'quarry migrate', '{}', '{}',
   'active', 'team', 'allow', pg_temp.vec(1)),
  ('00000000000000000000HGH007', 'a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111',
   null, 'gotcha', 'Quarry migrations blocked', 'quarry migrate', '{}', '{}',
   'active', 'public', 'block', pg_temp.vec(1));
insert into public.highlight_errors (highlight_id, sig) values
  ('00000000000000000000HGH001', 'quarry migrate ETIMEDOUT 30s'),
  ('00000000000000000000HGH002', 'vitest worker segfault SIGSEGV'),
  ('00000000000000000000HGH003', 'quarry migrate ETIMEDOUT 30s'),
  ('00000000000000000000HGH004', 'quarry migrate ETIMEDOUT 30s'),
  ('00000000000000000000HGH006', 'quarry migrate ETIMEDOUT 30s'),
  ('00000000000000000000HGH007', 'quarry migrate ETIMEDOUT 30s');

insert into public.shared_components (id, author_agent_id, owner_user_id, team_id, kind, name, content, content_hash,
                                      status, visibility, screen_action) values
  ('00000000000000000000CMP001', 'a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111',
   'aaaaaaaa-0000-4000-8000-00000000000a', 'skill', 'quarry-helper', '# skill', repeat('1', 64), 'active', 'team', 'allow'),
  ('00000000000000000000CMP002', 'a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111',
   null, 'skill', 'vitest-fixer', '# skill', repeat('2', 64), 'active', 'public', 'allow'),
  ('00000000000000000000CMP003', 'a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111',
   null, 'skill', 'evil-skill', '# skill', repeat('3', 64), 'blocked', 'public', 'block');

set local role authenticated;

-- bob: teammate of alice ------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","via":"web"}', true);
select set_eq(
  $$ select highlight_id from api.search_network('quarry migrations', pg_temp.vec(1), 'quarry migrate ETIMEDOUT 30s', 8) $$,
  array['00000000000000000000HGH001', '00000000000000000000HGH002'],
  'search returns only active, screened (allow|label) highlights the caller may read');
select results_eq(
  $$ select highlight_id, vector_rank, fts_rank, trigram_rank
     from api.search_network('quarry migrations', pg_temp.vec(1), 'quarry migrate ETIMEDOUT 30s', 1) $$,
  $$ values ('00000000000000000000HGH001'::text, 1, 1, 1) $$,
  'the best match ranks first in all three lists');
select ok(abs((select rrf_score from api.search_network('quarry migrations', pg_temp.vec(1), 'quarry migrate ETIMEDOUT 30s', 1))
              - 3.0 / 61) < 1e-9,
  'RRF score is the sum of 1/(60 + rank) (k = 60)');
select ok((select vector_distance < 0.01 from api.search_network(null, pg_temp.vec(1), null, 1)),
  'vector_distance is the cosine distance');
select is((select array_agg(highlight_id) from api.search_network('quarry migrations', pg_temp.vec(1), null, 8, 'public')),
  array['00000000000000000000HGH002'], 'scope public returns public highlights only');
select is((select array_agg(highlight_id) from api.search_network('quarry migrations', pg_temp.vec(1), null, 8, 'team')),
  array['00000000000000000000HGH001'], 'scope team excludes public highlights');
select is((select count(*)::int from api.search_network('quarry', pg_temp.vec(1), null, 1)), 1, 'k limits the results');
select is((select array_agg(highlight_id) from api.search_network('quarry migrations', null, null, 8)),
  array['00000000000000000000HGH001'], 'FTS alone works when there is no query vector');
select results_eq(
  $$ select highlight_id, trigram_rank, vector_rank, fts_rank from api.search_network(null, null, 'vitest worker segfault', 8) $$,
  $$ values ('00000000000000000000HGH002'::text, 1, null::int, null::int) $$,
  'error-signature (trigram) search alone finds the highlight');
select is_empty($$ select * from api.search_network(null, null, null, 8) $$, 'an empty query returns nothing');
select results_eq(
  $$ select highlight_id from api.match_error_signature('quarry migrate ETIMEDOUT 30s', 3) $$,
  $$ values ('00000000000000000000HGH001'::text) $$,
  'hook/match finds the visible allow highlight');
select is_empty($$ select * from api.match_error_signature('vitest worker segfault SIGSEGV', 3) $$,
  'labelled highlights are never pushed (match_error_signature is allow-only)');
select ok((select similarity >= 0.6 from api.match_error_signature('quarry migrate ETIMEDOUT 30s', 1)),
  'an identical signature scores above the 0.6 push threshold');
select set_eq($$ select id::text from public.highlights $$,
  array['00000000000000000000HGH001', '00000000000000000000HGH002'],
  'teammates see active screened team and public highlights only');
select set_eq($$ select highlight_id::text from public.highlight_errors $$,
  array['00000000000000000000HGH001', '00000000000000000000HGH002'],
  'error signatures follow their highlight''s visibility');
select set_eq($$ select id::text from public.shared_components $$,
  array['00000000000000000000CMP001', '00000000000000000000CMP002'],
  'shared components: team ones for the team, public ones for all, blocked for nobody');
select throws_ok(
  $$ insert into public.highlights (author_agent_id, owner_user_id, kind, title, status, visibility)
     values ('b2222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'fix', 'mine', 'active', 'public') $$,
  '42501', null, 'highlights are written by the worker only');

-- bob's agent shares a skill: it starts in screening.
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","agent_id":"b2222222-2222-4222-8222-222222222222","via":"install"}', true);
select lives_ok(
  $$ insert into public.shared_components (author_agent_id, owner_user_id, team_id, kind, name, content, content_hash, visibility)
     values ('b2222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222',
             'aaaaaaaa-0000-4000-8000-00000000000a', 'skill', 'bob-skill', '# hi', repeat('4', 64), 'team') $$,
  'sharing a component creates it in screening');
select lives_ok(
  $$ insert into public.content_exposures (content_kind, content_id, agent_id, via)
     values ('highlight', 'h_00000000000000000000HGH001', 'b2222222-2222-4222-8222-222222222222', 'tool') $$,
  'get_item records an exposure for content the agent can see');
select throws_ok(
  $$ insert into public.content_exposures (content_kind, content_id, agent_id, via)
     values ('highlight', 'h_00000000000000000000HGH006', 'b2222222-2222-4222-8222-222222222222', 'tool') $$,
  '42501', null, 'exposures cannot be forged for content the agent cannot see');
select throws_ok(
  $$ insert into public.shared_components (author_agent_id, owner_user_id, kind, name, content, content_hash, visibility, status)
     values ('b2222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'skill', 'bob-skill-2', '# hi',
             repeat('5', 64), 'public', 'active') $$,
  '42501', null, 'a component cannot be shared publicly or pre-activated');

-- carol: another team ---------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated","via":"web"}', true);
select set_eq(
  $$ select highlight_id from api.search_network('quarry migrations', pg_temp.vec(1), 'quarry migrate ETIMEDOUT 30s', 8) $$,
  array['00000000000000000000HGH006', '00000000000000000000HGH002'],
  'another team''s search sees its own team content plus public, never team A''s');
select is_empty($$ select 1 from public.highlight_errors where highlight_id = '00000000000000000000HGH001' $$,
  'another team cannot read team A''s error signatures');

-- anon -------------------------------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select set_eq(
  $$ select highlight_id from api.search_network('quarry migrations', pg_temp.vec(1), 'quarry migrate ETIMEDOUT 30s', 8) $$,
  array['00000000000000000000HGH002'],
  'signed-out search sees public, screened highlights only (unscreened and blocked excluded)');
select set_eq($$ select id::text from public.shared_components $$, array['00000000000000000000CMP002'],
  'anon sees only active public components');
select throws_ok($$ select * from api.match_error_signature('quarry', 1) $$, '42501', null,
  'hook/match is not available signed out');

-- alice: owner ----------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","via":"web"}', true);
select is((select count(*)::int from public.highlights), 6, 'the owner sees all of their highlights');
select throws_ok($$ update public.highlights set visibility = 'public' where id = '00000000000000000000HGH001' $$,
  '42501', null, 'the owner cannot make a highlight public by update');
select lives_ok($$ update public.highlights set status = 'archived' where id = '00000000000000000000HGH001' $$,
  'the owner can archive a highlight');

reset role;
select * from finish();
rollback;
