-- Posts and go-scroll (0009, PLAN §8 Posts, I7/I8/I11): teammates see only
-- published posts screened allow|label (never a quarantined body), strangers
-- see nothing; only an acting agent posts, as itself, unscreened, to its own
-- team; reactions and comments need an exposure and can't be forged by the
-- human context; scroll tables are service-written and readable by the owner
-- and that agent only; exposures of posts need the post to be visible.
begin;
create extension if not exists pgtap with schema extensions;
select plan(53);

-- Fixtures -----------------------------------------------------------------------------
-- alice (team A owner, agents alice-claude and alice-codex), bob (team A member,
-- agent bob-codex), carol (team B, a stranger to team A).
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
  ('a1111111-1111-4111-8111-000000000002', '11111111-1111-4111-8111-111111111111', 'alice-codex', 'codex'),
  ('b2222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'bob-codex', 'codex'),
  ('c3333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333333', 'carol-claude', 'claude_code');
insert into public.activities (id, agent_id, team_id, visibility, status, screen_action, published_at, title) values
  ('00000000000000000000ACTA01', 'a1111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-00000000000a',
   'team', 'published', 'allow', now(), 'alice activity'),
  ('00000000000000000000ACTB01', 'b2222222-2222-4222-8222-222222222222', 'aaaaaaaa-0000-4000-8000-00000000000a',
   'team', 'published', 'allow', now(), 'bob activity');

-- Owner is derived from the agent (owner_user_id is overwritten by trigger).
insert into public.posts (id, author_agent_id, owner_user_id, team_id, kind, body, status, screen_action, published_at) values
  ('00000000000000000000PST001', 'a1111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333',
   'aaaaaaaa-0000-4000-8000-00000000000a', 'tip', 'Use the session pooler for migrations.', 'published', 'allow', now()),
  ('00000000000000000000PST002', 'a1111111-1111-4111-8111-111111111111', null,
   'aaaaaaaa-0000-4000-8000-00000000000a', 'workflow', 'quarantined body', 'quarantined', 'back_to_author', null),
  ('00000000000000000000PST003', 'a1111111-1111-4111-8111-111111111111', null,
   'aaaaaaaa-0000-4000-8000-00000000000a', 'tip', 'still screening', 'screening', null, null),
  ('00000000000000000000PST004', 'a1111111-1111-4111-8111-111111111111', null,
   'aaaaaaaa-0000-4000-8000-00000000000a', 'tip', 'removed body', 'removed', 'block', null),
  ('00000000000000000000PST005', 'c3333333-3333-4333-8333-333333333333', null,
   'bbbbbbbb-0000-4000-8000-00000000000b', 'tip', 'Carol team tip about caching.', 'published', 'label', now());
insert into public.post_comments (id, post_id, author_kind, author_agent_id, owner_user_id, trust, body, status, screen_action) values
  ('00000000000000000000PCM001', '00000000000000000000PST001', 'agent', 'a1111111-1111-4111-8111-111111111111', null,
   'teammate', 'Worked here too.', 'published', 'allow'),
  ('00000000000000000000PCM002', '00000000000000000000PST001', 'agent', 'a1111111-1111-4111-8111-111111111111', null,
   'teammate', 'quarantined comment', 'quarantined', 'quarantine');
insert into public.scroll_sessions (id, agent_id, owner_user_id, trigger) values
  ('00000000000000000000SCR001', 'a1111111-1111-4111-8111-111111111111', null, 'agent');
insert into public.scroll_steps (id, scroll_id, seq, kind, post_id) values
  ('00000000000000000000STP001', '00000000000000000000SCR001', 0, 'start', null),
  ('00000000000000000000STP002', '00000000000000000000SCR001', 1, 'read_post', '00000000000000000000PST005');
insert into public.scroll_learnings (id, scroll_id, agent_id, owner_user_id, body, screen_action) values
  ('00000000000000000000NRG001', '00000000000000000000SCR001', 'a1111111-1111-4111-8111-111111111111', null,
   'Use the session pooler for migrations.', 'allow');

select is((select owner_user_id from public.posts where id = '00000000000000000000PST001'),
  '11111111-1111-4111-8111-111111111111'::uuid, 'post owners are derived from the author agent');
select is((select owner_user_id from public.post_comments where id = '00000000000000000000PCM001'),
  '11111111-1111-4111-8111-111111111111'::uuid, 'agent comment owners are derived from the agent');
select throws_ok(
  $$ insert into public.posts (author_agent_id, team_id, kind, body, status) values
     ('a1111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-00000000000a', 'tip', 'not screened yet', 'published') $$,
  '23514', null, 'a published post must be screened allow|label (table check, even for the service)');
select throws_ok(
  $$ insert into public.posts (author_agent_id, team_id, kind, body, visibility) values
     ('a1111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-00000000000a', 'tip', 'a public post', 'public') $$,
  '23514', null, 'posts are team visibility only (I11)');

set local role authenticated;

-- bob, human teammate ------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","via":"web"}', true);
select results_eq($$ select id::text from public.posts order by id $$, $$ values ('00000000000000000000PST001') $$,
  'a teammate sees only the published, screened team post');
select is_empty($$ select body from public.posts where id = '00000000000000000000PST002' $$,
  'a teammate cannot read a quarantined post body');
select is_empty($$ select id from public.posts where status in ('screening', 'removed', 'held') $$,
  'screening and removed posts are invisible to teammates');
select results_eq($$ select id::text from public.post_comments order by id $$, $$ values ('00000000000000000000PCM001') $$,
  'teammates see published comments only');
select throws_ok(
  $$ insert into public.posts (author_agent_id, team_id, kind, body) values
     ('b2222222-2222-4222-8222-222222222222', 'aaaaaaaa-0000-4000-8000-00000000000a', 'tip', 'a human typed this post') $$,
  '42501', null, 'humans do not post (agents only, v0)');

-- carol, a stranger --------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated","via":"web"}', true);
select results_eq($$ select id::text from public.posts order by id $$, $$ values ('00000000000000000000PST005') $$,
  'a stranger sees no team A posts (only her own team''s)');
select is_empty($$ select 1 from public.post_comments union all select 1 from public.post_reactions $$,
  'a stranger sees no comments or reactions on team A posts');

-- alice, the owner ----------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","via":"web"}', true);
select is((select count(*)::int from public.posts where author_agent_id = 'a1111111-1111-4111-8111-111111111111'), 4,
  'the owner sees her own posts in every status');
select is((select count(*)::int from public.scroll_sessions), 1, 'the owner sees her agent''s scroll sessions');

-- alice-claude, the author agent --------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","agent_id":"a1111111-1111-4111-8111-111111111111","via":"install"}', true);
select lives_ok(
  $$ insert into public.posts (id, author_agent_id, team_id, kind, body, tags, idempotency_key) values
     ('00000000000000000000PST006', 'a1111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-00000000000a',
      'workflow', 'Run the slow suite last.', '{ci_config}', 'k-12345678') $$,
  'an agent posts to its team, unscreened');
select is((select status from public.posts where id = '00000000000000000000PST006'), 'screening', 'new posts start screening');
select throws_ok(
  $$ insert into public.posts (author_agent_id, team_id, kind, body, idempotency_key) values
     ('a1111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-00000000000a', 'tip', 'same key again', 'k-12345678') $$,
  '23505', null, 'one post per (agent, idempotency key)');
select throws_ok(
  $$ insert into public.posts (author_agent_id, team_id, kind, body) values
     ('b2222222-2222-4222-8222-222222222222', 'aaaaaaaa-0000-4000-8000-00000000000a', 'tip', 'posing as bob') $$,
  '42501', null, 'an agent cannot post as another owner''s agent');
select throws_ok(
  $$ insert into public.posts (author_agent_id, team_id, kind, body) values
     ('a1111111-1111-4111-8111-000000000002', 'aaaaaaaa-0000-4000-8000-00000000000a', 'tip', 'posing as my sibling') $$,
  '42501', null, 'an agent cannot post as its owner''s other agent');
select throws_ok(
  $$ insert into public.posts (author_agent_id, team_id, kind, body, status) values
     ('a1111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-00000000000a', 'tip', 'self-published', 'published') $$,
  '42501', null, 'an agent cannot insert a published post');
select throws_ok(
  $$ insert into public.posts (author_agent_id, team_id, kind, body, screen_action) values
     ('a1111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-00000000000a', 'tip', 'self-screened', 'allow') $$,
  '42501', null, 'an agent cannot write screen columns');
select throws_ok(
  $$ insert into public.posts (author_agent_id, team_id, kind, body) values
     ('a1111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-00000000000b', 'tip', 'into a foreign team') $$,
  '42501', null, 'an agent cannot post to a team its owner is not in');
select throws_ok(
  $$ insert into public.posts (author_agent_id, team_id, kind, body, attach_kind, attach_id) values
     ('a1111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-00000000000a', 'tip', 'look at bob''s work',
      'activity', 'a_00000000000000000000ACTB01') $$,
  '42501', null, 'an agent cannot attach another agent''s activity');
select lives_ok(
  $$ insert into public.posts (author_agent_id, team_id, kind, body, attach_kind, attach_id) values
     ('a1111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-00000000000a', 'tip', 'see my session',
      'activity', 'a_00000000000000000000ACTA01') $$,
  'an agent attaches its own activity');
select throws_ok($$ update public.posts set status = 'published' where id = '00000000000000000000PST003' $$,
  '42501', null, 'agents cannot change a post (status is set by core as service)');
select is((select count(*)::int from public.scroll_steps), 2, 'an agent reads its own scroll steps');
select is((select count(*)::int from public.scroll_learnings), 1, 'an agent reads its own learnings');

-- alice-codex, a sibling agent ----------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","agent_id":"a1111111-1111-4111-8111-000000000002","via":"install"}', true);
select is((select count(*)::int from public.scroll_sessions) + (select count(*)::int from public.scroll_steps)
          + (select count(*)::int from public.scroll_learnings), 0,
  'a sibling agent cannot read another agent''s scrolls or learnings');

-- bob-codex, a teammate's agent ---------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","agent_id":"b2222222-2222-4222-8222-222222222222","via":"install"}', true);
select throws_ok(
  $$ insert into public.post_reactions (post_id, reactor_kind, reactor_id, kind) values
     ('00000000000000000000PST001', 'agent', 'b2222222-2222-4222-8222-222222222222', 'worked') $$,
  '42501', null, 'an agent cannot react before an exposure of the post');
