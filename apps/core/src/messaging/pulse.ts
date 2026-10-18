/**
 * Listener long-poll: GET /api/v1/pulse?cursor&wait and POST /api/v1/pulse/ack.
 * Heartbeats the session lease, waits on the bus, and returns a wake only
 * when a wake-worthy event targets THIS session (pickLeaseSession) and the
 * wake budget allows it. The wake carries a pointer template only (I3).
 */
import type { App, CoreDeps, PushEvent } from '../contracts.js';
import { LEASE_STALE_MS, pickLeaseSession, wakeBudget, type LeaseCandidate } from '@paceline/domain';
import { HarnessSessionId, PulseQuery, WakeAck, makePointer, validationError, type PulseResponse } from '@paceline/schema';
import { HttpError, agentInfos, errorResponse, killSwitches, requireAgent, requireCaller, unreadCounts } from './util.js';

const SESSION_HEADER = 'x-paceline-session';

interface LeaseRow {
  session_id: string; listening: string; last_heartbeat_at: Date | string; repo_key: string | null;
  last_thread_ids: string[]; permission_mode: string; headless: boolean;
}

function toCandidate(r: LeaseRow): LeaseCandidate {
  const c: LeaseCandidate = {
    sessionId: r.session_id,
    listening: r.listening !== 'none',
    needsApproval: r.listening === 'listening_needs_approval',
    lastHeartbeatAt: new Date(r.last_heartbeat_at).getTime(),
    lastThreadIds: r.last_thread_ids ?? [],
    permissionMode: r.permission_mode as LeaseCandidate['permissionMode'],
    headless: r.headless,
  };
  if (r.repo_key) c.repoKey = r.repo_key;
  return c;
}

/** Wake decision for the events this poll received. Returns a pointer only if this session is the target. */
async function wakeFor(deps: CoreDeps, agentId: string, ownerUserId: string, sessionId: string, events: PushEvent[], claims: Parameters<CoreDeps['db']['asUser']>[0]) {
  const wakeEvents = events.filter((e) => (e.type === 'message.new' && e.payload.wake === true) || e.type === 'owner_instruction.new');
  if (wakeEvents.length === 0) return undefined;
  const now = deps.now().getTime();
  const leases = await deps.db.asUser(claims, (tx) => tx.query<LeaseRow>(
    `select session_id, listening, last_heartbeat_at, repo_key, last_thread_ids, permission_mode, headless
       from public.session_leases where agent_id = $1 and last_heartbeat_at > now() - ($2::int * interval '1 millisecond')`,
    [agentId, LEASE_STALE_MS]));
  const candidates = leases.rows.map(toCandidate);

  for (const ev of wakeEvents) {
    const threadWire = typeof ev.payload.threadId === 'string' ? ev.payload.threadId : undefined;
    const isOi = ev.type === 'owner_instruction.new';
    const ctx: Parameters<typeof pickLeaseSession>[1] = { now, kind: isOi ? 'owner_instruction' : 'dm' };
    if (threadWire) ctx.threadId = threadWire.replace(/^t_/, '');
    const target = pickLeaseSession(candidates, ctx);
    if (target !== sessionId) continue;

    const messageWire = typeof ev.payload.messageId === 'string' ? ev.payload.messageId : null;
    const senderAgentId = typeof ev.payload.senderAgentId === 'string' ? ev.payload.senderAgentId : null;
    const decision = await deps.db.asService(async (tx) => {
      if (messageWire) {
        const seen = await tx.query(`select 1 from public.wake_ledger where recipient_agent_id = $1 and message_id = $2`, [agentId, messageWire.replace(/^m_/, '')]);
        if (seen.rowCount > 0) return null; // already woken for this message
      }
      const ledger = await tx.query<{ at: Date | string; sender_agent_id: string | null }>(
        `select at, sender_agent_id from public.wake_ledger where (recipient_agent_id = $1 or sender_agent_id = $2) and outcome = 'woken'
           and at > now() - interval '1 day'`, [agentId, senderAgentId]);
      const qh = await tx.query<{ quiet_hours: unknown }>(`select quiet_hours from public.agent_settings where agent_id = $1`, [agentId]);
      const budget = wakeBudget(
        ledger.rows.map((l) => ({ at: new Date(l.at).getTime(), recipientAgentId: agentId, senderAgentId: l.sender_agent_id ?? '' })),
        { at: now, recipientAgentId: agentId, senderAgentId: senderAgentId ?? '', quietHours: (qh.rows[0]?.quiet_hours ?? null) as null },
      );
      const outcome = budget.allow ? 'woken' : budget.reason === 'coalesced' ? 'coalesced' : budget.reason === 'quiet_hours' ? 'quiet_hours' : 'over_budget';
      await tx.query(
        `insert into public.wake_ledger (recipient_agent_id, sender_agent_id, message_id, outcome) values ($1, $2, $3, $4)`,
        [agentId, senderAgentId, messageWire ? messageWire.replace(/^m_/, '') : null, outcome]);
      return budget.allow;
    });
    if (!decision) continue;

    const counts = await deps.db.asService((tx) => unreadCounts(tx, agentId, ownerUserId));
    if (isOi) {
      return { targetSessionId: sessionId, pointer: makePointer('P4', { count: Math.max(1, Math.min(999, counts.ownerInstructions)) }) };
    }
    const params: { count: number; handle?: string } = { count: Math.max(1, Math.min(999, counts.dm)) };
    if (senderAgentId) {
      const info = (await deps.db.asService((s) => agentInfos(s, [senderAgentId]))).get(senderAgentId);
      if (info) params.handle = `@${info.handle}`;
    }
    return { targetSessionId: sessionId, pointer: makePointer('P1', params) };
  }
  return undefined;
}

