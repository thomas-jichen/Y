-- apps/core local migration (owner: core teams). The repo bar under the web
-- app's top navbar: which of a team's linked repos have agents working in
-- them now, and the latest update in each.
--
-- The plugin never sends repo names: sessions, activities and turn summaries
-- carry repo_key = HMAC(team repo_key_salt, normalized git remote). Core
-- computes the same key for each linked repo (team_repos) from its canonical
-- GitHub remote and matches by key. Neither the key nor the salt leaves core.
--
-- Sessions and session leases are owner-only under RLS (agent_ok), so a member
-- cannot see whether a teammate's agent is in a repo. api.team_repo_agents
-- answers only a count per key, only to a human member of that team, and only
-- for agents whose owner is still on the team and shares their updates with it
-- (the update_sharing opt-out and the team policy, as turn_summary_shared),
-- plus the caller's own agents. Additive and idempotent.

-- "Working" follows the presence rule (0010, packages/domain presence.ts) per
-- session: an open session in the repo with an ingest within the ingest window,
-- or whose lease is active (live) or heartbeating as a listener. One row per
-- key with agents, plus a row with a null key: distinct agents across all keys
-- (an agent in two repos counts once there).
create or replace function api.team_repo_agents(
  p_team uuid,
  p_keys text[],
  p_live_window interval default interval '150 seconds',
  p_listening_window interval default interval '70 seconds',
  p_ingest_live_window interval default interval '10 minutes'
) returns table (repo_key text, active_agents integer)
language plpgsql stable security definer
set search_path = ''
as $fn$
begin
  if not (y_private.is_human() and y_private.is_team_member(p_team)) then
    raise exception using errcode = '42501', message = 'team_repo_agents: requires a human member of the team';
  end if;
  if p_keys is null or cardinality(p_keys) = 0 then
    return;
  end if;
  return query
    select s.repo_key::text, count(distinct s.agent_id)::integer
      from public.sessions s
      join public.agents ag on ag.id = s.agent_id
      join public.team_members m on m.team_id = p_team and m.user_id = ag.owner_user_id
     where s.repo_key::text = any (p_keys)
       and s.status = 'open' and s.ended_at is null
       and (ag.owner_user_id = auth.uid()
            or m.policy_accepted_version is not null
            or not exists (select 1 from public.update_sharing u
                            where u.user_id = ag.owner_user_id and not u.share_with_team))
       and (s.last_event_at > now() - p_ingest_live_window
            or exists (select 1 from public.session_leases l
                        where l.agent_id = s.agent_id and l.session_id = s.harness_session_id
                          and (l.active_at > now() - p_live_window
                               or (l.listening in ('listening', 'listening_needs_approval')
                                   and l.last_heartbeat_at > now() - p_listening_window))))
     group by grouping sets ((s.repo_key), ());
end
$fn$;

revoke all on function api.team_repo_agents(uuid, text[], interval, interval, interval) from public, anon;
grant execute on function api.team_repo_agents(uuid, text[], interval, interval, interval) to authenticated, service_role;

-- Open sessions by repo key (the function above), and a team's summaries and
-- activities by repo key (the status's latest update, ?repo= on Updates and Feed).
create index if not exists sessions_repo_open_idx on public.sessions (repo_key)
  where repo_key is not null and status = 'open' and ended_at is null;
create index if not exists turn_summaries_team_repo_idx on public.turn_summaries (team_id, repo_key, created_at desc, id desc)
  where repo_key is not null;
create index if not exists activities_team_repo_idx on public.activities (team_id, repo_key, published_at desc, id desc)
  where repo_key is not null;
