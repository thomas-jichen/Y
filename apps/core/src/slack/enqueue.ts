/**
 * Hooks other modules call inside their transaction to queue Slack work.
 * No-ops when Slack is not configured. Payloads carry ids only.
 */
import type { Tx } from '@y/db';
import type { CoreDeps } from '../contracts.js';
import { slackEnabled } from './config.js';

export interface MessageNoticeInput {
  messageId: string;
  threadId: string;
  threadKind: string;
  senderKind: 'agent' | 'user' | 'system';
  senderId: string | null;
  senderOwnerId: string | null;
  /** Owners of the agents the message was delivered to. */
  recipientOwnerIds: readonly string[];
}

/** Room = a group thread, or agents from more than two owners. */
export async function threadIsRoom(tx: Tx, threadId: string, threadKind: string): Promise<boolean> {
  if (threadKind === 'group') return true;
  const r = await tx.query<{ n: number }>(
    `select count(distinct owner_user_id)::int as n from public.thread_participants where thread_id = $1 and p_kind = 'agent'`, [threadId]);
  return (r.rows[0]?.n ?? 0) > 2;
}

/**
 * Queue one `slack.notify_message` per linked owner who should hear about a
 * delivered message: recipient agents' owners and the thread's human
 * participants, never the human author, and never the sending agent's owner
 * unless they are a human participant of a non-room thread (their own DM).
 */
export async function enqueueMessageNotices(tx: Tx, deps: CoreDeps, m: MessageNoticeInput): Promise<void> {
  if (!slackEnabled(deps.config)) return;
  const humans = await tx.query<{ owner_user_id: string }>(
    `select owner_user_id from public.thread_participants where thread_id = $1 and p_kind = 'user'`, [m.threadId]);
  const humanIds = new Set(humans.rows.map((h) => h.owner_user_id));
  const isRoom = await threadIsRoom(tx, m.threadId, m.threadKind);
  const cands = new Set<string>([...m.recipientOwnerIds, ...humanIds]);
  if (m.senderKind === 'user' && m.senderId) cands.delete(m.senderId);
  if (m.senderKind === 'agent' && m.senderOwnerId && !(humanIds.has(m.senderOwnerId) && !isRoom)) cands.delete(m.senderOwnerId);
  if (cands.size === 0) return;
  const r = await tx.query<{ user_id: string }>(
    `select l.user_id from public.slack_identity_links l join public.notification_prefs p using (user_id)
      where l.user_id = any($1::uuid[]) and l.revoked_at is null and p.channels -> 'slack' = 'true'::jsonb
        and coalesce(p.kinds ->> 'dm', 'true') <> 'false'`, [[...cands]]);
  for (const row of r.rows) {
    await deps.jobs.enqueue('slack.notify_message', { userId: row.user_id, threadId: m.threadId, messageId: m.messageId },
      { dedupeKey: `slack:m:${m.messageId}:${row.user_id}`, tx });
  }
}

/** Queue the team feed card for a published team activity (when the team has a feed channel). */
export async function enqueueFeedCard(tx: Tx, deps: CoreDeps, activityId: string, teamId: string): Promise<void> {
  if (!slackEnabled(deps.config)) return;
  const r = await tx.query(`select 1 from public.team_slack_channels where team_id = $1`, [teamId]);
  if (r.rowCount === 0) return;
  await deps.jobs.enqueue('slack.feed_activity', { activityId }, { dedupeKey: `slack:feed:${activityId}`, tx });
}
