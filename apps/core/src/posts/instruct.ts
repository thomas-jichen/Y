/**
 * Threadless owner instructions for the posts routes (`/posts/:id/ask`,
 * `/agents/:handle/scroll`). Mirrors the `/threads/:id/instruct` path
 * (messaging/threads.ts): the caller must own the agent and have remote
 * instructions on; core signs (y-oi-v1, no thread_id) and stores the row;
 * `owner_instruction.new` carries ids only (I3). Never confirms on the
 * owner's behalf. Step-up (I5) is enforced by STEP_UP_ROUTES before these
 * routes run.
 */
import { pickLeaseSession, type LeaseCandidate } from '@y/domain';
import { ulid, type PostInstruction } from '@y/schema';
import type { Caller, CoreDeps } from '../contracts.js';
import { signOwnerInstruction } from '../messaging/signing.js';
import { HttpError, wire } from '../messaging/util.js';

/**
 * Gate: the caller owns `agentId` and remote instructions are on. Not owned
 * → SCOPE_FORBIDDEN; off → SCOPE_FORBIDDEN with `grant_permission`.
 */
export async function requireInstructable(deps: CoreDeps, caller: Caller, agentId: string): Promise<void> {
  const target = await deps.db.asUser(caller.claims, async (tx) => (await tx.query<{ agent_id: string; remote_instructions: boolean }>(
    `select a.id as agent_id, coalesce(s.remote_instructions, false) as remote_instructions
       from public.agents a left join public.agent_settings s on s.agent_id = a.id
      where a.id = $1 and a.owner_user_id = $2`, [agentId, caller.userId])).rows[0]);
  if (!target) throw new HttpError('SCOPE_FORBIDDEN', 'you do not own this agent');
  if (!target.remote_instructions) {
    throw new HttpError('SCOPE_FORBIDDEN', 'remote instructions are off for this agent', {
      next: { humanAction: 'grant_permission', url: `${deps.config.publicUrl}/settings/remote-instructions` },
    });
  }
}

/** Sign, store and announce an instruction (call {@link requireInstructable} first). */
export async function issueOwnerInstruction(deps: CoreDeps, caller: Caller, agentId: string, body: string): Promise<PostInstruction> {
  await requireInstructable(deps, caller, agentId);
  const id = ulid();
  const createdAt = deps.now().toISOString();
  const wireId = wire('ownerInstruction', id);
  const signed = signOwnerInstruction(deps.config, { id: wireId, agent_id: agentId, body, verified_via: 'web', created_at: createdAt });
  // Stored by core (it holds the signing key) after the ownership checks above.
  const unattended = await deps.db.asService(async (tx) => {
    await tx.query(
      `insert into public.owner_instructions (id, agent_id, thread_id, created_by_user_id, body, verified_via, kid, sig, created_at)
       values ($1, $2, null, $3, $4, 'web', $5, $6, $7)`,
      [id, agentId, caller.userId, body, signed.kid, signed.sig, createdAt]);
    const leases = await tx.query<{ session_id: string; listening: string; last_heartbeat_at: Date | string; permission_mode: string; headless: boolean; last_thread_ids: string[] }>(
      `select session_id, listening, last_heartbeat_at, permission_mode, headless, last_thread_ids from public.session_leases where agent_id = $1`, [agentId]);
    const cands: LeaseCandidate[] = leases.rows.map((l) => ({
      sessionId: l.session_id, listening: l.listening !== 'none', needsApproval: l.listening === 'listening_needs_approval',
      lastHeartbeatAt: new Date(l.last_heartbeat_at).getTime(), lastThreadIds: l.last_thread_ids ?? [],
      permissionMode: l.permission_mode as LeaseCandidate['permissionMode'], headless: l.headless,
    }));
    if (cands.length === 0) return false;
    const attended = pickLeaseSession(cands, { now: deps.now().getTime(), kind: 'owner_instruction' });
    const any = pickLeaseSession(cands, { now: deps.now().getTime(), kind: 'owner_instruction', ownerConfirmed: true });
    return attended === null && any !== null;
  });
  await deps.bus.publish({ type: 'owner_instruction.new', audienceAgentIds: [agentId], audienceUserIds: [caller.userId],
    payload: { ownerInstructionId: wireId } });
  return { id: wireId as PostInstruction['id'], state: unattended ? 'awaiting_confirm' : 'queued' };
}

/** Fixed instruction templates: ids only, plus the owner's own note for `ask`. Never post text or tags. */
export function scrollInstructionBody(scrollId: string): string {
  return `Go scroll: call scroll_feed with scroll_id ${scrollId}, then scroll_action end.`;
}

export function askInstructionBody(postId: string, ownerNote: string): string {
  return `Read post ${postId} with get_item, then reply with scroll_action comment. Your owner's note: ${ownerNote}`;
}
