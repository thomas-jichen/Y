-- api.take_token: Postgres token buckets (PLAN §10 rate limits).
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.test', '{"user_name": "alice"}');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","agent_id":"a1111111-1111-4111-8111-111111111111","via":"install"}', true);

-- burst 3, refill 1 token per second.
select results_eq($$ select allowed, remaining, retry_after_s from api.take_token('test:a', 1, 1, 3) $$,
  $$ values (true, 2::double precision, 0) $$, 'a new bucket starts full and takes one token');
select results_eq($$ select allowed, remaining from api.take_token('test:a', 1, 1, 3) $$,
  $$ values (true, 1::double precision) $$, 'second token');
select results_eq($$ select allowed, remaining from api.take_token('test:a', 1, 1, 3) $$,
  $$ values (true, 0::double precision) $$, 'third token empties the bucket');
select results_eq($$ select allowed, remaining, retry_after_s from api.take_token('test:a', 1, 1, 3) $$,
  $$ values (false, 0::double precision, 1) $$, 'an empty bucket refuses with retry_after_s');
select results_eq($$ select allowed from api.take_token('test:b', 1, 1, 3) $$,
  $$ values (true) $$, 'buckets are independent per key');
select results_eq($$ select allowed, retry_after_s from api.take_token('test:big', 5, 1, 3) $$,
  $$ values (false, null::int) $$, 'a cost above the burst can never be served');
select is((select count(*)::int from generate_series(1, 61) g, lateral api.take_token('mcp:agent:x' || left(g::text, 0), 1, 1, 60) t where t.allowed),
  60, 'MCP limit 60/min: 60 calls pass, the 61st is limited');
select results_eq($$ select allowed, retry_after_s from api.take_token('send_message:agent:x', 1, 30.0 / 3600, 30) $$,
  $$ values (true, 0) $$, 'send_message 30/h maps to rate 30/3600 and burst 30');
select throws_ok($$ select * from api.take_token('test:a', 0, 1, 3) $$, '22023', null, 'cost must be positive');
select throws_ok($$ select * from api.take_token('', 1, 1, 3) $$, '22023', null, 'keys must be non-empty');
select throws_ok($$ select * from public.rate_buckets $$, '42501', null,
  'callers use take_token but cannot read the buckets');

-- Refill: pretend the last take was 2 seconds ago.
reset role;
update public.rate_buckets set updated_at = now() - interval '2 seconds' where key = 'test:a';
set local role authenticated;
select results_eq($$ select allowed, remaining from api.take_token('test:a', 1, 1, 3) $$,
  $$ values (true, 1::double precision) $$, 'tokens refill continuously (2 s x 1/s, minus one)');
reset role;
update public.rate_buckets set updated_at = now() - interval '1 hour' where key = 'test:a';
set local role authenticated;
select results_eq($$ select remaining from api.take_token('test:a', 1, 1, 3) $$,
  $$ values (2::double precision) $$, 'refill is capped at the burst');

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select * from api.take_token('test:anon', 1, 1, 3) $$, '42501', null, 'anon cannot call take_token');

reset role;
select * from finish();
rollback;
