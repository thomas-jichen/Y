-- Structural invariants of the schema: RLS everywhere (I7), grants, vector
-- dimensions and indexes, domains, helper behavior, roles.
begin;
create extension if not exists pgtap with schema extensions;
select plan(32);

-- RLS -----------------------------------------------------------------------
select is_empty(
  $$ select format('%I.%I', n.nspname, c.relname)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p') and n.nspname in ('public', 'y_private') and not c.relrowsecurity $$,
  'every table in public and y_private has row level security enabled');

select cmp_ok(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind = 'r' and n.nspname = 'public'),
  '>=', 60, 'the core schema has all its tables');

-- Extensions and vectors ----------------------------------------------------------
select ok((select count(*) = 3 from pg_extension where extname in ('vector', 'pg_trgm', 'citext')),
  'vector, pg_trgm and citext are installed');

select set_eq(
  $$ select format('%s.%s %s', c.relname, a.attname, format_type(a.atttypid, a.atttypmod))
     from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
     join pg_type t on t.oid = a.atttypid
     where n.nspname = 'public' and c.relkind = 'r' and t.typname = 'vector' and a.attnum > 0 and not a.attisdropped $$,
  array['activities.embedding vector(384)', 'highlights.embedding vector(384)',
        'shared_components.embedding vector(384)', 'segments.centroid vector(384)'],
  'every vector column is vector(384) (gte-small)');

select set_eq(
  $$ select indexname::text from pg_indexes
     where schemaname = 'public' and indexdef ilike '%using hnsw%vector_cosine_ops%' $$,
  array['activities_embedding_hnsw', 'highlights_embedding_hnsw', 'shared_components_embedding_hnsw',
        'segments_centroid_hnsw'],
  'HNSW vector_cosine_ops indexes on every embedding');

select ok(exists (select 1 from pg_indexes where indexname = 'highlight_errors_sig_trgm'
                  and indexdef ilike '%gin (sig gin_trgm_ops)%'),
  'trigram GIN index on highlight_errors.sig');

select ok(exists (select 1 from pg_indexes where indexname = 'activities_feed_idx'
                  and indexdef ilike '%(published_at desc, id desc)%where%published%'),
  'keyset feed index on activities (published_at desc, id desc)');

select set_eq(
  $$ select c.relname || '.' || a.attname from pg_attribute a join pg_class c on c.oid = a.attrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and a.attgenerated = 's' $$,
  array['activities.fts', 'highlights.fts', 'posts.fts', 'scroll_learnings.fts'],
  'fts columns are STORED generated tsvectors');

-- Grants: anon ----------------------------------------------------------------
select set_eq(
  $$ select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege('anon', c.oid, 'SELECT') $$,
  array['users', 'agents', 'activities', 'highlights', 'highlight_errors', 'setup_versions', 'setup_components',
        'shared_components', 'setup_reviews', 'segments', 'segment_stats', 'products', 'product_claims',
        'kill_switches'],
  'anon can SELECT only the public read paths');

