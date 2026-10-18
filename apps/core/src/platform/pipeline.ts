/**
 * Worker jobs (db.asService only here): finalize → screen → publish, distill_heuristic →
 * screen (highlight) → review item, review.draft (approval publishes), embed, close_idle.
 */
import type { Tx } from '@y/db';
import {
  ActivityStats,
  HighlightDraft,
  emptyStats,
  mergeStats,
  totalToolCalls,
  type ErrorEpisode,
  type Lap,
  type LocalDistill,
} from '@y/schema';
import { isWarmup, sizeBucketFor, templatedTitle } from '@y/domain';
import { redact } from '@y/redact';
import { actionFor, l0Scan } from '@y/safety';
import { normalizeErrorSignature } from '@y/capture';
import type { CoreDeps, JobHandler } from '../contracts.js';
import { heuristicDrafts } from './distill.js';
import { openDigest, toVectorLiteral } from './util.js';
import { enqueueFeedCard } from '../slack/enqueue.js';

/** What core seals into activity_chunks.digest_enc (purged after distill, ≤24 h: I6). */
export interface SealedChunk {
  text: string;
  errorEpisodes: ErrorEpisode[];
  laps: Lap[];
  setupHash: string | null;
  /** Client-side (local CLI) distill result, when the plugin distilled locally. */
  distilled?: LocalDistill;
}

const IDLE_MINUTES = 30;
const CLOSE_IDLE_EVERY_MS = 5 * 60_000;

function str(p: Record<string, unknown>, k: string): string {
  const v = p[k];
  if (typeof v !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(v)) throw new Error(`bad payload: ${k}`);
  return v;
}

/** Pass-2 redaction for any server-side text. Fails closed to '' when the redactor drops it. */
function pass2(text: string): string {
  const r = redact(text);
  return r.dropped ? '' : r.text;
}

function screenAction(text: string, contentClass: 'card' | 'highlight'): { label: string; action: string } {
  const l0 = l0Scan(text, contentClass);
  return { label: l0.label, action: actionFor(contentClass, l0.label).action };
}

async function teamAudience(tx: Tx, teamId: string | null, ownerId: string): Promise<string[]> {
  if (!teamId) return [ownerId];
  const r = await tx.query<{ user_id: string }>('select user_id from public.team_members where team_id = $1 limit 100', [teamId]);
  return [...new Set([ownerId, ...r.rows.map((x) => x.user_id)])].slice(0, 100);
}

async function readSealed(deps: CoreDeps, tx: Tx, activityId: string): Promise<SealedChunk[]> {
  const r = await tx.query<{ digest_enc: Uint8Array | null }>(
    'select digest_enc from public.activity_chunks where activity_id = $1 order by seq',
    [activityId],
  );
  const out: SealedChunk[] = [];
  for (const row of r.rows) {
    if (!row.digest_enc) continue;
    try {
      out.push(JSON.parse(openDigest(deps.config.hmacKey, row.digest_enc)) as SealedChunk);
    } catch {
      deps.log('warn', 'unreadable digest blob', { activityId });
    }
  }
  return out;
}

/* ================================================================ finalize */

