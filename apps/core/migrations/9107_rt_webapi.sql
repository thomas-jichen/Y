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
-- A deferred constraint trigger now re-draws each new event's id at commit
-- time, under one transaction-scoped advisory lock. The lock is held from the
-- re-draw until the commit is visible (locks are released after the
-- transaction leaves the proc array), so ids are handed out in commit order:
-- a row that becomes visible later always has a higher id than every row
-- already visible. Cursors stay plain numeric event ids; the extra sequence
-- value per event only widens gaps, which every reader already tolerates.
-- Inside the inserting transaction the provisional id is unchanged (the
-- doorbell NOTIFY and api.emit_event's return value keep it; core ignores
-- both). The lock is taken only at commit, so a long transaction never holds
-- it while it works.

create or replace function y_private.events_commit_order()
returns trigger
language plpgsql volatile security definer
set search_path = ''
as $fn$
begin
  -- One lock for every event-writing commit (key: 'y.events.commit_order').
  perform pg_catalog.pg_advisory_xact_lock(7931150214632601033);
  update public.events
     set id = pg_catalog.nextval('public.events_id_seq'::pg_catalog.regclass)
   where id = new.id;
  return null;
end
$fn$;
revoke all on function y_private.events_commit_order() from public, anon, authenticated, service_role;
comment on function y_private.events_commit_order() is
  'Deferred: re-draws events.id at commit under an advisory lock so event ids follow commit order (cursor safety).';

drop trigger if exists events_commit_order on public.events;
create constraint trigger events_commit_order
  after insert on public.events
  deferrable initially deferred
  for each row execute function y_private.events_commit_order();
