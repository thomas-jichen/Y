/**
 * Presence refresh (PLAN §9 Reachability). The rule is SQL
 * (`y_private.derive_presence`, 0010_presence.sql); this module runs
 * `api.refresh_agent_presence` with the deployment's windows and publishes
 * one `presence` event {agentId, presence} per actual change, to the owner
 * and every member of the owner's teams (user ids only, no agent audience: I3).
 *
 * Callers: the pulse heartbeat and ingest (one agent, fail-open) and the
 * self-rescheduling `presence_sweep` job (every agent that may have changed).
 */
import type { Tx } from '@y/db';
import { PRESENCE_SWEEP_EVERY_MS, presenceWindows, recurringSlot } from '@y/domain';
import type { Presence } from '@y/schema';
import type { CoreDeps, JobHandler } from '../contracts.js';
import { usesRealtimeDoorbell } from './realtime-channel.js';

export interface PresenceChange {
  agentId: string;
  ownerUserId: string;
  presence: Presence;
}

/** The owner plus every member of the owner's teams (presence is team-only). */
export async function presenceAudience(tx: Tx, ownerUserId: string): Promise<string[]> {
  const r = await tx.query<{ user_id: string }>(
    `select distinct m2.user_id from public.team_members m1
       join public.team_members m2 on m2.team_id = m1.team_id
      where m1.user_id = $1 limit 1000`,
    [ownerUserId],
  );
  return [...new Set([ownerUserId, ...r.rows.map((x) => x.user_id)])];
}

/**
 * Recompute stored presence for `agentIds` (null = sweep) and publish an event
 * for each change. Returns the changes. Service role: the refresh writes
 * agent_presence for agents the caller may not own (a sweep).
 */
export async function refreshPresence(deps: CoreDeps, agentIds: readonly string[] | null): Promise<PresenceChange[]> {
  if (agentIds && agentIds.length === 0) return [];
  // The listening window follows the transport agents were handed (doorbell vs long-poll), not core's run mode.
  const { liveMs, listeningMs, ingestLiveMs } = presenceWindows({ doorbell: usesRealtimeDoorbell(deps.config) });
  return deps.db.asService(async (tx) => {
    const r = await tx.query<{ agent_id: string; owner_user_id: string; presence: Presence }>(
      `select agent_id, owner_user_id, presence
         from api.refresh_agent_presence($1::uuid[], $2::int * interval '1 millisecond', $3::int * interval '1 millisecond',
                                         $4::int * interval '1 millisecond')`,
      [agentIds ? [...new Set(agentIds)] : null, liveMs, listeningMs, ingestLiveMs],
    );
    const changes = r.rows.map((row) => ({ agentId: row.agent_id, ownerUserId: row.owner_user_id, presence: row.presence }));
    for (const ch of changes) {
      await deps.bus.publish(
        {
          type: 'presence',
          audienceAgentIds: [],
          audienceUserIds: await presenceAudience(tx, ch.ownerUserId),
          payload: { agentId: ch.agentId, presence: ch.presence },
        },
        tx,
      );
    }
    return changes;
  });
}

/** refreshPresence for one agent on a request path: never fails the request. */
export async function refreshAgentPresence(deps: CoreDeps, agentId: string): Promise<void> {
  try {
    await refreshPresence(deps, [agentId]);
  } catch (e) {
    deps.log('warn', 'presence refresh failed', { err: e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : 'unknown' });
  }
}

/** Job: sweep every agent whose presence may have changed (stale ones decay to away), then re-arm. */
export const presenceSweep: JobHandler = async (_payload, deps) => {
  await refreshPresence(deps, null);
  await schedulePresenceSweep(deps);
};

/** Arm the next sweep, due just before the next minute tick (deduped per slot, like close_idle). */
export async function schedulePresenceSweep(deps: CoreDeps): Promise<void> {
  const { slot, runAfterMs } = recurringSlot(deps.now().getTime(), PRESENCE_SWEEP_EVERY_MS);
  await deps.jobs.enqueue('presence_sweep', {}, { dedupeKey: `presence_sweep:${slot}`, runAfterMs });
}
