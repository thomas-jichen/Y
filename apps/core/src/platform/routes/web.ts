/** Web JSON API (docs/UI.md §4, packages/schema web.ts). Human callers, RLS via db.asUser. */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { randomUUID } from 'node:crypto';
import { isSqlState } from '@y/db';
import {
  DECISIONS_BY_KIND,
  DecisionRequest,
  FeedQuery,
  INTRO_MAX,
  RemoteInstructionsSetting,
  ReviewListQuery,
  STREAM_HEARTBEAT_S,
  ThreadDetail,
  toStreamEvent,
  type DmRequestReview,
  type DraftReview,
  type FeedPage,
  type Me,
  type QuarantinedMessageReview,
  type ReviewItem,
  type ReviewKind,
} from '@y/schema';
import type { Caller, CoreDeps, PushEvent } from '../../contracts.js';
import { authenticate, bearerFrom } from '../http.js';
import { takeToken, type BucketSpec } from '../rate-limit.js';
import { loadActivities, reviewItemsFromRows } from '../mappers.js';
import { realtimeChannelFor } from '../realtime-channel.js';
import { requireRecentLogin } from '../web-guard.js';
import { decideReviewTx } from '../review-decide.js';
import { l0Scan, normalizeUntrusted } from '@y/safety';
import { agentInfos, agentRef } from '../../messaging/util.js';
import { builderReplyDetail } from '../../messaging/threads.js';
import { bareId, fail, iso, num, parseOr, readJson, sha256Hex } from '../util.js';

const PAGE = 20;

/**
 * Limits of GET /api/v1/stream. Exported so tests can tighten them.
 * - maxPerUser: open streams per user in this process (#85); more get RATE_LIMITED. A stream that
 *   has not looped for 3 heartbeats no longer counts, so a leaked entry can't lock a user out.
 * - maxTotal: open streams in this process across all users (#85), so minting many accounts
 *   can't open unbounded streams (and serverless pollers, which are at most one per stream).
 * - connect: token bucket on stream connects per user, shared by every instance (api.take_token),
 *   so open/close churn and Last-Event-ID replays can't hammer the DB. The web client reconnects
 *   at most about once a second and falls back to polling after three refusals.
 * - reauthMs: how often an open stream re-checks its caller (#83): a bearer (header or y_session
 *   cookie) is verified again and the user must still be active; otherwise the stream ends
 *   (EventSource reconnects and re-authenticates).
 * - replayMax: Last-Event-ID replay reads at most this many missed events in one query (#47). When
 *   it is reached the stream sends `event: resync` after the replayed events and ends, so the
 *   client reconnects from the last replayed id (or refetches) instead of silently missing events.
 */
export const STREAM_LIMITS: { maxPerUser: number; maxTotal: number; connect: BucketSpec; reauthMs: number; replayMax: number } = {
  maxPerUser: 20,
  maxTotal: 2000,
  connect: { rate: 1 / 2, burst: 60 },
  reauthMs: 5 * 60_000,
  replayMax: 1000,
};
/** Open streams per deps (one app) → user → stream → last loop time (ms). */
const openStreams = new WeakMap<CoreDeps, Map<string, Map<symbol, number>>>();
/** Streams this app counts as open (all users). For tests and diagnostics. */
export function openStreamCount(deps: CoreDeps): number {
  let n = 0;
  for (const slots of openStreams.get(deps)?.values() ?? []) n += slots.size;
  return n;
}

/**
 * Feed cursors carry published_at at full (microsecond) precision: a JS Date keeps only
 * milliseconds, which skipped rows published in the boundary millisecond (#84). Cursors minted
 * before this (millisecond ISO) still decode.
 */
function encodeCursor(publishedAt: unknown, id: string): string {
  const at = typeof publishedAt === 'string' && publishedAt ? publishedAt : iso(publishedAt);
  return Buffer.from(`${at}|${id}`).toString('base64url');
}
function decodeCursor(cursor: string): { at: string; id: string } | null {
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!at || !id || Number.isNaN(Date.parse(at)) || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return null;
    return { at, id };
  } catch {
    return null;
  }
}

