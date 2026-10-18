-- 0010_presence.sql
--
-- Presence ("beacon", PLAN §9 Reachability) derived from signals. Until now
-- agent_presence.presence kept its insert default ('away') forever: nothing
-- wrote it. The signals:
--
-- * session_leases.active_at (new): the listener reports `active=1` on
--   /api/v1/pulse while a turn is in progress (prompt submitted, Stop not yet
--   fired) and `active=0` when idle; reports_turns marks leases whose
--   listener does this.
-- * session_leases.listening / last_heartbeat_at: every listener poll of
--   /api/v1/pulse heartbeats its lease.
-- * sessions.last_event_at / ended_at: every ingest chunk (the Stop hook
--   uploads one per turn) bumps last_event_at; close_idle and session-end
--   chunks set ended_at. Only a fallback for listeners that don't report
--   turns (older plugins): an ingest marks the END of a turn.
--
-- y_private.derive_presence is the one place the rule lives:
--   live                     a lease with active_at within p_live_window, or an
--                            open session with an ingest within p_ingest_live_window
--                            whose lease does not report turns
--   listening                else a 'listening' lease heartbeat within p_listening_window
--   listening_needs_approval else such a lease in state 'listening_needs_approval'
--   away                     otherwise
-- Core passes the windows (packages/domain presence.ts: 150 s live; 10 min
-- ingest fallback; 70 s listening for long-poll listeners, 630 s when core
-- hands out a Realtime doorbell); the defaults here are the long-poll values.
--
-- agent_presence.presence stays the stored, denormalized value that readers
-- use (RLS unchanged: team-only). api.refresh_agent_presence recomputes it
-- for some agents (pulse heartbeat, ingest) or for every agent that may have
-- changed (the presence_sweep job) and returns only the rows it changed, so
-- core publishes one 'presence' event per actual change. Service role only.

-- ================================================================== signals

alter table public.session_leases
  add column active_at timestamptz,
  add column reports_turns boolean not null default false;
grant update (active_at, reports_turns) on public.session_leases to authenticated;

-- derive_presence looks up an agent's live sessions on every pulse; without
-- this it scans every session the agent ever had.
create index sessions_agent_live_idx on public.sessions (agent_id, last_event_at desc)
  where status = 'open' and ended_at is null;

-- ================================================================= derive

create or replace function y_private.derive_presence(
  p_agent_id uuid,
  p_live_window interval default interval '150 seconds',
  p_listening_window interval default interval '70 seconds',
  p_ingest_live_window interval default interval '10 minutes'
) returns y_private.presence
language sql stable security definer
set search_path = ''
as $fn$
  select (case
    when exists (select 1 from public.session_leases l
                  where l.agent_id = p_agent_id and l.active_at > now() - p_live_window)
      then 'live'
    when exists (select 1 from public.sessions s
                  where s.agent_id = p_agent_id and s.status = 'open' and s.ended_at is null
                    and s.last_event_at > now() - p_ingest_live_window
                    and not exists (select 1 from public.session_leases l
                                     where l.agent_id = s.agent_id and l.session_id = s.harness_session_id
                                       and l.reports_turns))
      then 'live'
    when exists (select 1 from public.session_leases l
                  where l.agent_id = p_agent_id and l.listening = 'listening'
                    and l.last_heartbeat_at > now() - p_listening_window)
      then 'listening'
    when exists (select 1 from public.session_leases l
                  where l.agent_id = p_agent_id and l.listening = 'listening_needs_approval'
                    and l.last_heartbeat_at > now() - p_listening_window)
      then 'listening_needs_approval'
    else 'away'
  end)::y_private.presence
$fn$;

-- ================================================================ refresh

-- Recompute and store presence. p_agent_ids null = sweep: every agent not
-- stored as away (so stale ones decay) plus every agent with a fresh signal.
-- Returns the changed rows only.
--
-- plpgsql on purpose: the candidates' rows are locked first (in agent_id
-- order, so overlapping sweeps can't deadlock), and only then is presence
-- derived, in a later statement with a fresh snapshot. A refresh that waited
-- on a concurrent one therefore derives from what that one saw or newer,
-- never from a snapshot older than the value it overwrites; and the loser of
-- a race to the same value finds nothing to change, so a change is reported once.
create or replace function api.refresh_agent_presence(
  p_agent_ids uuid[] default null,
  p_live_window interval default interval '150 seconds',
  p_listening_window interval default interval '70 seconds',
  p_ingest_live_window interval default interval '10 minutes'
) returns table (agent_id uuid, owner_user_id uuid, presence text)
language plpgsql volatile security definer
set search_path = ''
as $fn$
#variable_conflict use_column
declare
  v_ids uuid[];
begin
  select coalesce(array_agg(distinct c.id), '{}') into v_ids from (
    select p.agent_id from public.agent_presence p
     where p_agent_ids is not null and p.agent_id = any(p_agent_ids)
    union
    select p.agent_id from public.agent_presence p
     where p_agent_ids is null and p.presence <> 'away'
    union
    select l.agent_id from public.session_leases l
     where p_agent_ids is null
       and ((l.listening <> 'none' and l.last_heartbeat_at > now() - p_listening_window)
            or l.active_at > now() - p_live_window)
    union
    select s.agent_id from public.sessions s
     where p_agent_ids is null and s.status = 'open' and s.ended_at is null
       and s.last_event_at > now() - p_ingest_live_window
  ) c(id);
  if cardinality(v_ids) = 0 then
    return;
  end if;

  perform 1 from public.agent_presence p where p.agent_id = any(v_ids) order by p.agent_id for update;

  return query
  with derived as (
    select ap.agent_id as id,
           y_private.derive_presence(ap.agent_id, p_live_window, p_listening_window, p_ingest_live_window) as next
      from public.agent_presence ap
     where ap.agent_id = any(v_ids)
  ), changed as (
    update public.agent_presence ap
       set presence = d.next, updated_at = now()
      from derived d
     where ap.agent_id = d.id and ap.presence is distinct from d.next
    returning ap.agent_id as id, ap.presence as next
  )
  select ch.id, a.owner_user_id, ch.next::text
    from changed ch join public.agents a on a.id = ch.id;
end
$fn$;

-- ================================================================ backfill

-- Rows written before this migration all say 'away'; fix them once (no
-- events: clients load presence fresh).
update public.agent_presence p
   set presence = y_private.derive_presence(p.agent_id), updated_at = now()
 where p.presence is distinct from y_private.derive_presence(p.agent_id);

-- ================================================================== grants

revoke all on function y_private.derive_presence(uuid, interval, interval, interval) from public, anon, authenticated, service_role;
revoke all on function api.refresh_agent_presence(uuid[], interval, interval, interval) from public, anon, authenticated, service_role;
grant execute on function api.refresh_agent_presence(uuid[], interval, interval, interval) to service_role;
