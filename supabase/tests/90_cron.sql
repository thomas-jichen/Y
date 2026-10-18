-- 0007: the serverless jobs tick. Schedules exist only where pg_cron and
-- pg_net do; the tick reads core_url / jobs_tick_secret from Vault or
-- paceline_private.app_config and never raises.
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

select ok((select relrowsecurity from pg_class where oid = 'paceline_private.app_config'::regclass)
          and not exists (select 1 from pg_policy where polrelid = 'paceline_private.app_config'::regclass),
  'app_config has RLS and no policies (definer functions only)');

-- cron.job is looked up dynamically: the relation only exists where pg_cron does.
create function pg_temp.cron_job_exists(p_name text, p_schedule text) returns boolean
language plpgsql as $$
declare
  v_found boolean;
begin
  if to_regclass('cron.job') is null then
    return null;
  end if;
  execute 'select exists (select 1 from cron.job where jobname = $1 and schedule = $2)' into v_found using p_name, p_schedule;
  return v_found;
end
$$;
select ok(coalesce(pg_temp.cron_job_exists('paceline-jobs-tick', '* * * * *'), to_regnamespace('cron') is null),
  'the jobs tick is scheduled every minute wherever pg_cron exists');
select ok(coalesce(pg_temp.cron_job_exists('paceline-purge-expired', '17 * * * *'), to_regnamespace('cron') is null),
  'retention runs hourly wherever pg_cron exists');

select is(paceline_private.jobs_tick(), null, 'an unconfigured tick does nothing (warning only)');

insert into paceline_private.app_config (key, value) values ('core_url', 'not a url'), ('jobs_tick_secret', 'test-secret-value');
select is(paceline_private.config_value('jobs_tick_secret'), 'test-secret-value', 'config falls back to app_config');
select is(paceline_private.jobs_tick(), null, 'a malformed core_url is refused');

update paceline_private.app_config set value = 'https://core.example.test' where key = 'core_url';
select ok(case
            when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                         where n.nspname = 'net' and p.proname = 'http_post')
              then paceline_private.jobs_tick() is not null
            else paceline_private.jobs_tick() is null
          end,
  'a configured tick queues a pg_net request where pg_net exists, else does nothing');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","via":"web"}', true);
select throws_ok($$ select paceline_private.jobs_tick() $$, '42501', null, 'API roles cannot trigger the tick');

reset role;
select * from finish();
rollback;