export function registerWebRoutes(app: Hono, deps: CoreDeps): void {
  /* -------------------------------------------------------------------- me */
  app.get('/api/v1/me', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const me = await deps.db.asUser(caller.claims, async (tx): Promise<Me | null> => {
      const u = (await tx.query<Record<string, unknown>>('select * from public.users where id = $1', [caller.userId])).rows[0];
      if (!u) return null;
      const agents = await tx.query<Record<string, unknown>>(
        `select a.id, a.handle, a.harness, coalesce(p.presence, 'away') as presence
           from public.agents a left join public.agent_presence p on p.agent_id = a.id
          where a.owner_user_id = $1 order by a.created_at limit 20`,
        [caller.userId],
      );
      const teams = await tx.query<Record<string, unknown>>(
        `select t.id, t.slug, t.name, m.role from public.team_members m join public.teams t on t.id = m.team_id
          where m.user_id = $1 order by m.joined_at limit 50`,
        [caller.userId],
      );
      const realtime = await realtimeChannelFor(tx, deps.config, 'user', caller.userId);
      const login = typeof u.github_login === 'string' && u.github_login ? u.github_login : String(u.handle);
      const owner = { id: caller.userId, login, handle: `@${u.handle as string}`, avatarUrl: String(u.avatar_url ?? '') };
      return {
        user: owner,
        agents: agents.rows.map((a) => ({
          id: a.id as string,
          handle: `@${a.handle as string}`,
          harness: a.harness as Me['agents'][number]['harness'],
          owner,
          presence: a.presence as Me['agents'][number]['presence'],
        })),
        teams: teams.rows.map((t) => ({ id: t.id as string, slug: t.slug as string, name: t.name as string, role: t.role as Me['teams'][number]['role'] })),
        ...(realtime ? { realtime } : {}),
      };
    });
    if (!me) return fail(c, 'NOT_FOUND', 'user not found');
    return c.json(me);
  });

  /* ------------------------------------------------------------------ feed */
  app.get('/api/v1/feed', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const q = parseOr(c, FeedQuery, c.req.query());
    if (!q.ok) return q.res;
    const cur = q.data.cursor ? decodeCursor(q.data.cursor) : null;
    if (q.data.cursor && !cur) return fail(c, 'VALIDATION', 'invalid cursor');
    const page = await deps.db.asUser(caller.claims, async (tx): Promise<FeedPage> => {
      const where: string[] = [`a.status = 'published'`];
      const params: unknown[] = [];
      if (cur) {
        params.push(cur.at, cur.id);
        where.push(`(a.published_at, a.id::text) < ($${params.length - 1}::timestamptz, $${params.length})`);
      }
      if (q.data.tab === 'highlights') {
        where.push(`exists (select 1 from public.highlights h where h.activity_id = a.id and h.status = 'active')`);
      } else if (q.data.tab === 'following') {
        params.push(caller.userId);
        where.push(`exists (select 1 from public.follows f where f.follower_user_id = $${params.length} and f.agent_id = a.agent_id)`);
      }
      params.push(PAGE + 1);
      const r = await tx.query<{ id: string; published_at: Date; cursor_at: string }>(
        `select a.id, a.published_at,
                to_char(a.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at
           from public.activities a where ${where.join(' and ')}
          order by a.published_at desc, a.id desc limit $${params.length}`,
        params,
      );
      const rows = r.rows.slice(0, PAGE);
      const acts = await loadActivities(tx, rows.map((x) => x.id), caller.userId);
      const last = rows[rows.length - 1];
      return {
        items: acts.map((activity) => ({ type: 'activity' as const, activity })),
        ...(r.rows.length > PAGE && last ? { nextCursor: encodeCursor(last.cursor_at, last.id) } : {}),
      };
    });
    return c.json(page);
  });

  /* ------------------------------------------------------------ activities */
  app.get('/api/v1/activities/:id', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const id = bareId('a', c.req.param('id'));
    if (!id) return fail(c, 'VALIDATION', 'expected an activity id (a_…)');
    const [act] = await deps.db.asUser(caller.claims, (tx) => loadActivities(tx, [id], caller.userId));
    if (!act) return fail(c, 'NOT_FOUND', 'activity not found');
    return c.json(act);
  });

  app.post('/api/v1/activities/:id/kudos', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const id = bareId('a', c.req.param('id'));
    if (!id) return fail(c, 'VALIDATION', 'expected an activity id (a_…)');
    const out = await deps.db.asUser(caller.claims, async (tx) => {
      const seen = await tx.query('select 1 from public.activities where id = $1', [id]);
      if (seen.rowCount === 0) return null;
      await tx.query('insert into public.kudos (activity_id, user_id) values ($1, $2) on conflict do nothing', [id, caller.userId]);
      const n = await tx.query<{ n: string | number }>('select count(*) as n from public.kudos where activity_id = $1', [id]);
      return { kudos: num(n.rows[0]?.n) };
    });
    if (!out) return fail(c, 'NOT_FOUND', 'activity not found');
    return c.json(out);
  });

  /* ---------------------------------------------------------------- review */
  app.get('/api/v1/review', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const q = parseOr(c, ReviewListQuery, c.req.query());
    if (!q.ok) return q.res;
    const items = await deps.db.asUser(caller.claims, async (tx) => {
      const r = await tx.query<Record<string, unknown>>(
        `select * from public.review_items where owner_user_id = $1 and ($2::text is null or kind = $2)
          order by (state = 'pending') desc, created_at desc limit 500`,
        [caller.userId, q.data.kind ?? null],
      );
      return reviewItemsFromRows(tx, r.rows);
    });
    return c.json(items);
  });

  app.get('/api/v1/review/:id', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const id = bareId('rv', c.req.param('id'));
    if (!id) return fail(c, 'VALIDATION', 'expected a review id (rv_…)');
    const detail = await deps.db.asUser(caller.claims, async (tx) => {
      const row = (await tx.query<Record<string, unknown>>('select * from public.review_items where id = $1', [id])).rows[0];
      if (!row) return { status: 404 as const };
      const [item] = await reviewItemsFromRows(tx, [row]);
      if (row.kind === 'dm_request' && item) return { status: 'dm' as const, item, mid: bareId('m', String(row.ref_id)) };
      if (row.kind === 'builder_reply' && item) return { status: 'builder' as const, item, mid: bareId('m', String(row.ref_id)) };
      if (row.kind === 'quarantined_message' && item) return { status: 'quarantined' as const, item, mid: bareId('m', String(row.ref_id)) };
      if (row.kind !== 'draft') return { status: 501 as const, kind: row.kind as string };
      const hid = bareId('h', String(row.ref_id));
      const h = hid
        ? (await tx.query<{ activity_id: string | null }>('select activity_id from public.highlights where id = $1', [hid])).rows[0]
        : undefined;
      const activityId = h?.activity_id ?? bareId('a', String(row.ref_id));
      const [activity] = activityId ? await loadActivities(tx, [activityId], caller.userId) : [];
      if (!activity || !item) return { status: 404 as const };
      const chunks = await tx.query<Record<string, unknown>>(
        `select digest_sha256, digest_bytes, redaction, received_at from public.activity_chunks where activity_id = $1 order by seq`,
        [activityId],
      );
      const hits: Record<string, number> = {};
      let dropped = false;
      let bytes = 0;
      let first: unknown = null;
      for (const ch of chunks.rows) {
        bytes += num(ch.digest_bytes);
        first ??= ch.received_at;
        const red = (ch.redaction ?? {}) as { hitsByRule?: Record<string, number>; dropped?: boolean };
        dropped ||= Boolean(red.dropped);
        for (const [k, v] of Object.entries(red.hitsByRule ?? {})) hits[k] = (hits[k] ?? 0) + num(v);
      }
      const lastSha = [...chunks.rows].reverse().find((x) => x.digest_sha256)?.digest_sha256;
      const draft: DraftReview & { highlightId?: string } = {
        item,
        activity,
        // Digests are purged once distilled (I6); the receipt remains.
        redactedDigest: '',
        receipt: {
          bytes,
          sha256: typeof lastSha === 'string' ? lastSha : sha256Hex(''),
          hitsByRule: hits,
          droppedDigest: dropped,
          deletesAt: new Date((first ? new Date(iso(first)).getTime() : deps.now().getTime()) + 24 * 3600_000).toISOString(),
        },
        fieldToggles: {},
        componentShareToggles: {},
        ...(hid ? { highlightId: `h_${hid}` } : {}),
      };
      return { status: 200 as const, out: draft };
    });
    if (detail.status === 'dm') {
      // A stranger's intro, shown only to the recipient's human (I4); the review row above was read under the owner's RLS.
      // The body is the sender's text: the UI renders it as untrusted.
      const mid = detail.mid;
      const intro = mid
        ? await deps.db.asService(async (s) => {
            const m = (
              await s.query<{ thread_id: string; sender_id: string | null; body: string }>(
                `select thread_id, sender_id, body from public.messages where id = $1 and sender_kind = 'agent'`,
                [mid],
              )
            ).rows[0];
            const from = m?.sender_id ? (await agentInfos(s, [m.sender_id])).get(m.sender_id) : undefined;
            return m && from ? { m, from } : null;
          })
        : null;
      if (!intro) return fail(c, 'NOT_FOUND', 'review item not found');
      const norm = normalizeUntrusted(intro.m.body).text;
      const out: DmRequestReview = {
        item: detail.item,
        from: agentRef(intro.from),
        trust: 'stranger',
        intro: norm.length > INTRO_MAX ? `${norm.slice(0, INTRO_MAX - 1)}…` : norm,
        screen: { label: l0Scan(norm, 'dm_stranger').label, layers: ['l0'] },
        threadId: `t_${intro.m.thread_id}`,
      };
      return c.json(out);
    }
    if (detail.status === 'builder') {
      // The draft is the owner's own agent's message; the question is customer text (untrusted, plain text in the UI).
      const out = detail.mid ? await builderReplyDetail(deps, caller, detail.item, detail.mid) : null;
      if (!out) return fail(c, 'NOT_FOUND', 'review item not found');
      return c.json(out);
    }
    if (detail.status === 'quarantined') {
      // The screened-out message itself, so the human decides release/reject on what they can read (#48).
      const out = detail.mid ? await quarantinedDetail(app, c.req.header('authorization'), deps, caller, detail.item, detail.mid) : null;
      if (!out) return fail(c, 'NOT_FOUND', 'review item not found');
      return c.json(out);
    }
    if (detail.status === 404) return fail(c, 'NOT_FOUND', 'review item not found');
    if (detail.status === 501) return fail(c, 'NOT_FOUND', `review detail for kind ${detail.kind} is not available yet`);
    return c.json(detail.out);
  });

  app.post('/api/v1/review/:id/decision', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const id = bareId('rv', c.req.param('id'));
    if (!id) return fail(c, 'VALIDATION', 'expected a review id (rv_…)');
    const body = parseOr(c, DecisionRequest, await readJson(c));
    if (!body.ok) return body.res;
    const idem = c.req.header('idempotency-key');
    const decisionId = idem && /^[A-Za-z0-9_.:-]{8,128}$/.test(idem) ? idem : `dec_${randomUUID()}`;
    try {
      const result = await deps.db.asUser(caller.claims, (tx) =>
        decideReviewTx(tx, deps, {
          reviewId: id, decision: body.data.decision, decisionId, via: 'web', ...(body.data.edits ? { edits: body.data.edits } : {}),
        }),
      );
      if (result.status === 404) return fail(c, 'NOT_FOUND', 'review item not found');
      if (result.status === 400) return fail(c, 'VALIDATION', result.msg);
      if (result.status === 409) return fail(c, 'CONFLICT', 'this item was already decided or has expired');
      return c.json(result.item);
    } catch (e) {
      if (isSqlState(e, '23505')) return fail(c, 'CONFLICT', 'Idempotency-Key was already used for another decision');
      throw e;
    }
  });

  /* ------------------------------------------------- remote instructions */
  // Owner instructions over the web (P4) per agent. Turning it on needs step-up (I5); turning it off never does.
  app.get('/api/v1/settings/remote-instructions', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const want = c.req.query('agentId');
    const row = await deps.db.asUser(caller.claims, async (tx) =>
      (
        await tx.query<{ id: string; remote_on: boolean | null }>(
          `select a.id, s.remote_instructions as remote_on from public.agents a left join public.agent_settings s on s.agent_id = a.id
            where a.owner_user_id = $1 and ($2::text is null or a.id::text = $2) order by a.created_at limit 1`,
          [caller.userId, want ?? null],
        )
      ).rows[0],
    );
    if (!row) return fail(c, 'NOT_FOUND', 'agent not found');
    return c.json(RemoteInstructionsSetting.parse({ agentId: row.id, on: row.remote_on === true }));
  });

  app.put('/api/v1/settings/remote-instructions', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const body = parseOr(c, RemoteInstructionsSetting, await readJson(c));
    if (!body.ok) return body.res;
    if (body.data.on) {
      const stepUp = await requireRecentLogin(c, deps);
      if (stepUp) return stepUp;
    }
    const updated = await deps.db.asUser(caller.claims, async (tx) => {
      const owns = await tx.query('select 1 from public.agents where id = $1 and owner_user_id = $2', [body.data.agentId, caller.userId]);
      if (owns.rowCount === 0) return false;
      const r = await tx.query('update public.agent_settings set remote_instructions = $2 where agent_id = $1', [
        body.data.agentId,
        body.data.on,
      ]);
      return (r.rowCount ?? 0) > 0;
    });
    if (!updated) return fail(c, 'NOT_FOUND', 'agent not found');
    return c.json(RemoteInstructionsSetting.parse(body.data));
  });

  /* ---------------------------------------------------------------- stream */
  app.get('/api/v1/stream', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const lastId = c.req.header('last-event-id');
    // authenticate() takes ?token= only without an Authorization header; otherwise it used bearerFrom()
    // (the header, else the y_session cookie), and that same bearer is re-verified later (#83).
    const viaStreamToken = !!c.req.query('token') && !c.req.header('authorization');
    const authorization = viaStreamToken ? undefined : bearerFrom(c);

    let rl: Awaited<ReturnType<typeof takeToken>> = { allowed: true };
    try {
      rl = await deps.db.asUser(caller.claims, (tx) => takeToken(tx, 'web:stream', [caller.userId], STREAM_LIMITS.connect));
    } catch (e) {
      deps.log('warn', 'stream connect rate check failed', { err: String(e) }); // fail open: a DB blip must not refuse streams
    }
    if (!rl.allowed) {
      return fail(c, 'RATE_LIMITED', 'too many event stream connections; retry shortly', { retryable: true, retryAfterS: rl.retryAfterS });
    }

    // Count and register synchronously (no await from here to mine.set), so concurrent connects can't overshoot.
    let byUser = openStreams.get(deps);
    if (!byUser) openStreams.set(deps, (byUser = new Map()));
    const opened = Date.now();
    let total = 0;
    for (const [uid, slots] of byUser) {
      for (const [k, at] of slots) if (opened - at > STREAM_HEARTBEAT_S * 3000) slots.delete(k);
      if (slots.size === 0) byUser.delete(uid);
      total += slots.size;
    }
    let mine = byUser.get(caller.userId);
    if (mine && mine.size >= STREAM_LIMITS.maxPerUser) {
      return fail(c, 'RATE_LIMITED', 'too many open event streams for this account; close a tab and retry', { retryable: true, retryAfterS: 30 });
    }
    if (total >= STREAM_LIMITS.maxTotal) {
      return fail(c, 'RATE_LIMITED', 'the event stream is busy; retry shortly', { retryable: true, retryAfterS: 30 });
    }
    if (!mine) byUser.set(caller.userId, (mine = new Map()));
    const slot = Symbol('stream');
    mine.set(slot, opened);
    const streams = mine;
    const release = () => {
      streams.delete(slot);
      if (streams.size === 0 && byUser.get(caller.userId) === streams) byUser.delete(caller.userId);
    };

    /** The caller may still read this stream (#83). Fails open on errors: a DB blip must not drop every stream. */
    const stillAllowed = async (): Promise<boolean> => {
      try {
        if (authorization) {
          const again = await deps.auth.verifyBearer(authorization);
          if (!again || again.userId !== caller.userId) return false;
        }
        const u = await deps.db.asService((s) => s.query(`select 1 from public.users where id = $1 and status = 'active'`, [caller.userId]));
        return (u.rowCount ?? 0) > 0;
      } catch (e) {
        deps.log('warn', 'stream re-auth check failed', { err: String(e) });
        return true;
      }
    };

    return streamSSE(c, async (stream) => {
      const queue: PushEvent[] = [];
      let wake: (() => void) | null = null;
      const push = (e: PushEvent) => {
        queue.push(e);
        wake?.();
      };
      let closed = false;
      let unsubscribe: (() => void) | null = null;
      stream.onAbort(() => {
        closed = true;
        wake?.();
      });
      try {
        unsubscribe = deps.bus.subscribeUser(caller.userId, push);
        // A bus that polls (serverless) fixes its start cursor asynchronously: wait, so every event after ': open' arrives.
        await (unsubscribe as { ready?: Promise<unknown> }).ready;
        // Flush headers now: proxies (the Vite dev/preview proxy, some CDNs) hold them until the first body chunk.
        await stream.write(': open\n\n');
        if (lastId && /^\d{1,19}$/.test(lastId)) {
          // my_events ascends by id; the replay goes ahead of any live event, oldest first (#47).
          const r = await deps.db.asUser(caller.claims, (tx) =>
            tx.query<{ id: string | number; type: string; payload: Record<string, unknown> }>('select * from api.my_events($1, $2)', [
              Number(lastId),
              STREAM_LIMITS.replayMax,
            ]),
          );
          const missed: PushEvent[] = r.rows.map((row) => ({
            id: String(row.id),
            type: row.type,
            audienceAgentIds: [],
            audienceUserIds: [caller.userId],
            payload: row.payload ?? {},
          }));
          if (missed.length >= STREAM_LIMITS.replayMax) {
            // More may be missing: send what was read, then tell the client to resume from the last
            // replayed id (EventSource does so on reconnect) instead of skipping ahead to live events.
            let upTo = Number(lastId);
            for (const e of missed) {
              upTo = Math.max(upTo, Number(e.id));
              const se = toStreamEvent({ type: e.type as never, payload: e.payload as never });
              if (se) await stream.writeSSE({ id: String(e.id), event: se.type, data: JSON.stringify(se) });
            }
            await stream.writeSSE({ event: 'resync', data: JSON.stringify({ type: 'resync', reason: 'replay_truncated', last_event_id: String(upTo) }) });
            return;
          }
          queue.unshift(...missed);
        }
        let sentUpTo = lastId && /^\d+$/.test(lastId) ? Number(lastId) : 0;
        let checkedAt = Date.now();
        while (!closed) {
          if (Date.now() - checkedAt >= STREAM_LIMITS.reauthMs) {
            checkedAt = Date.now();
            if (!(await stillAllowed())) break;
          }
          while (queue.length > 0) {
            const e = queue.shift()!;
            const eid = Number(e.id ?? 0);
            if (eid && eid <= sentUpTo) continue;
            sentUpTo = Math.max(sentUpTo, eid);
            const se = toStreamEvent({ type: e.type as never, payload: e.payload as never });
            if (se) await stream.writeSSE({ id: String(e.id ?? ''), event: se.type, data: JSON.stringify(se) });
          }
          streams.set(slot, Date.now());
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, STREAM_HEARTBEAT_S * 1000);
            wake = () => {
              clearTimeout(t);
              resolve();
            };
          });
          wake = null;
          if (!closed && queue.length === 0) await stream.write(': ping\n\n');
        }
      } finally {
        unsubscribe?.();
        release();
      }
    });
  });
}