const finalize: JobHandler = async (payload, deps) => {
  const id = str(payload, 'activityId');
  const next = await deps.db.asService(async (tx) => {
    const a = (await tx.query<Record<string, unknown>>('select * from public.activities where id = $1 for update', [id])).rows[0];
    if (!a || a.status !== 'open') return null;
    const chunks = await tx.query<{ stats_delta: unknown }>(
      'select stats_delta from public.activity_chunks where activity_id = $1 order by seq',
      [id],
    );
    let stats = emptyStats();
    for (const c of chunks.rows) {
      const d = ActivityStats.safeParse(c.stats_delta);
      if (d.success) stats = mergeStats(stats, d.data);
    }
    const sealed = await readSealed(deps, tx, id);
    // Chunks can re-send laps they already reported; keep the latest report of each index.
    const byIndex = new Map<number, Lap>();
    for (const l of sealed.flatMap((s) => s.laps ?? [])) byIndex.set(l.index, l);
    const laps = [...byIndex.values()].sort((x, y) => x.index - y.index).slice(0, 200);
    const setupHash = [...sealed].reverse().find((s) => s.setupHash)?.setupHash ?? null;
    const sv = setupHash
      ? (await tx.query<{ id: string; model: string | null }>('select id, model from public.setup_versions where agent_id = $1 and hash = $2', [a.agent_id, setupHash])).rows[0]
      : undefined;
    const model = (sv?.model && sv.model !== 'default' ? sv.model : null) ?? stats.models[0] ?? 'unknown';
    const title = pass2(templatedTitle(stats, { model }, { stackTags: [] })).slice(0, 120) || 'Coding session';
    const outcome =
      (stats.prUrlsCount ?? 0) > 0
        ? { status: 'shipped', verifiedBy: 'pr' }
        : stats.tests.runs > 0
          ? { status: stats.tests.greenAtEnd ? 'green' : 'partial', verifiedBy: 'tests' }
          : { status: 'unknown', verifiedBy: 'none' };
    const warmup = isWarmup(stats);
    await tx.query(
      `update public.activities set
         stats = $2::jsonb, laps = $3::jsonb, title = $4, outcome = $5::jsonb, outcome_status = $6,
         size_bucket = $7, tokens_total = $8, turns = $9, tool_calls = $10, failed_tool_calls = $11,
         wall_ms = $12, active_ms = $13, cost_usd = $14, setup_version_id = coalesce($15, setup_version_id),
         ended_at = coalesce(ended_at, now()), status = $16, updated_at = now()
       where id = $1`,
      [
        id,
        JSON.stringify(stats),
        JSON.stringify(laps),
        title,
        JSON.stringify(outcome),
        outcome.status,
        sizeBucketFor(stats),
        stats.tokens.total,
        stats.turns,
        totalToolCalls(stats),
        stats.errors.toolFailures,
        stats.wallMs,
        stats.activeMs,
        stats.costUsd,
        sv?.id ?? null,
        // Warmups are kept for stats and never posted or distilled.
        warmup ? 'archived' : 'distilling',
      ],
    );
    return warmup ? null : id;
  });
  if (!next) return;
  await deps.jobs.enqueue('screen', { kind: 'activity', id: next }, { dedupeKey: `screen:a:${next}` });
  await deps.jobs.enqueue('distill_heuristic', { activityId: next }, { dedupeKey: `distill:${next}` });
};

/* ================================================================== screen */

const screen: JobHandler = async (payload, deps) => {
  const id = str(payload, 'id');
  const kind = payload.kind === 'highlight' ? 'highlight' : 'activity';
  const after = await deps.db.asService(async (tx) => {
    if (kind === 'activity') {
      const a = (await tx.query<Record<string, unknown>>('select * from public.activities where id = $1', [id])).rows[0];
      if (!a || a.status !== 'distilling') return null;
      const s = screenAction([a.title, a.summary].filter(Boolean).join('\n'), 'card');
      const allowed = s.action === 'allow' || s.action === 'label';
      await tx.query(
        `update public.activities set screen_label = $2, screen_layers = array['l0'], screen_action = $3,
           status = case when $4 then status else 'quarantined' end, updated_at = now() where id = $1`,
        [id, s.label, s.action, allowed],
      );
      return allowed ? 'publish' : null;
    }
    const h = (await tx.query<Record<string, unknown>>('select * from public.highlights where id = $1', [id])).rows[0];
    if (!h || h.status !== 'draft') return null;
    const text = [h.title, h.summary, JSON.stringify(h.body ?? {})].join('\n');
    const s = screenAction(text, 'highlight');
    const allowed = s.action === 'allow' || s.action === 'label';
    await tx.query(
      `update public.highlights set screen_label = $2, screen_layers = array['l0'], screen_action = $3,
         status = case when $4 then status else 'quarantined' end, updated_at = now() where id = $1`,
      [id, s.label, s.action, allowed],
    );
    if (allowed) {
      // The owner reviews the draft; summary is templated from counts only (never draft text).
      const steps = Array.isArray((h.body as { steps?: unknown[] } | null)?.steps) ? (h.body as { steps: unknown[] }).steps.length : 0;
      await tx.query(
        `insert into public.review_items (owner_user_id, kind, ref_id, agent_id, summary, requires_step_up)
         values ($1, 'draft', $2, $3, $4, false) on conflict do nothing`,
        [h.owner_user_id, `h_${id}`, h.author_agent_id, `Draft fix highlight (${steps} step${steps === 1 ? '' : 's'}) from a captured session`],
      );
    }
    return null;
  });
  if (after === 'publish') await deps.jobs.enqueue('publish', { activityId: id }, { dedupeKey: `publish:${id}` });
};

