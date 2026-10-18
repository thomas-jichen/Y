-- 0006_core_role.sql
--
-- Optional hardening (PLAN §3, §10 "Tenancy bug"): dedicated login roles so
-- that a leaked core connection string cannot bypass RLS.
--
--   paceline_core    member of anon + authenticated ONLY, NOINHERIT: it has
--                    no table privileges of its own and must `set local role
--                    authenticated` (db.asUser) or `anon` (db.asAnon), where
--                    RLS applies. It cannot assume service_role.
--   paceline_worker  member of service_role, NOINHERIT: for job draining
--                    (db.asService). In serverless mode core drains jobs in
--                    the same process, so it needs both connection strings
--                    (DATABASE_URL for paceline_core, a separate one for the
--                    worker). Keep the worker URL out of request handlers.
--
-- Both are created NOLOGIN (placeholders, also locally). To use them on
-- Supabase, run once in the SQL editor (never in a migration, never commit
-- the password):
--   alter role paceline_core with login password '<random 32+ chars>';
--   alter role paceline_worker with login password '<random 32+ chars>';
-- and connect through Supavisor as `paceline_core.<project-ref>` (session
-- pooler, port 5432, if you need LISTEN; transaction pooler 6543 otherwise).
--
-- If the grants below cannot be made (a managed role without ADMIN OPTION on
-- the API roles), the migration warns instead of failing; run them as a
-- role that can, or keep using the default postgres connection.

do $roles$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'paceline_core') then
    create role paceline_core nologin noinherit;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'paceline_worker') then
    create role paceline_worker nologin noinherit;
  end if;
end
$roles$;

comment on role paceline_core is
  'apps/core request handlers: can only SET ROLE anon or authenticated (RLS always applies).';
comment on role paceline_worker is
  'apps/core job drain: can SET ROLE service_role. Never used for user-scoped queries.';

do $grants$
begin
  grant anon, authenticated to paceline_core;
  grant service_role to paceline_worker;
exception when insufficient_privilege then
  raise warning 'paceline 0006: could not grant API role membership (%). Grant it manually: '
                'grant anon, authenticated to paceline_core; grant service_role to paceline_worker;', sqlerrm;
end
$grants$;

-- Supabase resolves extension types (vector, citext) through search_path;
-- new roles do not inherit postgres's role-level setting.
alter role paceline_core set search_path = "$user", public, extensions;
alter role paceline_worker set search_path = "$user", public, extensions;
-- Request handlers never need long statements; jobs get more room.
alter role paceline_core set statement_timeout = '15s';
alter role paceline_worker set statement_timeout = '120s';