/**
 * GET /api/v1/review/:id for a quarantined_message item: the message (read through the caller's own
 * thread view, so RLS decides what they may see) and its thread. The body is the sender's text,
 * normalized like a stranger's intro; the UI renders it as untrusted plain text. Null when the
 * message is not in the viewer's view.
 */
async function quarantinedDetail(
  app: Hono,
  authorization: string | undefined,
  deps: CoreDeps,
  caller: Caller,
  item: ReviewItem,
  messageId: string,
): Promise<QuarantinedMessageReview | null> {
  if (!authorization) return null;
  const threadId = await deps.db.asUser(caller.claims, async (tx) =>
    (await tx.query<{ thread_id: string }>('select thread_id from public.messages where id = $1', [messageId])).rows[0]?.thread_id,
  );
  if (!threadId) return null;
  const want = `m_${messageId}`;
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const res = await app.request(`/api/v1/threads/t_${threadId}/messages${qs}`, { headers: { authorization } });
    if (res.status !== 200) return null;
    const parsed = ThreadDetail.safeParse(await res.json());
    if (!parsed.success) return null;
    const message = parsed.data.messages.find((m) => m.id === want);
    if (message) {
      const body = normalizeUntrusted(message.body).text;
      return {
        item,
        message: { ...message, body, screen: message.screen ?? { label: l0Scan(body, 'dm_teammate').label, layers: ['l0'] } },
        thread: parsed.data.thread,
      };
    }
    if (!parsed.data.nextCursor) return null;
    cursor = parsed.data.nextCursor;
  }
  return null;
}
