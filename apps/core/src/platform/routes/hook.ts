/** Hook REST for plugins: POST /ingest, GET /agent/brief, POST /hook/match. Install-token callers. */
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Tx } from '@y/db';
import {
  AgentBrief,
  AgentBriefQuery,
  HookMatchRequest,
  IngestChunk,
  KILL_SWITCH_DB_NAMES,
  NO_KILL_SWITCHES,
  makePointer,
  type HookMatchResponse,
  type IngestResponse,
  type KillSwitches,
  type Pointer,
  type HumanNotice,
} from '@y/schema';
import type { Caller, CoreDeps } from '../../contracts.js';
import { PlatformAuth } from '../auth.js';
import { PgPushBus } from '../bus.js';
import { authenticate } from '../http.js';
import { refreshAgentPresence } from '../presence.js';
import { realtimeChannelFor } from '../realtime-channel.js';
import type { SealedChunk } from '../pipeline.js';
import { takeIngestToken } from '../rate-limit.js';
import { postingTeamId } from '../../messaging/util.js';
import { fail, parseOr, readJson, sealDigest, segmentUlid } from '../util.js';
import { TURN_SUMMARY_TOPIC, turnSummaryJob } from '../../updates/job.js';
import { turnSummarizerFor } from '../../updates/summarizer.js';

export const MIN_PLUGIN_VERSION = '0.1.0';
/** Request body cap for POST /api/v1/ingest (Vercel's own limit is 4.5 MB). */
export const INGEST_MAX_BODY_BYTES = 4 * 1024 * 1024;
/** P2 push threshold (packages/retrieval THRESHOLDS.push). */
export const PUSH_MATCH_THRESHOLD = 0.6;
/** Segment close reasons that also end the harness session (the rest only close a segment). */
const SESSION_ENDING_REASONS: ReadonlySet<string> = new Set(['session_end', 'clear']);

function cursorOf(deps: CoreDeps): string {
  return deps.bus instanceof PgPushBus ? deps.bus.cursor : '0';
}

