-- Data-layer checks of the CLAUDE.md safety invariants, as catalog
-- assertions (no fixtures): they fail as soon as a later migration adds a
-- table, policy, grant or function that breaks one.
--   I7  RLS on every table; nothing reachable by API roles without a policy;
--       SECURITY DEFINER code pins its search_path.
--   I4  dm_permissions is written by its owner in a human context only, and
--       by no function at all.
--   I2/I5 owner instructions are their own signed table, never messages.
--   I3  events (the push fan-out) carry ids/counts only: fixed columns, a
--       payload CHECK, and broadcasts built from (id, type, payload) only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(22);

-- I7: RLS everywhere ---------------------------------------------------------------
select is_empty(
  $$ select format('%I.%I', n.nspname, c.relname)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p') and n.nspname in ('public', 'paceline_private', 'api', 'paceline_meta')
       and not c.relrowsecurity $$,
  'I7: every table in public, paceline_private, api and paceline_meta has row level security enabled');

select is_empty(
  $$ select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
       and not c.relrowsecurity $$,
  'I7: every table in public has rowsecurity = true');

select is_empty(
  $$ select format('%I.%I', n.nspname, c.relname)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public', 'paceline_private') and c.relkind in ('r', 'p')
       and (has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
            or has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
            or has_any_column_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE')
            or has_any_column_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE'))
       and not exists (select 1 from pg_policy p where p.polrelid = c.oid) $$,
  'I7: no table is reachable by anon/authenticated without at least one policy');

select is_empty(
  $$ select format('%I.%I', n.nspname, c.relname)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public', 'paceline_private') and c.relkind in ('r', 'p')
       and (has_table_privilege('anon', c.oid, 'TRUNCATE, REFERENCES, TRIGGER')
            or has_table_privilege('authenticated', c.oid, 'TRUNCATE, REFERENCES, TRIGGER')) $$,
  'I7: API roles hold no TRUNCATE, REFERENCES or TRIGGER privilege');

select is_empty(
  $$ select format('%I.%I', n.nspname, p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'api', 'paceline_private') and p.prosecdef
       and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%') $$,
  'I7: every SECURITY DEFINER function pins its search_path');

select is_empty(
  $$ select format('%I.%I', n.nspname, p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'api', 'paceline_private')
       and has_function_privilege('public', p.oid, 'EXECUTE') $$,
  'I7: no function in public, api or paceline_private is executable by PUBLIC');

-- I4: DM permissions -------------------------------------------------------------------
select is_empty(
  $$ select p.polname from pg_policy p
     where p.polrelid = 'public.dm_permissions'::regclass and p.polcmd in ('a', 'w', 'd', '*')
       and not (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
                ilike '%is_human()%'
                and coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
                ilike '%owner_user_id = %auth.uid()%') $$,
  'I4: every write policy on dm_permissions requires the owner in a human context');

select is_empty(
  $$ select p.polname from pg_policy p
     where p.polrelid = 'public.dm_permissions'::regclass
       and not (p.polroles = array['authenticated'::regrole]::oid[]) $$,
  'I4: dm_permissions policies apply to authenticated only (no anon, no PUBLIC)');

select is_empty(
  $$ select format('%I.%I', n.nspname, p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname not in ('pg_catalog', 'information_schema') and p.prosrc ilike '%dm_permissions%' $$,
  'I4: no function or trigger anywhere touches dm_permissions (writes come only from the owner''s own statements)');

select ok(not has_table_privilege('anon', 'public.dm_permissions', 'SELECT, INSERT, UPDATE, DELETE')
          and not has_any_column_privilege('anon', 'public.dm_permissions', 'SELECT, INSERT, UPDATE'),
  'I4: anon has no privilege on dm_permissions');

-- I2 / I5: owner instructions are separate and signed -------------------------------
select is_empty(
  $$ select conname from pg_constraint
     where contype = 'f'
       and ((conrelid = 'public.messages'::regclass and confrelid = 'public.owner_instructions'::regclass)
            or (conrelid = 'public.owner_instructions'::regclass and confrelid = 'public.messages'::regclass)) $$,
  'owner instructions and messages are separate tables with no link between them');

select ok((select bool_and(pg_get_constraintdef(c.oid) not ilike '%owner_instruction%')
           from pg_constraint c
           where c.conrelid = 'public.messages'::regclass and c.contype = 'c'
             and pg_get_constraintdef(c.oid) ilike '%trust%'),
  'a message can never carry the owner_instruction trust badge');

select ok((select bool_and(a.attnotnull) from pg_attribute a
           where a.attrelid = 'public.owner_instructions'::regclass and a.attname in ('kid', 'sig', 'verified_via', 'created_by_user_id')),
  'every owner instruction carries a core signature (kid, sig), how the human was verified, and who wrote it');

select ok((select bool_and(coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ilike '%is_human()%')
           from pg_policy p where p.polrelid = 'public.owner_instructions'::regclass and p.polcmd = 'a'),
  'owner instructions are inserted in a human context only (I5)');

select is_empty(
  $$ select attname from pg_attribute
     where attrelid = 'public.owner_instructions'::regclass and attnum > 0 and not attisdropped
       and has_column_privilege('authenticated', 'public.owner_instructions', attname, 'UPDATE')
       and attname not in ('delivered_at', 'confirmed_at', 'confirmed_via') $$,
  'an owner instruction''s body, agent, signature and verification can never be updated by API roles');

-- I3: the events fan-out carries ids/counts only --------------------------------------
select set_eq(
  $$ select attname::text from pg_attribute
     where attrelid = 'public.events'::regclass and attnum > 0 and not attisdropped $$,
  array['id', 'type', 'audience_agent_ids', 'audience_user_ids', 'payload', 'created_at'],
  'I3: events has no content columns (id, type, audiences, ids-only payload, time)');

select ok(exists (select 1 from pg_constraint c
                  where c.conrelid = 'public.events'::regclass and c.contype = 'c'
                    and pg_get_constraintdef(c.oid) ilike '%event_payload_ok(payload)%'),
  'I3: events.payload is checked to be ids, integers and booleans only');

select set_eq(
  $$ select m[1] from pg_constraint c,
            lateral regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_.]+)''', 'g') m
     where c.conrelid = 'public.events'::regclass and c.contype = 'c'
       and pg_get_constraintdef(c.oid) ilike '%(type = any%' $$,
  array['activity.published', 'activity.updated', 'message.new', 'message.delivered', 'review.new', 'review.decided',
        'change.updated', 'presence', 'rollup.updated', 'owner_instruction.new', 'suggestion.ready', 'thread.escalated',
        'wake.requested', 'kill_switch.changed', 'takedown'],
  'I3: events.type is exactly packages/schema EventType');

select ok((select prosrc from pg_proc where oid = 'paceline_private.on_event_insert()'::regprocedure)
          ilike '%jsonb_build_object(''id'', new.id::text, ''type'', new.type, ''payload'', new.payload)%',
  'I3: Realtime broadcasts are built from the row id, type and ids-only payload, nothing else');

select set_eq(
  $$ select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'api', 'paceline_private') and p.prosrc ilike '%pg_notify%' $$,
  array['on_event_insert', 'on_job_insert'],
  'I3: only the events doorbell (row id) and the jobs doorbell (topic) use pg_notify');

select set_eq(
  $$ select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'api', 'paceline_private') and p.prosrc ilike '%paceline_private.broadcast(%' $$,
  array['on_event_insert'],
  'I3: only the events trigger broadcasts');

select ok(not has_function_privilege('authenticated', 'paceline_private.broadcast(text, text, jsonb)', 'EXECUTE')
          and not has_function_privilege('anon', 'paceline_private.broadcast(text, text, jsonb)', 'EXECUTE'),
  'I3: API roles cannot broadcast directly');

select * from finish();
rollback;
