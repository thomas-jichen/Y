-- apps/core local migration (red-team fixes, web API / realtime cluster). Idempotent.
--
-- Commit-ordered event ids (#33). events.id is a bigserial drawn at INSERT,
-- but a row becomes visible at COMMIT, so a long transaction (a presence
-- sweep, a review decision) could commit an event with a LOWER id after a
-- short one had committed a higher id. Every cursor over events (the
-- in-process bus watermark, agent pulse cursors, serverless SSE polls and
-- y_private.realtime_cursor) reads `id > cursor` and skipped such rows for
-- good.
--
-- A deferred constraint trigger checks each new event's id at commit time,
-- under one transaction-scoped advisory lock, and re-draws it from the
-- sequence unless it is already the newest id handed out. The lock is held
-- until the commit is visible (locks are released after the transaction
-- leaves the proc array), so ids are in commit order: a row that becomes
-- visible later always has a higher id than every row already visible.
-- Cursors stay plain numeric event ids; re-drawn ids only widen gaps, which
-- every reader already tolerates. Inside the inserting transaction the
-- provisional id is unchanged (the doorbell NOTIFY and api.emit_event's
-- return value keep it; core ignores both). The lock is taken only at commit,
-- so a long transaction never holds it while it works.
--
-- Cost (accepted; see also the alternative below):
-- - Every transaction that wrote an event commits under one global lock, held
--   through its commit WAL flush (and any synchronous-replication wait). That
--   serializes event-writing commits and caps them at roughly 1 / commit
--   latency (about 1-5 ms on managed Postgres: a few hundred to ~1000 event
--   commits per second). Y writes events per message, review decision and
--   presence change, far below that. Transactions that write no event are
--   unaffected.
-- - The function sets lock_timeout = 0 for itself, so a busy lock delays a
--   commit but never fails it on lock_timeout. statement_timeout still covers
--   the COMMIT; a wait long enough to hit it means the ceiling above is
--   reached.
-- - A re-draw is a non-HOT update (new primary key, GIN audience and
--   created_at index entries, one dead tuple). A transaction keeps all of its
--   ids, and pays nothing extra, when they are a gap-free run that ends at the
--   newest id handed out: then nobody else drew an id since its first event,
--   so every visible row is lower. A plain AFTER INSERT trigger
--   (events_commit_order_note) records the run in transaction-local settings
--   (y.ev_lo, y.ev_hi, y.ev_n; a rolled-back savepoint rolls them back too),
--   and the first deferred firing decides for the whole run. Otherwise (a
--   concurrent writer drew in between, an explicit id, a gap) each row is
--   re-drawn unless it is the newest id handed out, as before. Rows inserted
--   after a SET CONSTRAINTS ... IMMEDIATE start a new run.
--
-- Watching for contention (lock key 7931150214632601033 shows in pg_locks as
-- an advisory lock with classid 1846614809, objid 1668314569, objsubid 1):
--   select l.pid, l.granted, a.wait_event, now() - a.xact_start as xact_age
--     from pg_locks l join pg_stat_activity a using (pid)
--    where l.locktype = 'advisory' and l.classid = 1846614809
--      and l.objid = 1668314569 and l.objsubid = 1;
-- More than a handful of waiters (granted = false) for long means event commits
-- are queueing on this lock. Dead tuples on public.events show in
-- pg_stat_user_tables.n_dead_tup (autovacuum handles them).
--
-- Alternative considered: a read-side snapshot horizon (deliver only rows with
-- xmin older than pg_snapshot_xmin(pg_current_snapshot())) needs no lock, but
-- a transaction can draw its id before it is assigned an xid (the window lets
-- a lower id slip under the horizon), 32-bit xmin must be widened with the
-- epoch by hand, and any long-running transaction anywhere would stall every
-- stream and pulse until it ends. Commit-time ordering keeps every reader
-- unchanged.

-- Records this transaction's run of new event ids (see the cost notes above).
create or replace function y_private.events_commit_order_note()
returns trigger
language plpgsql volatile security definer
set search_path = ''
as $fn$
declare
  v_lo bigint := nullif(pg_catalog.current_setting('y.ev_lo', true), '')::bigint;
  v_hi bigint := nullif(pg_catalog.current_setting('y.ev_hi', true), '')::bigint;
  v_n bigint := coalesce(nullif(pg_catalog.current_setting('y.ev_n', true), '')::bigint, 0);
begin
  perform pg_catalog.set_config('y.ev_lo', least(coalesce(v_lo, new.id), new.id)::text, true);
  perform pg_catalog.set_config('y.ev_hi', greatest(coalesce(v_hi, new.id), new.id)::text, true);
  perform pg_catalog.set_config('y.ev_n', (v_n + 1)::text, true);
  return null;
end
$fn$;
revoke all on function y_private.events_commit_order_note() from public, anon, authenticated, service_role;

create or replace function y_private.events_commit_order()
returns trigger
language plpgsql volatile security definer
set search_path = ''
set lock_timeout = 0
as $fn$
declare
  v_lo bigint;
  v_hi bigint;
  v_n bigint;
  v_last bigint;
begin
  -- One lock for every event-writing commit (key: 'y.events.commit_order').
  perform pg_catalog.pg_advisory_xact_lock(7931150214632601033);
  v_last := pg_catalog.pg_sequence_last_value('public.events_id_seq'::pg_catalog.regclass);
  -- First firing of a run: decide for every row of it at once.
  v_lo := nullif(pg_catalog.current_setting('y.ev_lo', true), '')::bigint;
  v_hi := nullif(pg_catalog.current_setting('y.ev_hi', true), '')::bigint;
  v_n := nullif(pg_catalog.current_setting('y.ev_n', true), '')::bigint;
  if v_lo is not null and new.id between v_lo and v_hi then
    if v_hi = v_last and v_n = v_hi - v_lo + 1 then
      -- A gap-free run ending at the newest id: nobody else drew since its first id.
      perform pg_catalog.set_config('y.ev_keep_lo', v_lo::text, true);
      perform pg_catalog.set_config('y.ev_keep_hi', v_hi::text, true);
    else
      perform pg_catalog.set_config('y.ev_keep_lo', '', true);
      perform pg_catalog.set_config('y.ev_keep_hi', '', true);
    end if;
    perform pg_catalog.set_config('y.ev_lo', '', true);
    perform pg_catalog.set_config('y.ev_hi', '', true);
    perform pg_catalog.set_config('y.ev_n', '', true);
  end if;
  if new.id between nullif(pg_catalog.current_setting('y.ev_keep_lo', true), '')::bigint
                and nullif(pg_catalog.current_setting('y.ev_keep_hi', true), '')::bigint then
    return null;
  end if;
  -- Already the newest id handed out: every visible row is lower and every later commit re-draws
  -- above it, so it may keep its id. Otherwise (a concurrent writer or a later row of this
  -- transaction drew after it, or an explicit id) re-draw.
  if new.id is distinct from v_last then
    update public.events
       set id = pg_catalog.nextval('public.events_id_seq'::pg_catalog.regclass)
     where id = new.id;
  end if;
  return null;
end
$fn$;
revoke all on function y_private.events_commit_order() from public, anon, authenticated, service_role;
comment on function y_private.events_commit_order() is
  'Deferred: at commit, under an advisory lock, re-draws events.id unless it is the newest id handed out, so event ids follow commit order (cursor safety).';

drop trigger if exists events_commit_order_note on public.events;
create trigger events_commit_order_note
  after insert on public.events
  for each row execute function y_private.events_commit_order_note();

drop trigger if exists events_commit_order on public.events;
create constraint trigger events_commit_order
  after insert on public.events
  deferrable initially deferred
  for each row execute function y_private.events_commit_order();