async function unreadFor(tx: Tx, agentId: string): Promise<number> {
  const r = await tx.query<{ n: string | number }>(
    `select count(*) as n from public.message_deliveries where recipient_agent_id = $1 and state in ('pending', 'pointer_sent')`,
    [agentId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

async function killSwitches(deps: CoreDeps): Promise<KillSwitches> {
  const r = await deps.db.asAnon((tx) => tx.query<{ name: string; engaged: boolean }>('select name, engaged from public.kill_switches'));
  const out: KillSwitches = { ...NO_KILL_SWITCHES };
  for (const [wire, dbName] of Object.entries(KILL_SWITCH_DB_NAMES) as [keyof KillSwitches, string][]) {
    out[wire] = r.rows.some((x) => x.name === dbName && x.engaged);
  }
  return out;
}

const clamp999 = (n: number) => Math.max(1, Math.min(999, n));

export function registerHookRoutes(app: Hono, deps: CoreDeps): void {
  /* --------------------------------------------------------------- ingest */
  // A chunk is at most ~100k digest chars plus a setup snapshot; refuse anything far larger before parsing.
  app.use('/api/v1/ingest', bodyLimit({ maxSize: INGEST_MAX_BODY_BYTES, onError: (c) => fail(c, 'VALIDATION', 'ingest chunk is too large') }));
  app.post('/api/v1/ingest', async (c) => {
    const caller = await authenticate(c, deps, 'agent');
    if (caller instanceof Response) return caller;
    const parsed = parseOr(c, IngestChunk, await readJson(c));
    if (!parsed.ok) return parsed.res;
    const ch = parsed.data;
    if ((await killSwitches(deps)).ingest) return fail(c, 'RATE_LIMITED', 'ingest is paused (kill switch)', { retryAfterS: 300 });
    const agentId = caller.agentId!;
    const rl = await deps.db.asUser(caller.claims, (tx) => takeIngestToken(tx, agentId, ch.sessionId));
    if (!rl.allowed) {
      c.header('retry-after', String(rl.retryAfterS));
      return fail(c, 'RATE_LIMITED', rl.message, { retryAfterS: rl.retryAfterS });
    }

    const segment = await resolveSegment(deps, agentId, ch);
    const res = await deps.db.asUser(caller.claims, async (tx): Promise<IngestResponse> => {
      const s = await tx.query<{ id: string; started_at: Date }>(
        `insert into public.sessions (agent_id, install_id, harness_session_id, repo_key, harness_version)
         values ($1, $2, $3, $4, $5)
         on conflict (agent_id, harness_session_id) do update
           set last_event_at = now(), harness_version = excluded.harness_version,
               repo_key = coalesce(excluded.repo_key, public.sessions.repo_key),
               -- Reopen (idle-closed, resumed) sessions, but not ones the harness ended: a retried or
               -- late chunk must not undo SessionEnd / clear. A newer chunk reopens those below.
               status = case when public.sessions.close_reason in ('session_end', 'clear') then public.sessions.status else 'open' end,
               close_reason = case when public.sessions.close_reason in ('session_end', 'clear') then public.sessions.close_reason end,
               ended_at = case when public.sessions.close_reason in ('session_end', 'clear') then public.sessions.ended_at end
         returning id, started_at`,
        [agentId, caller.installId, ch.sessionId, ch.repoKey ?? null, ch.harnessVersion.slice(0, 40)],
      );
      const session = s.rows[0]!;
      const startedMs = new Date(session.started_at).getTime();
      const resent = await tx.query<{ activity_id: string }>(
        'select activity_id from public.activity_chunks where session_id = $1 and seq = $2',
        [session.id, ch.seq],
      );
      if (resent.rows[0]) {
        return { accepted: false, duplicate: true, activityId: `a_${resent.rows[0].activity_id}`, pulse: { unread: await unreadFor(tx, agentId), cursor: cursorOf(deps) } };
      }
      const activityId = segmentUlid(session.id, segment, startedMs);
      // The team the human chose for their agents' work (9110), never just the oldest membership.
      const postingTeam = await postingTeamId(tx, caller.userId);
      await tx.query(
        `insert into public.activities (id, agent_id, owner_user_id, session_id, team_id, source, visibility, status, repo_key, stats)
         values ($1, $2, $3, $4, $5, 'captured', 'private', 'open', $6, $7::jsonb)
         on conflict (id) do nothing`,
        [activityId, agentId, caller.userId, session.id, postingTeam, ch.repoKey ?? null, JSON.stringify(ch.statsDelta)],
      );
      if (ch.setup?.snapshot) {
        await tx.query(
          `insert into public.setup_versions (agent_id, hash, snapshot, model) values ($1, $2, $3::jsonb, $4)
           on conflict (agent_id, hash) do nothing`,
          [agentId, ch.setup.hash, JSON.stringify(ch.setup.snapshot), ch.setup.snapshot.model.slice(0, 80)],
        );
      }
      const sealed: SealedChunk = {
        text: ch.digest && !ch.digest.redaction.dropped ? ch.digest.text : '',
        errorEpisodes: ch.errorEpisodes,
        laps: ch.laps ?? [],
        setupHash: ch.setup?.hash ?? null,
        ...(ch.distilled ? { distilled: ch.distilled } : {}),
      };
      const inserted = await tx.query<{ seq: number }>(
        `insert into public.activity_chunks (session_id, seq, activity_id, stats_delta, digest_enc, digest_sha256, digest_bytes, redaction)
         values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb)
         on conflict (session_id, seq) do nothing
         returning seq`,
        [
          session.id,
          ch.seq,
          activityId,
          JSON.stringify(ch.statsDelta),
          sealDigest(deps.config.hmacKey, JSON.stringify(sealed)),
          ch.digest?.sha256 ?? null,
          ch.digest ? Buffer.byteLength(ch.digest.text, 'utf8') : null,
          JSON.stringify(ch.digest?.redaction ?? {}),
        ],
      );
      if (caller.installId) {
        await tx.query('update public.installs set last_seen_at = now(), plugin_version = $2 where id = $1', [caller.installId, ch.pluginVersion]);
      }
      const duplicate = inserted.rowCount === 0;
      // Updates tab: one server-written summary per response that carried a digest (capture on).
      // Enqueued before finalize so it runs before distill purges the digest.
      if (!duplicate && sealed.text.trim() && turnSummarizerFor(deps)) {
        const job = turnSummaryJob(session.id, ch.seq);
        await deps.jobs.enqueue(TURN_SUMMARY_TOPIC, job.payload, { dedupeKey: job.dedupeKey, tx });
      }
      if (!duplicate && ch.close) {
        await deps.jobs.enqueue('finalize', { activityId }, { dedupeKey: `finalize:${activityId}:${ch.seq}`, tx });
      }
      // A resumed session (a chunk newer than every other, after SessionEnd / clear) is open again.
      if (!duplicate) {
        await tx.query(
          `update public.sessions set status = 'open', close_reason = null, ended_at = null
            where id = $1 and close_reason in ('session_end', 'clear')
              and not exists (select 1 from public.activity_chunks c where c.session_id = $1 and c.seq > $2)`,
          [session.id, ch.seq],
        );
      }
      // The harness session itself ended (SessionEnd, /clear): it no longer counts as live, and its
      // listener is gone (presence must not keep showing it as listening until the lease goes stale).
      if (!duplicate && ch.close && SESSION_ENDING_REASONS.has(ch.close.reason)) {
        await tx.query(
          `update public.sessions set status = 'closed', close_reason = $2, ended_at = now() where id = $1`,
          [session.id, ch.close.reason],
        );
        await tx.query(
          `update public.session_leases set listening = 'none', active_at = null where agent_id = $1 and session_id = $2`,
          [agentId, ch.sessionId],
        );
      }
      return {
        accepted: !duplicate,
        ...(duplicate ? { duplicate: true } : {}),
        activityId: `a_${activityId}`,
        pulse: { unread: await unreadFor(tx, agentId), cursor: cursorOf(deps) },
      };
    });
    // sessions.last_event_at moved (or the session ended): recompute presence (fail-open).
    await refreshAgentPresence(deps, agentId);
    return c.json(res);
  });

  /* ---------------------------------------------------------------- brief */
  app.get('/api/v1/agent/brief', async (c) => {
    const q = parseOr(c, AgentBriefQuery, c.req.query());
    if (!q.ok) return q.res;
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
    if (!m?.[1]) return fail(c, 'UNAUTHORIZED', 'install token required');
    const auth = deps.auth instanceof PlatformAuth ? deps.auth : null;
    const resolution = auth
      ? await auth.resolveInstall(m[1])
      : await deps.auth.verifyBearer(c.req.header('authorization')).then((caller) =>
          caller?.agentId ? ({ state: 'ok', caller, handle: '', harness: 'claude_code' } as const) : ({ state: 'unknown_install' } as const),
        );
    const ks = await killSwitches(deps);
    const url = deps.config.publicUrl;
    // distiller 'server': v0 distills uploaded (pass-1 redacted) digests with the deterministic heuristic.
    const basePolicy = { shareMode: 'stats', holdMinutes: 30, capture: 'on', wakeOnDm: 'teammates', policyAccepted: false, distiller: 'server' } as const;
    if (resolution.state !== 'ok') {
      const notice: HumanNotice = { kind: resolution.state === 'revoked' ? 'token_revoked' : 'unknown_install', url: `${url}/connect` };
      return c.json(
        AgentBrief.parse({
          v: 1,
          tokenState: resolution.state,
          minPluginVersion: MIN_PLUGIN_VERSION,
          killSwitches: ks,
          pointers: [],
          policy: basePolicy,
          humanNotices: [notice],
          serverTime: deps.now().toISOString(),
        }),
      );
    }
    const caller: Caller = resolution.caller;
    const agentId = caller.agentId!;
    const brief = await deps.db.asUser(caller.claims, async (tx) => {
      const agent = (
        await tx.query<{ handle: string; harness: string }>('select handle, harness from public.agents where id = $1', [agentId])
      ).rows[0];
      const settings = (await tx.query<{ wake_on_dm: string }>('select wake_on_dm from public.agent_settings where agent_id = $1', [agentId])).rows[0];
      // The posting team (9110): the brief's team, policy and repo-key salt follow where the agent posts.
      const postingTeam = await postingTeamId(tx, caller.userId);
      const team = postingTeam
        ? (
            await tx.query<{ team_id: string; policy_accepted_version: number | null; repo_key_salt: string | null }>(
              `select m.team_id, m.policy_accepted_version, s.repo_key_salt from public.team_members m
                 left join public.team_secrets s on s.team_id = m.team_id
                where m.user_id = $1 and m.team_id = $2`,
              [caller.userId, postingTeam],
            )
          ).rows[0]
        : undefined;
      const pending = Number(
        (
          await tx.query<{ n: string | number }>(
            `select count(*) as n from public.review_items where owner_user_id = $1 and state = 'pending'`,
            [caller.userId],
          )
        ).rows[0]?.n ?? 0,
      );
      const unread = await unreadFor(tx, agentId);
      const realtime = await realtimeChannelFor(tx, deps.config, 'agent', agentId);
      const pointers: Pointer[] = [];
      const notices: HumanNotice[] = [];
      if (!ks.pushPaths) {
        if (unread > 0) pointers.push(makePointer('P1', { count: clamp999(unread) }));
        if (pending > 0) pointers.push(makePointer('P5', { count: clamp999(pending) }));
      }
      if (pending > 0) notices.push({ kind: 'drafts_pending', count: pending, url: `${url}/review` });
      return {
        v: 1,
        tokenState: 'ok',
        agent: { id: agentId, handle: `@${agent?.handle ?? resolution.handle}`, harness: agent?.harness ?? resolution.harness },
        minPluginVersion: MIN_PLUGIN_VERSION,
        killSwitches: ks,
        pointers,
        pulseToken: auth ? auth.mintPulseToken(caller) : undefined,
        ...(realtime ? { realtime } : {}),
        policy: {
          ...basePolicy,
          wakeOnDm: settings?.wake_on_dm ?? 'teammates',
          policyAccepted: team?.policy_accepted_version != null,
          ...(team ? { teamId: team.team_id } : {}),
          ...(team?.repo_key_salt ? { repoKeySalt: team.repo_key_salt } : {}),
        },
        humanNotices: notices,
        serverTime: deps.now().toISOString(),
      };
    });
    return c.json(AgentBrief.parse(brief));
  });

  /* ---------------------------------------------------------------- match */
  app.post('/api/v1/hook/match', async (c) => {
    const caller = await authenticate(c, deps, 'agent');
    if (caller instanceof Response) return caller;
    const parsed = parseOr(c, HookMatchRequest, await readJson(c));
    if (!parsed.ok) return parsed.res;
    const req = parsed.data;
    if ((await killSwitches(deps)).pushPaths) return c.json({ match: null } satisfies HookMatchResponse);
    const agentId = caller.agentId!;
    const out = await deps.db.asUser(caller.claims, async (tx) => {
      const r = await tx.query<{ highlight_id: string; similarity: number; visibility: string; owner_user_id: string }>(
        'select * from api.match_error_signature($1, 1)',
        [req.signature],
      );
      const best = r.rows[0];
      if (!best || Number(best.similarity) < PUSH_MATCH_THRESHOLD) return { match: null };
      const scope = best.visibility === 'public' ? 'public' : 'team';
      const authorTrust = best.owner_user_id === caller.userId ? 'self' : scope === 'public' ? 'public' : 'teammate';
      const score = Math.min(1, Math.max(0, Number(best.similarity)));
      const highlightId = `h_${best.highlight_id}`;
      const session = (
        await tx.query<{ id: string }>('select id from public.sessions where agent_id = $1 and harness_session_id = $2', [agentId, req.sessionId])
      ).rows[0];
      await tx.query(
        `insert into public.content_exposures (content_kind, content_id, agent_id, session_id, via) values ('highlight', $1, $2, $3, 'pointer')`,
        [highlightId, agentId, session?.id ?? null],
      );
      return {
        match: { highlightId, score, scope, authorTrust },
        // Convenience for the hook: the exact P2 pointer to render locally (I3: ids/ints/enums only).
        pointer: makePointer('P2', { highlight_id: highlightId, score: Math.max(60, Math.min(100, Math.round(score * 100))), scope }),
      };
    });
    return c.json(out);
  });
}

/**
 * A resumed session keeps sending chunks after its activity was finalized. A warmup
 * (archived) reopens so the new work counts; a posted one stays as is and the new work
 * starts the next segment. An empty close marker never starts a segment. Service role:
 * agents can't change activity status under RLS (I7), and this only moves the caller's
 * own session forward.
 */
async function resolveSegment(deps: CoreDeps, agentId: string, ch: IngestChunk): Promise<number> {
  const d = ch.statsDelta;
  const hasWork = d.turns > 0 || d.tokens.total > 0 || d.wallMs > 0 || Object.keys(d.toolCalls).length > 0;
  return deps.db.asService(async (tx) => {
    const session = (
      await tx.query<{ id: string; started_at: Date }>('select id, started_at from public.sessions where agent_id = $1 and harness_session_id = $2', [
        agentId,
        ch.sessionId,
      ])
    ).rows[0];
    if (!session) return ch.segmentIndex;
    const resent = await tx.query('select 1 from public.activity_chunks where session_id = $1 and seq = $2', [session.id, ch.seq]);
    if (resent.rowCount) return ch.segmentIndex;
    const startedMs = new Date(session.started_at).getTime();
    let segment = ch.segmentIndex;
    for (let hops = 0; hops < 100; hops++) {
      const id = segmentUlid(session.id, segment, startedMs);
      const ex = (await tx.query<{ status: string }>('select status from public.activities where id = $1 for update', [id])).rows[0];
      if (!ex || ex.status === 'open') break;
      if (ex.status === 'archived') {
        if (hasWork) await tx.query(`update public.activities set status = 'open', ended_at = null, updated_at = now() where id = $1`, [id]);
        break;
      }
      const next = (await tx.query('select 1 from public.activities where id = $1', [segmentUlid(session.id, segment + 1, startedMs)])).rowCount;
      if (!next && !hasWork) break;
      segment++;
    }
    return segment;
  });
}