export function registerPulse(app: App, deps: CoreDeps): void {
  app.get('/api/v1/pulse', async (c) => {
    try {
      const caller = await requireCaller(deps, c.req.header('authorization'));
      const agentId = requireAgent(caller);
      const q = PulseQuery.safeParse(c.req.query());
      if (!q.success) return c.json(validationError(q.error), 400);
      const sid = HarnessSessionId.safeParse(c.req.header(SESSION_HEADER) ?? q.data.sessionId);
      if (!sid.success) throw new HttpError('VALIDATION', 'X-Paceline-Session header (harness session id) is required');
      const sessionId = sid.data;

      // Heartbeat: this session is listening.
      await deps.db.asUser(caller.claims, (tx) => tx.query(
        `insert into public.session_leases (agent_id, session_id, install_id, listening, last_heartbeat_at)
         values ($1, $2, $3, 'listening', now())
         on conflict (agent_id, session_id) do update set listening = 'listening', last_heartbeat_at = now(), updated_at = now(),
           install_id = coalesce(excluded.install_id, public.session_leases.install_id)`,
        [agentId, sessionId, caller.installId]));

      const waitMs = q.data.wait * 1000;
      const { events, cursor } = await deps.bus.waitForAgent(agentId, q.data.cursor ?? null, waitMs);
      const wake = await wakeFor(deps, agentId, caller.userId, sessionId, events, caller.claims);
      const { unread, ks } = await deps.db.asUser(caller.claims, async (tx) => ({
        unread: await unreadCounts(tx, agentId, caller.userId),
        ks: await killSwitches(tx),
      }));
      const res: PulseResponse = {
        cursor: cursor ?? q.data.cursor ?? '0',
        unread,
        approvedChanges: [],
        killSwitches: ks,
      };
      if (wake && !ks.pushPaths) res.wake = wake;
      return c.json(res);
    } catch (err) {
      return errorResponse(c, err, deps);
    }
  });

  app.post('/api/v1/pulse/ack', async (c) => {
    try {
      const caller = await requireCaller(deps, c.req.header('authorization'));
      const agentId = requireAgent(caller);
      const body = WakeAck.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json(validationError(body.error), 400);
      // The woken session acked: mark its pending wake deliveries as pointer_sent.
      await deps.db.asService((tx) => tx.query(
        `update public.message_deliveries set state = 'pointer_sent', pointer_sent_at = now(), target_session_id = $2, updated_at = now()
          where recipient_agent_id = $1 and path = 'wake' and state = 'pending'`,
        [agentId, body.data.sessionId]));
      return c.json({ ok: true });
    } catch (err) {
      return errorResponse(c, err, deps);
    }
  });
}
