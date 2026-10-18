-- api.claim_jobs / complete_job / fail_job: due-job selection, leases,
-- lease reclaim, dead-lettering, fencing tokens and SKIP LOCKED.
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

insert into public.jobs (id, topic, payload, state, attempts, max_attempts, run_after, locked_until) values
  (101, 'distill.stage_a', '{}', 'queued', 0, 5, now() - interval '1 minute', null),
  (102, 'distill.stage_a', '{}', 'queued', 0, 5, now() + interval '1 hour', null),
  (103, 'embed', '{}', 'queued', 0, 5, now() - interval '1 minute', null),
  (104, 'distill.stage_a', '{}', 'running', 1, 5, now() - interval '2 minutes', now() - interval '1 second'),
  (105, 'distill.stage_a', '{}', 'running', 1, 5, now() - interval '2 minutes', now() + interval '5 minutes'),
  (106, 'distill.stage_a', '{}', 'running', 5, 5, now() - interval '2 minutes', now() - interval '1 second'),
  (107, 'embed', '{}', 'queued', 0, 5, now() - interval '2 minutes', null);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select set_eq($$ select id from api.claim_jobs(array['distill.stage_a'], 10, interval '30 seconds') $$,
  array[101::bigint, 104],
  'claims due queued jobs and running jobs whose lease expired; skips future, other topics and live leases');
select results_eq(
  $$ select id, state, attempts, locked_until = now() + interval '30 seconds' from public.jobs where id in (101, 104) order by id $$,
  $$ values (101::bigint, 'running'::text, 1, true), (104::bigint, 'running', 2, true) $$,
  'claimed jobs are running with a fresh lease and one more attempt');
select results_eq($$ select state, last_error from public.jobs where id = 106 $$,
  $$ values ('dead'::text, 'lease expired on the last attempt'::text) $$,
  'an expired lease on the last attempt dead-letters the job');
select is_empty($$ select * from api.claim_jobs(array['distill.stage_a'], 10, interval '30 seconds') $$,
  'a second claim gets nothing while leases are live');
select results_eq($$ select id from api.claim_jobs(array['embed'], 1, interval '30 seconds') $$,
  $$ values (107::bigint) $$, 'n limits the claim; the oldest run_after goes first');
select results_eq($$ select id from api.claim_jobs(array['embed', 'distill.stage_a'], 5, interval '1 minute') $$,
  $$ values (103::bigint) $$, 'several topics can be claimed at once');

select ok(api.complete_job(101, 1), 'complete_job with the claim''s attempt number succeeds');
select results_eq($$ select state, locked_until from public.jobs where id = 101 $$,
  $$ values ('done'::text, null::timestamptz) $$, 'a completed job is done and unlocked');
select ok(not api.complete_job(104, 1), 'a stale fencing token cannot complete a reclaimed job');
select ok(not api.complete_job(102), 'a job that is not running cannot be completed');

select is(api.fail_job(104, 'stage_a: timeout', null, 2), 'queued', 'a failure requeues the job');
select ok((select run_after >= now() + interval '20 seconds' and locked_until is null and last_error = 'stage_a: timeout'
           from public.jobs where id = 104),
  'with exponential backoff (5 s x 2^attempts)');
select is(api.fail_job(104, 'again'), null, 'fail_job on a job that is not running does nothing');

reset role;
update public.jobs set state = 'running', attempts = 5, locked_until = now() + interval '1 minute' where id = 107;
set local role service_role;
select is(api.fail_job(107, 'fatal'), 'dead', 'the last attempt''s failure dead-letters the job');
select is(api.fail_job(103, 'retry soon', interval '5 minutes'), 'queued', 'an explicit retry delay is honored');
select ok((select run_after between now() + interval '299 seconds' and now() + interval '301 seconds' from public.jobs where id = 103),
  'run_after = now() + retry_in');

select throws_ok($$ select * from api.claim_jobs(array[]::text[], 1, interval '30 seconds') $$, '22023', null,
  'topics are required');
select throws_ok($$ select * from api.claim_jobs(array['embed'], 1, interval '2 hours') $$, '22023', null,
  'leases are capped at one hour');

reset role;
select ok(pg_get_functiondef('api.claim_jobs(text[], integer, interval)'::regprocedure) ~* 'for\s+update\s+skip\s+locked',
  'claim_jobs locks candidates with FOR UPDATE SKIP LOCKED (concurrent workers never claim the same job)');
select ok(exists (select 1 from pg_trigger where tgname = 'jobs_notify' and tgrelid = 'public.jobs'::regclass)
          and (select prosrc from pg_proc where proname = 'on_job_insert') ilike '%pg_notify(''paceline_jobs'', new.topic)%',
  'job inserts NOTIFY paceline_jobs with the topic');

select * from finish();
rollback;