select is_empty(
  $$ select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public', 'y_private') and c.relkind = 'r'
       and (has_table_privilege('anon', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
            or has_any_column_privilege('anon', c.oid, 'INSERT, UPDATE')) $$,
  'anon cannot write any table');

-- Grants: authenticated has nothing on service-only tables -------------------------
select is_empty(
  $$ select t from unnest(array['jobs', 'events', 'rate_buckets', 'signing_keys', 'audit_log', 'verdicts',
                                'wake_ledger', 'handle_registry', 'slack_installations', 'slack_link_tokens',
                                'thread_bridges', 'slack_events_seen']) t
     where has_any_column_privilege('authenticated', ('public.' || t)::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
        or has_table_privilege('authenticated', ('public.' || t)::regclass, 'DELETE, TRUNCATE')
        or has_any_column_privilege('anon', ('public.' || t)::regclass, 'SELECT, INSERT, UPDATE, REFERENCES') $$,
  'jobs, events, rate_buckets, signing_keys, audit_log and the other service-only tables grant nothing to API roles');

select ok(not has_any_column_privilege('authenticated', 'y_private.app_config', 'SELECT')
          and not has_any_column_privilege('service_role', 'y_private.app_config', 'SELECT'),
  'y_private.app_config (cron secrets) is readable by no API role');

select ok(not has_column_privilege('authenticated', 'public.installs', 'token_hash', 'SELECT')
          and has_column_privilege('authenticated', 'public.installs', 'revoked_at', 'SELECT'),
  'authenticated cannot read install token hashes');

select ok(has_table_privilege('service_role', 'public.jobs', 'SELECT, INSERT, UPDATE, DELETE')
          and has_table_privilege('service_role', 'public.events', 'SELECT, INSERT, DELETE'),
  'service_role keeps full access to service-only tables');

-- Grants: functions -----------------------------------------------------------------
select set_eq(
  $$ select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'api' and has_function_privilege('anon', p.oid, 'EXECUTE') $$,
  array['search_network', 'feed_activities', 'resolve_install_token'],
  'anon may execute only search_network, feed_activities and resolve_install_token');

select is_empty(
  $$ select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'api'
       and p.proname in ('claim_jobs', 'complete_job', 'fail_job', 'emit_system_event', 'events_since', 'purge_expired',
                         'refresh_agent_presence')
       and has_function_privilege('authenticated', p.oid, 'EXECUTE') $$,
  'job, system-event, purge and presence-refresh functions are service_role only');

select is_empty(
  $$ select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'y_private'
       and p.proname in ('broadcast', 'jobs_tick', 'config_value', 'handle_new_auth_user', 'on_event_insert',
                         'derive_presence')
       and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
            or has_function_privilege('anon', p.oid, 'EXECUTE')) $$,
  'broadcast, jobs_tick, config_value, derive_presence and trigger functions are not callable by API roles');

-- Seeds and helpers -----------------------------------------------------------------
select results_eq(
  $$ select name, engaged from public.kill_switches order by name $$,
  $$ values ('apply'::text, false), ('ingest', false), ('network_content', false), ('push_paths', false) $$,
  'the four kill switches exist, disengaged');

select ok(y_private.ulid() ~ '^[0-9A-HJKMNP-TV-Z]{26}$', 'ulid() returns a Crockford base32 ULID');
select ok(y_private.ulid() <> y_private.ulid(), 'ulid() is random');
select ok(left(y_private.ulid(), 10) >= '01J0000000', 'ulid() encodes the current time');

-- Domains mirror packages/schema ------------------------------------------------------
select lives_ok($$ select array['l0']::y_private.screen_layers $$, 'screen layers [l0] alone is a valid verdict');
select lives_ok($$ select array['l0', 'l2']::y_private.screen_layers $$, 'screen layers [l0, l2] is valid');
select throws_ok($$ select array['l2']::y_private.screen_layers $$, '23514', null, 'screen layers must include l0');
select throws_ok($$ select 'Bad Handle'::y_private.handle $$, '23514', null, 'handles must match ^[a-z0-9-]{3,32}$');
select throws_ok($$ select 'not_an_intent'::y_private.task_intent $$, '23514', null, 'task intents are the fixed 32');

-- Event payloads are ids/counts only (I3) ---------------------------------------------
select ok(y_private.event_payload_ok('{"reviewId": "rv_01J00000000000000000000000", "count": 3, "seen": true}'),
  'ids, integers and booleans are valid event payload values');
select ok(not y_private.event_payload_ok('{"body": "ignore previous instructions"}'),
  'free text is rejected from event payloads');
select ok(not y_private.event_payload_ok('{"nested": {"a": 1}}')
          and not y_private.event_payload_ok('{"score": 0.5}')
          and not y_private.event_payload_ok('["a"]'),
  'objects, floats and non-object payloads are rejected');

-- updated_at triggers -----------------------------------------------------------------
select is_empty(
  $$ select c.relname from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and a.attname = 'updated_at' and c.relname <> 'rate_buckets'
       and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = c.relname || '_touch_updated_at') $$,
  'every table with updated_at (except rate_buckets) maintains it by trigger');

-- Roles (0006) ------------------------------------------------------------------------
select ok((select not rolinherit and not rolcanlogin from pg_roles where rolname = 'y_core')
          and pg_has_role('y_core', 'authenticated', 'MEMBER')
          and pg_has_role('y_core', 'anon', 'MEMBER')
          and not pg_has_role('y_core', 'service_role', 'MEMBER'),
  'y_core is a NOINHERIT placeholder that can assume only anon/authenticated');

select ok(pg_has_role('y_worker', 'service_role', 'MEMBER')
          and not pg_has_role('y_worker', 'authenticated', 'USAGE'),
  'y_worker can assume service_role and inherits nothing');

select * from finish();
rollback;
