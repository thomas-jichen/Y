-- Review items (I5, I11): readable only by their owner, listable by the
-- owner's agents, decided only by a human through api.decide_review, which
-- is a compare-and-set (a second decision returns no row). Change requests
-- create their review item; review and change events are emitted.
begin;
create extension if not exists pgtap with schema extensions;
select plan(28);

insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.test', '{"user_name": "alice"}'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.test', '{"user_name": "bob"}');
insert into public.agents (id, owner_user_id, handle, harness) values
  ('a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'alice-claude', 'claude_code');
insert into public.review_items (id, owner_user_id, kind, ref_id, summary, expires_at) values
  ('00000000000000000000RVW001', '11111111-1111-4111-8111-111111111111', 'draft', 'a_00000000000000000000ACT001', 'Draft ready', null),
  ('00000000000000000000RVW002', '11111111-1111-4111-8111-111111111111', 'dm_request', 'm_00000000000000000000MSG001', 'DM request', null),
  ('00000000000000000000RVW003', '22222222-2222-4222-8222-222222222222', 'draft', 'a_00000000000000000000ACT002', 'Draft ready', null),
  ('00000000000000000000RVW004', '11111111-1111-4111-8111-111111111111', 'draft', 'a_00000000000000000000ACT003', 'Old', now() - interval '1 minute');
insert into public.setup_suggestions (id, kind, patch, patch_hash, status, scope) values
  ('00000000000000000000SGG001', 'add_skill', '{"v": 1, "target": "user", "ops": []}', repeat('9', 64), 'ready', 'public-aggregate'),
  ('00000000000000000000SGG002', 'add_skill', '{"v": 1, "target": "user", "ops": []}', repeat('8', 64), 'pending', 'public-aggregate');

select is((select count(*)::int from public.events where type = 'review.new'
           and payload ->> 'reviewId' = 'rv_00000000000000000000RVW001'
           and audience_user_ids = array['11111111-1111-4111-8111-111111111111']::uuid[]), 1,
  'a new review item emits review.new to its owner (prefixed id)');

set local role authenticated;

-- alice's agent: can list, cannot decide.
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","agent_id":"a1111111-1111-4111-8111-111111111111","via":"install"}', true);
select set_eq($$ select id::text from public.review_items $$,
  array['00000000000000000000RVW001', '00000000000000000000RVW002', '00000000000000000000RVW004'],
  'the owner''s agent can list review items (review_queue)');
select throws_ok($$ select * from api.decide_review('00000000000000000000RVW001', 'approved', 'decision-0001', 'web') $$,
  '42501', null, 'an agent cannot decide a review item');
update public.review_items set state = 'approved', decision_id = 'decision-0009', decided_by = '11111111-1111-4111-8111-111111111111',
  decided_via = 'web', decided_at = now() where id = '00000000000000000000RVW001';
select is((select state from public.review_items where id = '00000000000000000000RVW001'), 'pending',
  'an agent cannot update a review item directly');

-- Change requests from the agent.
select lives_ok(
  $$ insert into public.change_requests (id, agent_id, owner_user_id, suggestion_id, target, patch, patch_hash)
     values ('00000000000000000000CRQ001', 'a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111',
             '00000000000000000000SGG001', 'user', '{"v": 1, "target": "user", "ops": []}', repeat('9', 64)) $$,
  'propose_setup_change creates a pending change request from a ready suggestion');
select throws_ok(
  $$ insert into public.change_requests (agent_id, owner_user_id, suggestion_id, target, patch, patch_hash)
     values ('a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111',
             '00000000000000000000SGG002', 'user', '{"v": 1, "target": "user", "ops": []}', repeat('8', 64)) $$,
  '42501', null, 'change requests need a ready suggestion the caller can see (no agent-authored patches)');
select throws_ok(
  $$ insert into public.change_requests (agent_id, owner_user_id, suggestion_id, target, patch, patch_hash)
     values ('a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111',
             '00000000000000000000SGG001', 'local', '{"v": 1, "target": "user", "ops": []}', repeat('9', 64)) $$,
  '23514', null, 'the patch''s target must match the change request''s target');
select throws_ok(
  $$ insert into public.change_requests (agent_id, owner_user_id, suggestion_id, target, patch, patch_hash, state)
     values ('a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', '00000000000000000000SGG001',
             'user', '{"v": 1, "target": "user", "ops": []}', repeat('9', 64), 'approved') $$,
  '42501', null, 'a change request cannot be created approved');
select throws_ok(
  $$ insert into public.change_requests (agent_id, owner_user_id, suggestion_id, target, patch, patch_hash, kid, signature)
     values ('a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', '00000000000000000000SGG001',
             'user', '{"v": 1, "target": "user", "ops": []}', repeat('9', 64), 'k1', repeat('A', 86)) $$,
  '42501', null, 'a change request cannot carry a signature from the caller');
select results_eq(
  $$ select kind, ref_id::text, state from public.review_items where ref_id = 'cr_00000000000000000000CRQ001' $$,
  $$ values ('change_request'::text, 'cr_00000000000000000000CRQ001'::text, 'pending'::text) $$,
  'every change request gets a pending review item for the human');
update public.change_requests set state = 'applied', applied_at = now() where id = '00000000000000000000CRQ001';
select is((select state from public.change_requests where id = '00000000000000000000CRQ001'), 'pending_approval',
  'the applier cannot report on an unapproved change');

-- alice on the web: decide.
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","via":"web"}', true);
select results_eq(
  $$ select id::text, state, decision, decided_via, decided_by from api.decide_review('00000000000000000000RVW001', 'approved', 'decision-0001', 'web') $$,
  $$ values ('00000000000000000000RVW001'::text, 'approved'::text, 'approve'::text, 'web'::text, '11111111-1111-4111-8111-111111111111'::uuid) $$,
  'a human decision returns the updated row');
select is_empty($$ select * from api.decide_review('00000000000000000000RVW001', 'rejected', 'decision-0002', 'web') $$,
  'a second decision returns no row (compare-and-set)');
select is_empty($$ select * from api.decide_review('00000000000000000000RVW001', 'approved', 'decision-0001', 'web') $$,
  'retrying the same decision returns no row; the item keeps the first decision');
select results_eq(
  $$ select state, decision, decision_id from public.review_items where id = '00000000000000000000RVW001' $$,
  $$ values ('approved'::text, 'approve'::text, 'decision-0001'::text) $$,
  'the first decision stands');
select throws_ok($$ select * from api.decide_review('00000000000000000000RVW002', 'approved', 'decision-0003', 'slack') $$,
  '42501', null, 'via must match the request context');
select throws_ok($$ select * from api.decide_review('00000000000000000000RVW002', 'expired', 'decision-0003', 'web') $$,
  '22023', null, 'only approved or rejected are decisions');
select is_empty($$ select * from api.decide_review('00000000000000000000RVW004', 'approved', 'decision-0004', 'web') $$,
  'expired items cannot be decided');
select is_empty($$ select * from api.decide_review('00000000000000000000RVW003', 'approved', 'decision-0005', 'web') $$,
  'another user''s item cannot be decided (no row)');
select throws_ok($$ update public.review_items set state = 'approved' where id = '00000000000000000000RVW002' $$,
  '42501', null, 'a direct update must carry the full decision (decided_by, decision_id, via)');
select throws_ok(
  $$ select * from api.decide_review(
       (select id from public.review_items where ref_id = 'cr_00000000000000000000CRQ001'), 'approved', 'decision-0001', 'web') $$,
  '23505', null, 'a decision id cannot be reused for another item');
select set_eq($$ select id::text from public.review_items where kind <> 'change_request' $$,
  array['00000000000000000000RVW001', '00000000000000000000RVW002', '00000000000000000000RVW004'],
  'review items are visible to their owner only');

-- From Slack (linked user + button).
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","via":"slack"}', true);
select is((select state from api.decide_review('00000000000000000000RVW002', 'rejected', 'slack-action-0001', 'slack')), 'rejected',
  'a linked Slack user decides with a button');

-- The worker approves and signs the change; the applier reports.
reset role;
update public.change_requests set state = 'approved', kid = 'k1', signature = repeat('A', 86),
  approved_by = '11111111-1111-4111-8111-111111111111', approved_at = now()
  where id = '00000000000000000000CRQ001';
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","agent_id":"a1111111-1111-4111-8111-111111111111","via":"install"}', true);
select lives_ok($$ update public.change_requests set state = 'applied', applied_at = now(), post_hashes = '{"f": "x"}'
                  where id = '00000000000000000000CRQ001' $$,
  'the applier reports an approved change as applied');
select throws_ok($$ update public.change_requests set state = 'approved' where id = '00000000000000000000CRQ001' $$,
  '42501', null, 'the applier cannot move a change back to approved');

reset role;
select is((select count(*)::int from public.events where type = 'review.decided'), 2,
  'each decision emits review.decided');
select is((select array_agg(payload ->> 'state' order by id) from public.events where type = 'change.updated'),
  array['approved', 'applied'], 'change request state changes emit change.updated with ids and state only');
select ok((select bool_and(paceline_private.event_payload_ok(payload)) from public.events),
  'every emitted payload is ids/counts only');

select * from finish();
rollback;
