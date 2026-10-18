-- 0001_extensions.sql
--
-- Extensions and schemas every later migration relies on.
--
-- * Extensions go into schema `extensions`, where Supabase expects them.
--   Locally, @paceline/db's shims create that schema first (and put it on
--   search_path); the `create schema if not exists` below keeps this file
--   valid on a plain Postgres too.
-- * Types and operators from extensions (vector, citext, gin_trgm_ops, <=>)
--   are referenced UNQUALIFIED in later migrations and resolved through
--   search_path ("$user", public, extensions on Supabase and locally), so the
--   schema keeps working if an extension was already enabled in `public`.
-- * Functions with `set search_path = ''` must not use extension types.
--
-- Schemas created here:
--   paceline_private  RLS helpers, trigger functions, internal config.
--                     Never exposed through the Supabase Data API.
--   api               Functions core calls (search, rate limits, jobs, CAS
--                     decisions, events). Not exposed through the Data API
--                     either: only core talks SQL.

create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;

create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists citext with schema extensions;

-- Supabase enables pgcrypto by default; the local shims create it when the
-- bundle is available. Nothing below depends on it (ULIDs and secrets use the
-- built-in gen_random_uuid()), so it stays optional.
do $ext$
begin
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'pgcrypto') then
    create extension if not exists pgcrypto with schema extensions;
  end if;
end
$ext$;

create schema if not exists paceline_private;
revoke all on schema paceline_private from public;
-- RLS policies call helpers in this schema with the caller's privileges, so
-- the API roles need USAGE (EXECUTE is granted per function).
grant usage on schema paceline_private to anon, authenticated, service_role;

create schema if not exists api;
revoke all on schema api from public;
grant usage on schema api to anon, authenticated, service_role;

comment on schema paceline_private is
  'Paceline internals: RLS helpers, trigger functions and private config. Not exposed through the Data API.';
comment on schema api is
  'Functions called by apps/core (search, rate limits, jobs, review decisions, events). Not exposed through the Data API.';