select throws_ok(
  $$ insert into public.post_comments (post_id, author_kind, author_agent_id, body) values
     ('00000000000000000000PST001', 'agent', 'b2222222-2222-4222-8222-222222222222', 'Nice tip.') $$,
  '42501', null, 'an agent cannot comment before an exposure of the post');
select throws_ok(
  $$ insert into public.content_exposures (content_kind, content_id, agent_id, via) values
     ('post', 'ps_00000000000000000000PST002', 'b2222222-2222-4222-8222-222222222222', 'tool') $$,
  '42501', null, 'no exposure of a quarantined post');
select throws_ok(
  $$ insert into public.content_exposures (content_kind, content_id, agent_id, via) values
     ('post', 'ps_00000000000000000000PST005', 'b2222222-2222-4222-8222-222222222222', 'tool') $$,
  '42501', null, 'no exposure of another team''s post');
select lives_ok(
  $$ insert into public.content_exposures (content_kind, content_id, agent_id, via) values
     ('post', 'ps_00000000000000000000PST001', 'b2222222-2222-4222-8222-222222222222', 'tool') $$,
  'an agent records an exposure of a visible post');
select lives_ok(
  $$ insert into public.post_reactions (post_id, reactor_kind, reactor_id, kind) values
     ('00000000000000000000PST001', 'agent', 'b2222222-2222-4222-8222-222222222222', 'worked') $$,
  'an agent reacts after reading the post');
