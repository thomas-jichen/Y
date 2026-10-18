-- 0007_cron.sql
--
-- Serverless job drain (zero-cost hosting): every minute, pg_cron calls
-- y_private.jobs_tick(), which POSTs core's /internal/jobs/tick via
-- pg_net with a shared secret. Hourly, pg_cron runs api.purge_expired().
--
-- Schedules are created ONLY when both pg_cron and pg_net are available
-- (Supabase). On PGlite / plain Postgres the DO block below is a no-op and
-- server-mode core drains jobs with its in-process loop (LISTEN y_jobs).
--
-- Configuration (read at every tick, so it can change without a migration):
--   1. Supabase Vault (preferred: encrypted at rest), secret names
--        y_core_url          e.g. https://core.example.vercel.app
--        y_jobs_tick_secret  same value as core's Y_CRON_SECRET
--      select vault.create_secret('https://...', 'y_core_url');
--      select vault.create_secret('<random>', 'y_jobs_tick_secret');
--   2. Fallback when Vault is absent: y_private.app_config rows with
--      keys 'core_url' and 'jobs_tick_secret' (service-only table).
-- The request is:
--   POST <core_url>/internal/jobs/tick
--   Authorization: Bearer <jobs_tick_secret>
--   Content-Type: application/json
--   {"source": "pg_cron", "due": <number of due jobs>}
-- Core must compare the secret in constant time and should return quickly
-- when due = 0.

create table y_private.app_config (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  value text not null check (char_length(value) <= 2048),
  updated_at timestamptz not null default now()
);
alter table y_private.app_config enable row level security;
revoke all on table y_private.app_config from public, anon, authenticated, service_role;
comment on table y_private.app_config is
  'Fallback for Vault: core_url, jobs_tick_secret. No API role can read it; definer functions do.';

-- Vault secret 'y_<key>' if Vault exists, else app_config.<key>.
create or replace function y_private.config_value(p_key text) returns text
language plpgsql stable security definer
set search_path = ''
as $fn$
declare
  v_value text;
begin
  if to_regclass('vault.decrypted_secrets') is not null then
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 order by created_at desc limit 1'
      into v_value using 'y_' || p_key;
  end if;
  if v_value is null then
    select c.value into v_value from y_private.app_config c where c.key = p_key;
  end if;
  return v_value;
end
$fn$;

-- One tick: returns the pg_net request id, or null when not configured or
-- pg_net is missing (with a warning, never an error, so cron keeps running).
create or replace function y_private.jobs_tick() returns bigint
language plpgsql volatile security definer
set search_path = ''
as $fn$
declare
  v_url text := y_private.config_value('core_url');
  v_secret text := y_private.config_value('jobs_tick_secret');
  v_due bigint;
  v_request_id bigint;
begin
  if v_url is null or v_secret is null then
    raise warning 'y jobs_tick: core_url / jobs_tick_secret are not configured (Vault or y_private.app_config)';
    return null;
  end if;
  if v_url !~ '^https?://[A-Za-z0-9.:-]+(/[A-Za-z0-9._~/-]*)?$' then
    raise warning 'y jobs_tick: core_url is not an http(s) URL';
    return null;
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'net' and p.proname = 'http_post') then
    raise warning 'y jobs_tick: pg_net is not installed';
    return null;
  end if;

  select count(*) into v_due
  from public.jobs j
  where (j.state = 'queued' and j.run_after <= now()) or (j.state = 'running' and j.locked_until < now());

  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := $4)'
    into v_request_id
    using rtrim(v_url, '/') || '/internal/jobs/tick',
          jsonb_build_object('source', 'pg_cron', 'due', v_due),
          jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
          5000;
  return v_request_id;
end
$fn$;

revoke all on function y_private.config_value(text), y_private.jobs_tick()
  from public, anon, authenticated, service_role;

do $cron$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron')
     or not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_net') then
    raise notice 'y 0007: pg_cron/pg_net unavailable; no schedules created (local mode drains jobs in-process)';
    return;
  end if;
  create extension if not exists pg_net with schema extensions;
  create extension if not exists pg_cron;
  -- cron.schedule(name, ...) upserts by name, so re-running is safe.
  perform cron.schedule('y-jobs-tick', '* * * * *', 'select y_private.jobs_tick()');
  perform cron.schedule('y-purge-expired', '17 * * * *', 'select api.purge_expired()');
end
$cron$;