/* ================================================================= publish */

const publish: JobHandler = async (payload, deps) => {
  const id = str(payload, 'activityId');
  const done = await deps.db.asService(async (tx) => {
    const r = await tx.query<{ owner_user_id: string; team_id: string | null; visibility: string }>(
      `update public.activities set status = 'published', published_at = now(),
          visibility = case when team_id is not null then 'team' else 'private' end, updated_at = now()
        where id = $1 and status = 'distilling' and screen_action in ('allow', 'label')
        returning owner_user_id, team_id, visibility::text as visibility`,
      [id],
    );
    const a = r.rows[0];
    if (!a) return false;
    await deps.bus.publish(
      { type: 'activity.published', audienceAgentIds: [], audienceUserIds: await teamAudience(tx, a.team_id, a.owner_user_id), payload: { activityId: `a_${id}` } },
      tx,
    );
    // Team feed channel in Slack (team visibility only; never private).
    if (a.team_id && a.visibility === 'team') await enqueueFeedCard(tx, deps, id, a.team_id);
    return true;
  });
  if (done) await deps.jobs.enqueue('embed', { kind: 'activity', id }, { dedupeKey: `embed:a:${id}` });
};

/* ======================================================= distill_heuristic */

const distillHeuristic: JobHandler = async (payload, deps) => {
  const id = str(payload, 'activityId');
  const created = await deps.db.asService(async (tx) => {
    const a = (await tx.query<Record<string, unknown>>('select * from public.activities where id = $1', [id])).rows[0];
    if (!a) return [];
    const already = await tx.query('select 1 from public.highlights where activity_id = $1 limit 1', [id]);
    const sealed = await readSealed(deps, tx, id);
    const ids: string[] = [];
    if (already.rowCount === 0 && sealed.length > 0) {
      const local = [...sealed].reverse().find((s) => s.distilled)?.distilled;
      const drafts = local
        ? // Local distill: the client's Stage B drafts (re-validated; injection-flagged cards yield nothing).
          local.card.flags.suspectedInjection
          ? []
          : local.highlights
              .map((h) => HighlightDraft.safeParse(h))
              .flatMap((r) => (r.success && r.data.confidence >= 0.6 ? [{ ...r.data, errorSignature: r.data.errorSignatures[0] ?? '' }] : []))
              .slice(0, 3)
        : heuristicDrafts({
            digest: sealed.map((s) => s.text).join('\n'),
            episodes: sealed.flatMap((s) => s.errorEpisodes ?? []),
            normalize: normalizeErrorSignature,
          });
      for (const d of drafts) {
        // Pass 2 on every field; a step/pitfall the redactor drops is removed.
        const steps = d.body.steps.map(pass2).filter(Boolean);
        const pitfalls = d.body.pitfalls
          .map((p) => ({ tried: pass2(p.tried), whyFailed: pass2(p.whyFailed) }))
          .filter((p) => p.tried && p.whyFailed);
        const title = pass2(d.title);
        const problem = pass2(d.body.problem);
        const sig = d.errorSignature ? pass2(d.errorSignature) : '';
        if (!title || title.length < 8 || !problem || steps.length === 0 || pitfalls.length === 0) continue;
        const body = { ...d.body, problem, steps, pitfalls, verification: pass2(d.body.verification), appliesWhen: pass2(d.body.appliesWhen) };
        const r = await tx.query<{ id: string }>(
          `insert into public.highlights (activity_id, author_agent_id, owner_user_id, team_id, repo_key, kind, title, summary,
             body, tags, search_queries, confidence, status, visibility)
           values ($1, $2, $3, $4, $5, 'fix', $6, $7, $8::jsonb, '{}', $9::text[], $10, 'draft', $11)
           returning id`,
          [
            id,
            a.agent_id,
            a.owner_user_id,
            a.team_id,
            a.repo_key,
            title,
            pass2(d.summary),
            JSON.stringify(body),
            [...new Set([sig, ...d.searchQueries].map((q) => pass2(q).slice(0, 200)).filter(Boolean))].slice(0, 6),
            d.confidence,
            a.team_id ? 'team' : 'private',
          ],
        );
        const hid = r.rows[0]!.id;
        for (const e of new Set([sig, ...d.errorSignatures.map(pass2)].filter(Boolean))) {
          await tx.query('insert into public.highlight_errors (highlight_id, sig) values ($1, $2) on conflict do nothing', [hid, e.slice(0, 300)]);
        }
        ids.push(hid);
      }
    }
    // I6: digests are purged once distilled.
    await tx.query(
      `update public.activity_chunks set digest_enc = null, digest_purged_at = now(), distilled_at = coalesce(distilled_at, now())
        where activity_id = $1`,
      [id],
    );
    return ids;
  });
  for (const hid of created) await deps.jobs.enqueue('screen', { kind: 'highlight', id: hid }, { dedupeKey: `screen:h:${hid}` });
};

