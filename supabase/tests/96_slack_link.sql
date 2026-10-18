-- `/paceline connect` (PLAN §11 Linking): a single-use link token is
-- completed only from a signed-in web session; it links the Slack user,
-- copies the workspace name for the settings page (SlackLink.workspaceName)
-- and cannot be reused, used after expiry, or completed by an agent.
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.test', '{"user_name": "alice"}'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.test', '{"user_name": "bob"}');
insert into public.agents (id, owner_user_id, handle, harness) values
  ('a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'alice-claude', 'claude_code');
insert into public.slack_installations (slack_team_id, team_name) values ('T0ACME01', 'Acme Inc');
insert into public.slack_link_tokens (token_hash, slack_team_id, slack_user_id, expires_at) values
  (repeat('a', 64), 'T0ACME01', 'U0ALICE1', now() + interval '10 minutes'),
  (repeat('b', 64), 'T0ACME01', 'U0BOB001', now() - interval '1 minute');

set local role authenticated;

select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","agent_id":"a1111111-1111-4111-8111-111111111111","via":"install"}', true);
select throws_ok($$ select * from api.complete_slack_link(repeat('a', 64)) $$, '42501', null,
  'an agent cannot link a Slack identity');
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","via":"slack"}', true);
select throws_ok($$ select * from api.complete_slack_link(repeat('a', 64)) $$, '42501', null,
  'linking needs a web session, not a Slack action');

select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","via":"web"}', true);
select results_eq($$ select slack_team_id, slack_user_id from api.complete_slack_link(repeat('a', 64)) $$,
  $$ values ('T0ACME01'::text, 'U0ALICE1'::text) $$, 'a web session completes the link');
select results_eq($$ select slack_user_id, slack_team_name from public.slack_identity_links $$,
  $$ values ('U0ALICE1'::text, 'Acme Inc'::text) $$,
  'the user reads their link, with the workspace name copied from the installation');
select throws_ok($$ select * from api.complete_slack_link(repeat('a', 64)) $$, 'P0002', null, 'link tokens are single-use');
select throws_ok($$ select * from api.complete_slack_link(repeat('b', 64)) $$, 'P0002', null, 'expired link tokens are refused');
select throws_ok($$ select * from public.slack_installations $$, '42501', null,
  'the installations table (bot token secret names) stays service-only');

select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","via":"web"}', true);
select is_empty($$ select 1 from public.slack_identity_links $$, 'other users cannot see the link');

select * from finish();
rollback;
