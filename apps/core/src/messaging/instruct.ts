/**
 * Owner instructions (PLAN §9, P4) from the web or a linked Slack user.
 * Ownership and `remote_instructions` are checked under the human's RLS;
 * core signs (Ed25519, y-oi-v1, covering `verified_via`) and stores the row
 * as the service role (the signature covers created_at, which the
 * authenticated insert grant lacks). Push events carry ids only (I3).
 */
import type { AuthClaims, Tx } from '@y/db';
import { pickLeaseSession, type LeaseCandidate } from '@y/domain';
import { ulid, type InstructResponse } from '@y/schema';
import type { CoreDeps } from '../contracts.js';
import { signOwnerInstruction } from './signing.js';
import { HttpError, wire } from './util.js';

export interface InstructTarget { agentId: string; handle: string; remoteOn: boolean; unattended: boolean }

/** The caller's own agents in a thread (asUser tx). `unattended` = a bypassPermissions/codex_never lease. */
export async function ownInstructTargets(tx: Tx, userId: string, threadId: string): Promise<InstructTarget[]> {
  const r = await tx.query<{ agent_id: string; handle: string; remote_instructions: boolean; unattended: boolean }>(
    `select a.id as agent_id, a.handle::text as handle, coalesce(s.remote_instructions, false) as remote_instructions,
            exists (select 1 from public.session_leases l where l.agent_id = a.id
                     and l.permission_mode in ('bypassPermissions', 'codex_never')) as unattended
       from public.thread_participants p join public.agents a on a.id = p.p_id
       left join public.agent_settings s on s.agent_id = a.id
      where p.thread_id = $1 and p.p_kind = 'agent' and a.owner_user_id = $2`, [threadId, userId]);
  return r.rows.map((x) => ({ agentId: x.agent_id, handle: x.handle, remoteOn: x.remote_instructions, unattended: x.unattended }));
}

/**
 * Sign, store and announce one owner instruction. Without `agentId` the
 * first of the caller's agents in the thread is the target (web). With
 * `confirmNow`, the owner's confirm (an unattended agent's requires_confirm)
 * is recorded in the same call: the caller already saw the warning and
 * clicked (Slack Confirm).
 */
export async function issueOwnerInstruction(
  deps: CoreDeps,
  a: { userId: string; claims: AuthClaims; threadId: string; agentId?: string; body: string; via: 'web' | 'slack'; confirmNow?: boolean },
): Promise<InstructResponse & { agentId: string; handle: string }> {
  const target = await deps.db.asUser(a.claims, async (tx) => {
    const all = await ownInstructTargets(tx, a.userId, a.threadId);
    return a.agentId ? all.find((t) => t.agentId === a.agentId) : all[0];
  });
  if (!target) throw new HttpError('SCOPE_FORBIDDEN', 'you do not own an agent in this thread');
  if (!target.remoteOn) {
    throw new HttpError('SCOPE_FORBIDDEN', 'remote instructions are off for this agent', {
      next: { humanAction: 'grant_permission', url: `${deps.config.publicUrl}/settings/remote-instructions` },
    });
  }
  const id = ulid();
  const createdAt = deps.now().toISOString();
  const wireId = wire('ownerInstruction', id);
  const signed = signOwnerInstruction(deps.config, {
    id: wireId, agent_id: target.agentId, thread_id: wire('thread', a.threadId), body: a.body, verified_via: a.via, created_at: createdAt,
  });
  // Stored by core (it holds the signing key) after the ownership checks above.
  const { unattended, requiresConfirm } = await deps.db.asService(async (tx) => {
    const ins = await tx.query<{ requires_confirm: boolean }>(
      `insert into public.owner_instructions (id, agent_id, thread_id, created_by_user_id, body, verified_via, kid, sig, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning requires_confirm`,
      [id, target.agentId, a.threadId, a.userId, a.body, a.via, signed.kid, signed.sig, createdAt]);
    const leases = await tx.query<{ session_id: string; listening: string; last_heartbeat_at: Date | string; permission_mode: string; headless: boolean; last_thread_ids: string[] }>(
      `select session_id, listening, last_heartbeat_at, permission_mode, headless, last_thread_ids from public.session_leases where agent_id = $1`, [target.agentId]);
    const cands: LeaseCandidate[] = leases.rows.map((l) => ({
      sessionId: l.session_id, listening: l.listening !== 'none', needsApproval: l.listening === 'listening_needs_approval',
      lastHeartbeatAt: new Date(l.last_heartbeat_at).getTime(), lastThreadIds: l.last_thread_ids ?? [],
      permissionMode: l.permission_mode as LeaseCandidate['permissionMode'], headless: l.headless,
    }));
    const requiresConfirm = ins.rows[0]?.requires_confirm === true;
    if (cands.length === 0) return { unattended: false, requiresConfirm };
    const attended = pickLeaseSession(cands, { now: deps.now().getTime(), kind: 'owner_instruction', threadId: a.threadId });
    const any = pickLeaseSession(cands, { now: deps.now().getTime(), kind: 'owner_instruction', threadId: a.threadId, ownerConfirmed: true });
    return { unattended: attended === null && any !== null, requiresConfirm };
  });
  let confirmed = false;
  if (a.confirmNow && requiresConfirm) {
    // RLS owner_instructions_confirm + the guard trigger: a human, the owner, once.
    confirmed = await deps.db.asUser(a.claims, async (tx) => {
      const r = await tx.query(
        `update public.owner_instructions set confirmed_at = now(), confirmed_via = $2
          where id = $1 and requires_confirm and confirmed_at is null`, [id, a.via]);
      return r.rowCount > 0;
    });
  }
  await deps.bus.publish({ type: 'owner_instruction.new', audienceAgentIds: [target.agentId], audienceUserIds: [a.userId],
    payload: { ownerInstructionId: wireId, threadId: wire('thread', a.threadId) } });
  const state: InstructResponse['state'] = unattended && !confirmed ? 'awaiting_confirm' : 'queued';
  return { id: wireId as InstructResponse['id'], state, agentId: target.agentId, handle: target.handle };
}