/* ============================================================ review.draft */

/** Runs after a human decided a draft review item (api.decide_review in the web route). */
const reviewDraft: JobHandler = async (payload, deps) => {
  const reviewId = str(payload, 'reviewId');
  const published = await deps.db.asService(async (tx) => {
    const rv = (await tx.query<Record<string, unknown>>('select * from public.review_items where id = $1', [reviewId])).rows[0];
    if (!rv || rv.kind !== 'draft' || !String(rv.ref_id).startsWith('h_')) return null;
    const hid = String(rv.ref_id).slice(2);
    if (rv.state === 'rejected') {
      await tx.query(`update public.highlights set status = 'archived', updated_at = now() where id = $1 and status = 'draft'`, [hid]);
      return null;
    }
    if (rv.state !== 'approved') return null;
    const edits = (payload.edits ?? {}) as { title?: unknown; summary?: unknown };
    const title = typeof edits.title === 'string' ? pass2(edits.title).slice(0, 90) : null;
    const summary = typeof edits.summary === 'string' ? pass2(edits.summary).slice(0, 400) : null;
    if (title !== null || summary !== null) {
      const s = screenAction([title, summary].filter(Boolean).join('\n'), 'highlight');
      if (s.action !== 'allow' && s.action !== 'label') {
        await tx.query(`update public.highlights set status = 'quarantined', screen_label = $2, screen_action = $3 where id = $1`, [hid, s.label, s.action]);
        return null;
      }
    }
    const r = await tx.query<{ owner_user_id: string; team_id: string | null; activity_id: string | null }>(
      `update public.highlights set status = 'active', published_at = now(),
          title = coalesce(nullif($2, ''), title), summary = coalesce($3, summary),
          visibility = case when team_id is not null then 'team' else 'private' end, updated_at = now()
        where id = $1 and status = 'draft' and screen_action in ('allow', 'label')
        returning owner_user_id, team_id, activity_id`,
      [hid, title, summary],
    );
    const h = r.rows[0];
    if (!h) return null;
    if (h.activity_id) {
      await deps.bus.publish(
        { type: 'activity.updated', audienceAgentIds: [], audienceUserIds: await teamAudience(tx, h.team_id, h.owner_user_id), payload: { activityId: `a_${h.activity_id}` } },
        tx,
      );
    }
    return hid;
  });
  if (published) await deps.jobs.enqueue('embed', { kind: 'highlight', id: published }, { dedupeKey: `embed:h:${published}` });
};

