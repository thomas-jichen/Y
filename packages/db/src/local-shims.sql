-- Local stand-ins for the Supabase built-ins that supabase/migrations rely on.
--
-- Applied by @paceline/db's migration runner before supabase/migrations, and
-- ONLY on local databases (PGlite, or a plain Postgres flagged with
-- PACELINE_DB_LOCAL=1). It is never applied to Supabase, which ships the real
-- versions of everything below.
--
-- Idempotent: the runner applies it on every local migrate run, inside a
-- transaction, so every statement must be safe to repeat. It is not tracked in
-- paceline_meta.migrations, which means it can evolve without tripping the
-- migration hash check.
--
-- What it mirrors:
--   * roles anon, authenticated, service_role (service_role has BYPASSRLS)
--   * schemas auth and extensions, plus search_path = "$user", public, extensions
--   * Supabase's default grants on schema public (RLS is what protects rows)
--   * a minimal auth.users table
--   * auth.uid(), auth.role(), auth.email() and auth.jwt(), which read the
--     request.jwt.claims setting that Db.asUser() / Db.asService() set
--   * pgcrypto and uuid-ossp in schema extensions, when they are available

-- Roles -----------------------------------------------------------------------

do $shim$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$shim$;

-- Keep service_role's BYPASSRLS even if the role pre-existed without it.
do $shim$
begin
  if not (select rolbypassrls from pg_catalog.pg_roles where rolname = 'service_role') then
    alter role service_role bypassrls;
  end if;
end
$shim$;

-- A non-superuser login role must be a member of the API roles to
-- `set local role` into them (superusers can assume any role already).
do $shim$
begin
  if not (select rolsuper from pg_catalog.pg_roles where rolname = current_user) then
    execute format('grant anon, authenticated, service_role to %I', current_user);
  end if;
exception
  when insufficient_privilege then
    raise warning 'paceline local shims: could not grant API roles to %: %', current_user, sqlerrm;
end
$shim$;

-- Schemas and search_path -----------------------------------------------------

create schema if not exists auth;
create schema if not exists extensions;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;

-- Supabase resolves unqualified names through "$user", public, extensions.
-- Persist it for new sessions (and PGlite clones) and apply it to this one.
do $shim$
begin
  execute format('alter database %I set search_path = "$user", public, extensions', current_database());
  perform pg_catalog.set_config('search_path', '"$user", public, extensions', false);
end
$shim$;

-- Supabase's default privileges: API roles get table/sequence/function grants
-- on everything created in public; row-level security decides what they see.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- Extensions that Supabase enables by default ----------------------------------

do $shim$
begin
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'pgcrypto') then
    create extension if not exists pgcrypto with schema extensions;
  end if;
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'uuid-ossp') then
    create extension if not exists "uuid-ossp" with schema extensions;
  end if;
end
$shim$;

-- auth.users (minimal) ----------------------------------------------------------

create table if not exists auth.users (
  instance_id uuid,
  id uuid primary key default gen_random_uuid(),
  aud varchar(255) default 'authenticated',
  role varchar(255) default 'authenticated',
  email varchar(255),
  phone text,
  email_confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  is_anonymous boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- As on Supabase, the API roles cannot read auth.users directly.
revoke all on table auth.users from anon, authenticated, service_role;

-- auth.* helpers ----------------------------------------------------------------
-- Same contract as Supabase's: read request.jwt.claims (or the legacy
-- request.jwt.claim.* settings). Empty settings are treated as absent, because
-- a transaction-local set_config leaves '' behind once the transaction ends.

create or replace function auth.jwt() returns jsonb
language sql stable
as $fn$
  select coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')
  )::jsonb
$fn$;

create or replace function auth.uid() returns uuid
language sql stable
as $fn$
  select nullif(
    coalesce(
      nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
      nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    ),
    ''
  )::uuid
$fn$;

create or replace function auth.role() returns text
language sql stable
as $fn$
  select nullif(
    coalesce(
      nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
      nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
    ),
    ''
  )::text
$fn$;

create or replace function auth.email() returns text
language sql stable
as $fn$
  select nullif(
    coalesce(
      nullif(pg_catalog.current_setting('request.jwt.claim.email', true), ''),
      nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'
    ),
    ''
  )::text
$fn$;

grant execute on function auth.jwt(), auth.uid(), auth.role(), auth.email()
  to anon, authenticated, service_role;
