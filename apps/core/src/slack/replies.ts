/**
 * Replies from Slack (spec §8): the `slack.event` job. A reply in a bridged
 * Slack thread becomes either a human comment (threads with other owners'
 * agents or other humans) or, for a thread with only the replier's own
 * agents, a pending owner instruction that exists only after the Confirm
 * click (I5). Unlinked users and non-participants get an ephemeral notice.
 */
import { CommentRequest } from '@y/schema';
import type { JobHandler } from '../contracts.js';
import { postHumanComment } from '../messaging/comment.js';
import { ownInstructTargets } from '../messaging/instruct.js';
import { HttpError } from '../messaging/util.js';
import { PENDING_TTL_MS, slackClaims, webUrl } from './config.js';
import { linkedUserFor } from './identity.js';
import { EventJob } from './payloads.js';
import * as R from './render.js';
import { slackJob, type SlackCtx } from './shared.js';

const INSTRUCT_PREFIX = /^\s*instruct\s*:\s*/i;

export function replyJobs(ctx: SlackCtx): Record<string, JobHandler> {
  return {
    'slack.event': slackJob(ctx, async (payload, deps, client) => {
      const p = EventJob.safeParse(payload);
      if (!p.success) { deps.log('warn', 'slack.event: bad payload'); return; }
      const ev = p.data;
      const now = deps.now();
      const ephemeral = (text: string) => client.postEphemeral({ channel: ev.channel, user: ev.user, text, threadTs: ev.threadTs });

      // Opportunistic purge, then the bridge (no bridge: not ours, stay silent).
      const bridge = await deps.db.asService(async (tx) => {
        await tx.query(`delete from public.slack_pending_instructions where created_at < $1::timestamptz - interval '1 day'`, [now.toISOString()]);
        await tx.query(`update public.slack_pending_instructions set state = 'expired', body = null, decided_at = $1
                         where state = 'pending' and expires_at < $1`, [now.toISOString()]);
        const b = await tx.query<{ thread_id: string }>(
          `select thread_id from public.thread_bridges where slack_team_id = $1 and channel_id = $2 and thread_ts = $3`,
          [ev.teamId, ev.channel, ev.threadTs]);
        const uid = await linkedUserFor(tx, ev.teamId, ev.user);
        return b.rows[0] ? { threadId: b.rows[0].thread_id, uid } : null;
      });
      if (!bridge) return;
      if (ev.tooLong) { await ephemeral(R.E3); return; }
      const { threadId, uid } = bridge;
      if (!uid) { await ephemeral(R.E1); return; }

      let body = R.slackToPlain(ev.text);
      const explicit = INSTRUCT_PREFIX.test(body);
      if (explicit) body = body.replace(INSTRUCT_PREFIX, '').trim();
      const parsed = CommentRequest.safeParse({ body });
      if (!parsed.success) { await ephemeral(R.E3); return; }
      body = parsed.data.body;

      const claims = slackClaims(uid);
      // Participation under the linked user's RLS: a non-participant sees no thread row.
      const view = await deps.db.asUser(claims, async (tx) => {
        const t = (await tx.query<{ id: string }>(`select id from public.threads where id = $1`, [threadId])).rows[0];
        if (!t) return null;
        const parts = (await tx.query<{ p_kind: string; p_id: string; owner_user_id: string }>(
          `select p_kind, p_id, owner_user_id from public.thread_participants where thread_id = $1`, [threadId])).rows;
        const ownAgents = parts.filter((x) => x.p_kind === 'agent' && x.owner_user_id === uid);
        const others = parts.filter((x) => (x.p_kind === 'agent' && x.owner_user_id !== uid) || (x.p_kind === 'user' && x.p_id !== uid));
        const isHuman = parts.some((x) => x.p_kind === 'user' && x.p_id === uid);
        const targets = ownAgents.length ? await ownInstructTargets(tx, uid, threadId) : [];
        return { isParticipant: isHuman || ownAgents.length > 0, ownAgents: ownAgents.length, others: others.length, targets };
      });
      if (!view || !view.isParticipant) { await ephemeral(R.E2); return; }

      const instructMode = view.ownAgents > 0 && (view.others === 0 || explicit);
      if (!instructMode) {
        try {
          const res = await postHumanComment(deps, { userId: uid, claims, threadId, body, idempotencyKey: `slack:${ev.eventId}` });
          if (res.state === 'quarantined' || res.state === 'held_for_sender') await ephemeral(R.E5);
          else if (res.state === 'rejected' || res.state === 'blocked') await ephemeral(R.e4('DM_NOT_PERMITTED'));
        } catch (e) {
          if (e instanceof HttpError) { await ephemeral(R.e4(e.code)); return; }
          throw e;
        }
        return;
      }

      const on = view.targets.filter((t) => t.remoteOn);
      if (on.length === 0) { await ephemeral(R.e6(view.targets[0]?.handle ?? null, webUrl(deps.config))); return; }
      const pendingId = await deps.db.asService(async (tx) => {
        const r = await tx.query<{ id: string }>(
          `insert into public.slack_pending_instructions
             (user_id, thread_id, slack_team_id, slack_user_id, channel_id, thread_ts, source_event_id, body, created_at, expires_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           on conflict (source_event_id) do nothing returning id`,
          [uid, threadId, ev.teamId, ev.user, ev.channel, ev.threadTs, ev.eventId, body, now.toISOString(), new Date(now.getTime() + PENDING_TTL_MS).toISOString()]);
        return r.rows[0]?.id ?? null;
      });
      if (!pendingId) return;
      // Nothing reaches the agent until Confirm is clicked.
      const unattended = on.find((t) => t.unattended)?.handle ?? null;
      await client.postMessage({
        channel: ev.channel, threadTs: ev.threadTs,
        ...R.p1({ pendingId, targets: on.slice(0, 5).map((t) => ({ agentId: t.agentId, handle: t.handle })), body, unattended }),
      });
    }),
  };
}