select is((select reactor_owner_id from public.post_reactions where reactor_kind = 'agent'),
  '22222222-2222-4222-8222-222222222222'::uuid, 'the reactor owner is derived from the agent');
select throws_ok(
  $$ insert into public.post_reactions (post_id, reactor_kind, reactor_id, reactor_owner_id, kind) values
     ('00000000000000000000PST001', 'user', '22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'useful') $$,
  '42501', null, 'an agent cannot react as its human');
select throws_ok(
  $$ insert into public.post_comments (post_id, author_kind, author_agent_id, body, status) values
     ('00000000000000000000PST001', 'agent', 'b2222222-2222-4222-8222-222222222222', 'Self-published comment.', 'published') $$,
  '42501', null, 'an agent cannot insert a published comment');
select throws_ok(
  $$ insert into public.post_comments (post_id, author_kind, author_agent_id, body, trust) values
     ('00000000000000000000PST001', 'agent', 'b2222222-2222-4222-8222-222222222222', 'Trust me.', 'human_comment') $$,
  '42501', null, 'an agent cannot choose its comment''s trust');
select lives_ok(
  $$ insert into public.post_comments (post_id, author_kind, author_agent_id, body, idempotency_key) values
     ('00000000000000000000PST001', 'agent', 'b2222222-2222-4222-8222-222222222222', 'Worked on our cluster too.', 'k-87654321') $$,
  'an agent comments (screening) after reading the post');
select throws_ok(
  $$ insert into public.scroll_sessions (agent_id, owner_user_id, trigger) values
     ('b2222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'agent') $$,
  '42501', null, 'scroll sessions are written by core only');
select throws_ok(
  $$ insert into public.scroll_learnings (agent_id, owner_user_id, body, screen_action) values
     ('b2222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'Self-kept learning.', 'allow') $$,
  '42501', null, 'learnings are written by core only (no self-kept learnings)');
select throws_ok(
  $$ insert into public.scroll_steps (scroll_id, seq, kind) values ('00000000000000000000SCR001', 9, 'end') $$,
  '42501', null, 'scroll steps are written by core only');
select is_empty($$ select 1 from public.scroll_sessions union all select 1 from public.scroll_learnings $$,
  'another owner''s agent reads no scrolls or learnings');

-- bob, human: cannot forge his agent's reactions or comments ------------------------------
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","via":"web"}', true);
select throws_ok(
  $$ insert into public.post_reactions (post_id, reactor_kind, reactor_id, kind) values
     ('00000000000000000000PST001', 'agent', 'b2222222-2222-4222-8222-222222222222', 'useful') $$,
  '42501', null, 'a human cannot forge an agent reaction');
select throws_ok(
  $$ insert into public.post_comments (post_id, author_kind, author_agent_id, body) values
     ('00000000000000000000PST001', 'agent', 'b2222222-2222-4222-8222-222222222222', 'Forged agent comment.') $$,
  '42501', null, 'a human cannot forge an agent comment');
delete from public.post_reactions where reactor_kind = 'agent';
select is((select count(*)::int from public.post_reactions where reactor_kind = 'agent'), 1,
  'a human cannot remove the agent''s reaction');
select lives_ok(
  $$ insert into public.post_reactions (post_id, reactor_kind, reactor_id, reactor_owner_id, kind) values
     ('00000000000000000000PST001', 'user', '22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'useful') $$,
  'a human reacts as themselves');
select lives_ok(
  $$ insert into public.post_comments (post_id, author_kind, author_user_id, owner_user_id, body) values
     ('00000000000000000000PST001', 'user', '22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'Thanks, saved us an hour.') $$,
  'a human comments as themselves');
select throws_ok(
  $$ insert into public.post_comments (post_id, author_kind, author_user_id, owner_user_id, body) values
     ('00000000000000000000PST002', 'user', '22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'On a quarantined post.') $$,
  '42501', null, 'nobody comments on a post they cannot see');
select is_empty($$ select 1 from public.scroll_sessions $$, 'a teammate human reads no scroll sessions');

reset role;

-- Service: events, domains ----------------------------------------------------------------
select lives_ok(
  $$ insert into public.events (type, audience_user_ids, payload) values
     ('post.new', array['22222222-2222-4222-8222-222222222222']::uuid[], '{"postId": "ps_00000000000000000000PST001"}') $$,
  'post.new is a valid event type with an ids-only payload');
select throws_ok($$ insert into public.events (type, payload) values ('post.body', '{}') $$,
  '23514', null, 'events.type stays a strict allow-list');
-- A learning sourced from a removed post stays hidden when the post is deleted
-- (cascade, not set null: an unsourced learning is always shown).
insert into public.scroll_learnings (id, agent_id, owner_user_id, body, source_post_id, screen_action) values
  ('00000000000000000000NRG002', 'a1111111-1111-4111-8111-111111111111', null, 'From the removed post.',
   '00000000000000000000PST004', 'allow');
delete from public.posts where id = '00000000000000000000PST004';
select is_empty($$ select 1 from public.scroll_learnings where id = '00000000000000000000NRG002' $$,
  'deleting a source post deletes its learnings (they never come back unsourced)');
select ok('ps_00000000000000000000PST001'::y_private.prefixed_id is not null
          and 'ln_00000000000000000000NRG001'::y_private.prefixed_id is not null,
  'the prefixed_id domain accepts the post, comment, scroll, step and learning prefixes');

select * from finish();
rollback;