/* =================================================================== embed */

const embed: JobHandler = async (payload, deps) => {
  const id = str(payload, 'id');
  const kind = payload.kind === 'highlight' ? 'highlight' : 'activity';
  await deps.db.asService(async (tx) => {
    let text: string;
    if (kind === 'highlight') {
      const h = (await tx.query<Record<string, unknown>>(`select * from public.highlights where id = $1 and status = 'active'`, [id])).rows[0];
      if (!h) return;
      const body = (h.body ?? {}) as { problem?: string };
      text = [h.title, h.summary, body.problem, ((h.tags as string[]) ?? []).join(' '), ((h.search_queries as string[]) ?? []).join(' ')].filter(Boolean).join('\n');
    } else {
      const a = (await tx.query<Record<string, unknown>>(`select * from public.activities where id = $1 and status = 'published'`, [id])).rows[0];
      if (!a) return;
      // Never the digest (PLAN "What gets embedded").
      text = [a.title, a.summary, String(a.task_intent ?? '').replace(/_/g, ' '), ((a.stack_tags as string[]) ?? []).join(' ')].filter(Boolean).join('\n');
    }
    const [vec] = await deps.embedder.embed([text]);
    if (!vec || vec.length !== deps.embedder.dims) throw new Error('embedder returned wrong dims');
    await tx.query(`update public.${kind === 'highlight' ? 'highlights' : 'activities'} set embedding = $2::vector where id = $1`, [id, toVectorLiteral(vec)]);
  });
};

/* ============================================================== close_idle */

const closeIdle: JobHandler = async (_payload, deps) => {
  const toFinalize = await deps.db.asService(async (tx) => {
    const s = await tx.query<{ id: string }>(
      `update public.sessions set status = 'closed', close_reason = 'idle_timeout', ended_at = now(), updated_at = now()
        where status = 'open' and last_event_at < now() - make_interval(mins => $1) returning id`,
      [IDLE_MINUTES],
    );
    // I6 backstop: digests older than 24 h are purged even if distill never ran.
    await tx.query(
      `update public.activity_chunks set digest_enc = null, digest_purged_at = now()
        where digest_enc is not null and received_at < now() - interval '24 hours'`,
    );
    if (s.rows.length === 0) return [];
    const a = await tx.query<{ id: string }>(
      `select id from public.activities where session_id = any($1::uuid[]) and status = 'open'`,
      [s.rows.map((r) => r.id)],
    );
    return a.rows.map((r) => r.id);
  });
  // Keyed by tick: a reopened activity (resumed session) must be finalizable again.
  const tick = Math.floor(deps.now().getTime() / 60_000);
  for (const id of toFinalize) await deps.jobs.enqueue('finalize', { activityId: id }, { dedupeKey: `finalize:${id}:idle:${tick}` });
  await scheduleCloseIdle(deps);
};

export async function scheduleCloseIdle(deps: CoreDeps): Promise<void> {
  const bucket = Math.floor(deps.now().getTime() / CLOSE_IDLE_EVERY_MS) + 1;
  await deps.jobs.enqueue('close_idle', {}, { dedupeKey: `close_idle:${bucket}`, runAfterMs: CLOSE_IDLE_EVERY_MS });
}

export const PLATFORM_JOBS: Record<string, JobHandler> = {
  finalize,
  screen,
  publish,
  distill_heuristic: distillHeuristic,
  'review.draft': reviewDraft,
  embed,
  close_idle: closeIdle,
};
