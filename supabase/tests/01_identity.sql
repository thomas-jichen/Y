-- Identity: provisioning from auth.users, handles, companion rows, teams,
-- invites, profile visibility and channel secrets.
begin;
create extension if not exists pgtap with schema extensions;
select plan(30);

-- Fixtures (as the migration owner) ------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.test',
   '{"user_name": "Alice", "provider_id": "1001", "avatar_url": "https://avatars.example.test/a.png"}',
   '{"provider": "github", "providers": ["github"]}'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.test', '{"user_name": "bob"}', '{"provider": "github"}'),
  ('33333333-3333-4333-8333-333333333333', 'carol@example.test', '{"user_name": "carol"}', '{"provider": "github"}'),
  ('44444444-4444-4444-8444-444444444444', 'alias@example.test', '{"user_name": "alice", "provider_id": "1002"}',
   '{"provider": "github"}'),
  ('55555555-5555-4555-8555-555555555555', 'nologin@example.test', '{}', '{"provider": "email"}');

-- Provisioning ----------------------------------------------------------------------
select results_eq(
  $$ select handle::text, github_login::text, github_id from public.users where id = '11111111-1111-4111-8111-111111111111' $$,
  $$ values ('alice'::text, 'Alice'::text, 1001::bigint) $$,
  'auth.users insert creates public.users with the GitHub login as handle');
select is((select handle::text from public.users where id = '44444444-4444-4444-8444-444444444444'), 'alice-2',
  'a colliding handle gets a numeric suffix');
select matches((select handle::text from public.users where id = '55555555-5555-4555-8555-555555555555'),
  '^user-[0-9a-f]{8}$', 'without a GitHub login the handle is derived from the id, never the email');
select ok(exists (select 1 from public.user_private where user_id = '11111111-1111-4111-8111-111111111111')
          and exists (select 1 from public.notification_prefs where user_id = '11111111-1111-4111-8111-111111111111'),
  'users get user_private and notification_prefs rows');
select matches((select secret from public.realtime_channels
                where owner_kind = 'user' and owner_id = '11111111-1111-4111-8111-111111111111'),
  '^[a-f0-9]{64}$', 'users get a 64-hex Realtime channel secret');

insert into public.agents (id, owner_user_id, handle, harness) values
  ('a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'alice-claude', 'claude_code'),
  ('c3333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333333', 'carol-codex', 'codex');

select results_eq(
  $$ select s.remote_instructions, p.presence::text from public.agent_settings s
     join public.agent_presence p on p.agent_id = s.agent_id
     where s.agent_id = 'a1111111-1111-4111-8111-111111111111' $$,
  $$ values (false, 'away'::text) $$,
  'agents get settings (remote instructions off by default) and presence (away)');
select ok((select a.secret <> u.secret from public.realtime_channels a, public.realtime_channels u
           where a.owner_kind = 'agent' and a.owner_id = 'a1111111-1111-4111-8111-111111111111'
             and u.owner_kind = 'user' and u.owner_id = '11111111-1111-4111-8111-111111111111'),
  'agents get their own channel secret');

select throws_ok(
  $$ insert into public.agents (owner_user_id, handle, harness)
     values ('22222222-2222-4222-8222-222222222222', 'alice', 'codex') $$,
  '23505', null, 'an agent cannot take a user''s handle (one namespace)');
select throws_ok(
  $$ update public.users set handle = 'alice-claude' where id = '22222222-2222-4222-8222-222222222222' $$,
  '23505', null, 'a user cannot take an agent''s handle');

-- Agents and teams as authenticated users ---------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","via":"web"}', true);

select lives_ok(
  $$ insert into public.teams (slug, name, created_by) values ('team-a', 'Team A', '11111111-1111-4111-8111-111111111111') $$,
  'a human creates a team');
select results_eq(
  $$ select m.role::text, char_length(s.repo_key_salt) from public.team_members m
     join public.teams t on t.id = m.team_id join public.team_secrets s on s.team_id = t.id
     where t.slug = 'team-a' and m.user_id = '11111111-1111-4111-8111-111111111111' $$,
  $$ values ('owner'::text, 64) $$,
  'the creator becomes owner and the team gets a repo-key salt');
select throws_ok(
  $$ insert into public.teams (slug, name, created_by) values ('team-x', 'X', '22222222-2222-4222-8222-222222222222') $$,
  '42501', null, 'a team cannot be created on behalf of someone else');
select throws_ok(
  $$ insert into public.agents (owner_user_id, handle, harness) values ('22222222-2222-4222-8222-222222222222', 'bob-claude', 'claude_code') $$,
  '42501', null, 'an agent cannot be created for another user');
select lives_ok(
  $$ insert into public.agents (owner_user_id, handle, harness, variant)
     values ('11111111-1111-4111-8111-111111111111', 'alice-codex', 'codex', 1) $$,
  'a human creates their own agent');

-- Invites
select lives_ok(
  $$ insert into public.team_invites (team_id, token_hash, created_by, expires_at, max_uses)
     select id, repeat('e', 64), '11111111-1111-4111-8111-111111111111', now() + interval '1 day', 1
     from public.teams where slug = 'team-a' $$,
  'a team admin creates an invite');

-- Agent context cannot do human-only things.
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","agent_id":"a1111111-1111-4111-8111-111111111111","via":"install"}', true);
select throws_ok(
  $$ insert into public.teams (slug, name, created_by) values ('team-agent', 'Agent team', '11111111-1111-4111-8111-111111111111') $$,
  '42501', null, 'an agent cannot create a team');
select throws_ok(
  $$ insert into public.agents (owner_user_id, handle, harness, variant)
     values ('11111111-1111-4111-8111-111111111111', 'alice-extra', 'codex', 2) $$,
  '42501', null, 'an agent cannot mint agents');
select is((select count(*)::int from public.realtime_channels), 1,
  'an agent reads only its own channel secret');

-- Bob joins with the invite.
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","via":"web"}', true);
select is((select count(*)::int from public.teams), 0, 'a non-member sees no teams');
select isnt(api.accept_team_invite(repeat('e', 64)), null, 'a human accepts an invite');
select is((select count(*)::int from public.team_members where user_id = '22222222-2222-4222-8222-222222222222'), 1,
  'the invite adds a member');
select throws_ok($$ update public.team_members set role = 'owner' where user_id = '22222222-2222-4222-8222-222222222222' $$,
  '42501', null, 'a member cannot promote themselves');

-- Profiles ---------------------------------------------------------------------------
select ok(exists (select 1 from public.users where handle = 'alice'), 'teammates see each other''s profiles');
select set_config('request.jwt.claims',
  '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated","via":"web"}', true);
select is((select count(*)::int from public.users where id <> '33333333-3333-4333-8333-333333333333'), 0,
  'a stranger sees no other profiles');
select is((select count(*)::int from public.team_secrets), 0, 'a stranger reads no team salts');
select is((select count(*)::int from public.user_private), 1, 'user_private is readable only for oneself');
select is((select array_agg(owner_kind order by owner_kind) from public.realtime_channels), array['agent', 'user'],
  'a user reads only their own and their agents'' channel secrets');
select is((select count(*)::int from public.agents where owner_user_id = '11111111-1111-4111-8111-111111111111'), 0,
  'agents of invisible users are invisible');

reset role;
update public.users set public_profile = true where id = '11111111-1111-4111-8111-111111111111';
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is((select array_agg(handle::text order by handle) from public.users), array['alice'],
  'anon sees public profiles only');
select is((select count(*)::int from public.agents), 2, 'anon sees agents of public profiles');

reset role;
select * from finish();
rollback;
