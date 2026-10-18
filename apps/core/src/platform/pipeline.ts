/**
 * Worker jobs (db.asService only here): finalize → screen → publish, distill_heuristic →
 * screen (highlight) → review item, review.draft (approval publishes), embed, close_idle,
 * presence_sweep (presence.ts), purge_expired (server mode).
 *
 * Each job enqueues its follow-up inside the transaction that commits its state change, so a
 * crash between the two can never strand a row whose idempotency guard then skips the retry.
 */
import type { Tx } from '@y/db';
import {
  ActivityStats,
  HighlightDraft,
  INVISIBLE_CHARS_SOURCE,
  emptyStats,
  mergeStats,
  totalToolCalls,
  type ErrorEpisode,
  type Label,
  type Lap,
  type LocalDistill,
} from '@y/schema';
import { isWarmup, recurringSlot, sizeBucketFor, templatedTitle } from '@y/domain';
import { redact } from '@y/redact';
import { actionFor, l0Scan } from '@y/safety';
import { normalizeErrorSignature } from '@y/capture';
import type { CoreDeps, JobHandler } from '../contracts.js';
import { heuristicDrafts, maskDraftEnvironment } from './distill.js';
import { presenceSweep, schedulePresenceSweep } from './presence.js';
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
/** Retention (api.purge_expired) runs hourly from the worker in server mode (pg_cron does it on Supabase). */
const PURGE_EVERY_MS = 60 * 60_000;
/**
 * The close_idle digest backstop purges at 23 h, so with the 5-min tick (and a busy queue)
 * a digest never outlives the 24 h bound (I6).
 */
const DIGEST_BACKSTOP = '23 hours';
/** Neutral title used when the owner turns the title off on approval. */
const NEUTRAL_HIGHLIGHT_TITLE = 'Highlight from a captured session';
const HIGHLIGHT_TITLE_MAX = 90;
const HIGHLIGHT_SUMMARY_MAX = 400;
/** Neutral title used when the owner turns the title of an agent's activity draft off. */
const NEUTRAL_ACTIVITY_TITLE = 'Shared a coding session';
const ACTIVITY_TITLE_MAX = 120;
const ACTIVITY_SUMMARY_MAX = 400;

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

/**
 * Clip a redacted string to the DB limit. Redaction markers can be longer than what they
 * replace, so this runs after pass2; a marker cut in half is dropped entirely.
 */
export function fitRedacted(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const open = cut.lastIndexOf('<');
  if (open >= 0 && cut.indexOf('>', open) < 0 && max - open <= 64) cut = cut.slice(0, open);
  return cut.trimEnd();
}

const INVISIBLE_G = new RegExp(INVISIBLE_CHARS_SOURCE, 'g');
/** Unicode tag characters (ASCII smuggling), U+E0000–U+E007F: decoded to ASCII for scanning. */
const TAG_CHARS_G = /[\u{E0000}-\u{E007F}]/gu;
/** C0 controls except tab and LF, DEL, and C1 controls (as @y/safety normalizeUntrusted). */
const CONTROLS_G = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
/** Bidi-override runs (RLO/LRO … PDF or end of line): scanned in their displayed (reversed) order too. */
const BIDI_RUN_G = /[\u202D\u202E]([^\u202C\n]*)/g;
const HTML_COMMENT_G = /<!--([\s\S]*?)(?:-->|$)/g;
const MD_IMAGE_G = /!\[([^\]\n]*)\]\(([^)\n]*)\)/g;
const HTML_IMG_G = /<img\b[^>]*>/gi;

/**
 * L0 step 0 (PLAN §10), the same steps as @y/safety normalizeUntrusted, which is what agents
 * later read: NFKC, tag characters decoded, invisible/bidi characters stripped, CR/CRLF → LF
 * (a lone CR becomes a line start once served), control characters removed, and hidden
 * constructs (HTML comments, markdown images, `<img>`) removed.
 */
export function normalizeForScreen(text: string): string {
  return screenVariants(text)[0]!;
}

/** The normalized (agent-visible) text first, then the hidden payloads it removed, each scanned on its own. */
export function screenVariants(text: string): string[] {
  const hidden: string[] = [];
  let t = text.normalize('NFKC');
  for (const m of t.matchAll(BIDI_RUN_G)) if (m[1]) hidden.push([...m[1]].reverse().join(''));
  t = t
    .replace(TAG_CHARS_G, (ch) => {
      const cp = (ch.codePointAt(0) ?? 0) - 0xe0000;
      return cp >= 0x20 && cp < 0x7f ? String.fromCharCode(cp) : '';
    })
    .replace(INVISIBLE_G, '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROLS_G, '');
  t = t
    .replace(HTML_COMMENT_G, (_m, body: string) => {
      if (body.trim()) hidden.push(body);
      return '';
    })
    .replace(MD_IMAGE_G, (_m, alt: string, url: string) => {
      hidden.push(`${alt} ${url}`.trim());
      return '';
    })
    .replace(HTML_IMG_G, (m) => {
      hidden.push(m);
      return '';
    });
  return [t, ...hidden];
}

const LABEL_RANK: Record<string, number> = { clean: 0, warn: 1, sensitive: 2, suspicious: 3, malicious: 4 };

/**
 * L0 over every text, raw and normalized; the worst label wins (normalization only ever adds
 * findings, and the raw scan keeps l0's own leftover-invisible-character signal).
 */
function screenAction(texts: string | string[], contentClass: 'card' | 'highlight'): { label: string; action: string } {
  let label = 'clean';
  for (const t of Array.isArray(texts) ? texts : [texts]) {
    for (const variant of new Set([t, ...screenVariants(t)])) {
      const l = l0Scan(variant, contentClass).label;
      if ((LABEL_RANK[l] ?? 4) > (LABEL_RANK[label] ?? 4)) label = l;
    }
  }
  return { label, action: actionFor(contentClass, label as Label).action };
}

/** A highlight body's string fields as plain lines (real newlines, so line-anchored L0 rules fire). */
export function highlightBodyLines(body: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v) out.push(v);
  };
  const visit = (v: unknown, depth: number) => {
    if (depth > 4) return;
    if (typeof v === 'string') push(v);
    else if (Array.isArray(v)) for (const x of v) visit(x, depth + 1);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) visit(x, depth + 1);
  };
  visit(body ?? {}, 0);
  return out;
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
  await deps.db.asService(async (tx) => {
    const a = (await tx.query<Record<string, unknown>>('select * from public.activities where id = $1 for update', [id])).rows[0];
    if (!a || a.status !== 'open') return;
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
    if (warmup) return;
    // Same transaction as the status change: a retry after a crash here would see 'distilling' and skip.
    await deps.jobs.enqueue('screen', { kind: 'activity', id }, { dedupeKey: `screen:a:${id}`, tx });
    await deps.jobs.enqueue('distill_heuristic', { activityId: id }, { dedupeKey: `distill:${id}`, tx });
  });
};

/* ================================================================== screen */

const screen: JobHandler = async (payload, deps) => {
  const id = str(payload, 'id');
  const kind = payload.kind === 'highlight' ? 'highlight' : 'activity';
  await deps.db.asService(async (tx) => {
    if (kind === 'activity') {
      const a = (await tx.query<Record<string, unknown>>('select * from public.activities where id = $1', [id])).rows[0];
      if (!a || a.status !== 'distilling') return;
      const s = screenAction([a.title, a.summary].filter(Boolean).join('\n'), 'card');
      const allowed = s.action === 'allow' || s.action === 'label';
      await tx.query(
        `update public.activities set screen_label = $2, screen_layers = array['l0'], screen_action = $3,
           status = case when $4 then status else 'quarantined' end, updated_at = now() where id = $1`,
        [id, s.label, s.action, allowed],
      );
      if (allowed) await deps.jobs.enqueue('publish', { activityId: id }, { dedupeKey: `publish:${id}`, tx });
      return;
    }
    const h = (await tx.query<Record<string, unknown>>('select * from public.highlights where id = $1', [id])).rows[0];
    if (!h || h.status !== 'draft') return;
    // The body is screened both as JSON (as before) and as plain lines: JSON encoding turns real
    // newlines into `\n`, which hides line-anchored injection (fake pointers, role tags).
    const head = [h.title, h.summary].map((x) => String(x ?? ''));
    const s = screenAction(
      [[...head, JSON.stringify(h.body ?? {})].join('\n'), [...head, ...highlightBodyLines(h.body)].join('\n')],
      'highlight',
    );
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
  });
};

/* ================================================================= publish */

const publish: JobHandler = async (payload, deps) => {
  const id = str(payload, 'activityId');
  await deps.db.asService(async (tx) => {
    // Team visibility only while the owner still belongs to the team the session was captured under.
    const r = await tx.query<{ owner_user_id: string; team_id: string | null; visibility: string }>(
      `update public.activities a set status = 'published', published_at = now(),
          visibility = case when a.team_id is not null
                             and exists (select 1 from public.team_members m where m.team_id = a.team_id and m.user_id = a.owner_user_id)
                            then 'team' else 'private' end,
          updated_at = now()
        where a.id = $1 and a.status = 'distilling' and a.screen_action in ('allow', 'label')
        returning a.owner_user_id, a.team_id, a.visibility::text as visibility`,
      [id],
    );
    const a = r.rows[0];
    if (!a) return;
    const teamId = a.visibility === 'team' ? a.team_id : null;
    await deps.bus.publish(
      { type: 'activity.published', audienceAgentIds: [], audienceUserIds: await teamAudience(tx, teamId, a.owner_user_id), payload: { activityId: `a_${id}` } },
      tx,
    );
    // Team feed channel in Slack (team visibility only; never private).
    if (teamId) await enqueueFeedCard(tx, deps, id, teamId);
    await deps.jobs.enqueue('embed', { kind: 'activity', id }, { dedupeKey: `embed:a:${id}`, tx });
  });
};

/* ======================================================= distill_heuristic */

const distillHeuristic: JobHandler = async (payload, deps) => {
  const id = str(payload, 'activityId');
  await deps.db.asService(async (tx) => {
    const a = (await tx.query<Record<string, unknown>>('select * from public.activities where id = $1', [id])).rows[0];
    if (!a) return;
    const already = await tx.query('select 1 from public.highlights where activity_id = $1 limit 1', [id]);
    const sealed = await readSealed(deps, tx, id);
    if (already.rowCount === 0 && sealed.length > 0) {
      const local = [...sealed].reverse().find((s) => s.distilled)?.distilled;
      const drafts = local
        ? // Local distill: the client's Stage B drafts (re-validated; injection-flagged cards yield nothing).
          local.card.flags.suspectedInjection
          ? []
          : local.highlights
              .map((h) => HighlightDraft.safeParse(h))
              .flatMap((r) =>
                // Hosts, paths, URLs and credential files in the client's text are masked, as in heuristic drafts.
                r.success && r.data.confidence >= 0.6 ? [{ ...maskDraftEnvironment(r.data), errorSignature: r.data.errorSignatures[0] ?? '' }] : [],
              )
              .slice(0, 3)
        : heuristicDrafts({
            digest: sealed.map((s) => s.text).join('\n'),
            episodes: sealed.flatMap((s) => s.errorEpisodes ?? []),
            normalize: normalizeErrorSignature,
          });
      for (const d of drafts) {
        // Pass 2 on every field; a step/pitfall the redactor drops is removed. Clipped after pass 2:
        // a redaction marker can be longer than what it replaced (the DB checks title/summary length).
        const steps = d.body.steps.map((x) => fitRedacted(pass2(x), 300)).filter(Boolean);
        const pitfalls = d.body.pitfalls
          .map((p) => ({ tried: fitRedacted(pass2(p.tried), 200), whyFailed: fitRedacted(pass2(p.whyFailed), 300) }))
          .filter((p) => p.tried && p.whyFailed);
        const title = fitRedacted(pass2(d.title), HIGHLIGHT_TITLE_MAX);
        const problem = fitRedacted(pass2(d.body.problem), 600);
        const sig = d.errorSignature ? pass2(d.errorSignature) : '';
        if (!title || title.length < 8 || !problem || steps.length === 0 || pitfalls.length === 0) continue;
        const body = {
          ...d.body,
          problem,
          steps,
          pitfalls,
          verification: fitRedacted(pass2(d.body.verification), 300),
          appliesWhen: fitRedacted(pass2(d.body.appliesWhen), 300),
        };
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
            fitRedacted(pass2(d.summary), HIGHLIGHT_SUMMARY_MAX),
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
        // Same transaction as the insert: a retry finds the highlights and would never screen them.
        await deps.jobs.enqueue('screen', { kind: 'highlight', id: hid }, { dedupeKey: `screen:h:${hid}`, tx });
      }
    }
    // I6: digests are purged once distilled.
    await tx.query(
      `update public.activity_chunks set digest_enc = null, digest_purged_at = now(), distilled_at = coalesce(distilled_at, now())
        where activity_id = $1`,
      [id],
    );
  });
};

/* ============================================================ review.draft */

/** Runs after a human decided a draft review item (api.decide_review in the web route). */
const reviewDraft: JobHandler = async (payload, deps) => {
  const reviewId = str(payload, 'reviewId');
  await deps.db.asService(async (tx) => {
    const rv = (await tx.query<Record<string, unknown>>('select * from public.review_items where id = $1', [reviewId])).rows[0];
    if (!rv || rv.kind !== 'draft') return;
    const ref = String(rv.ref_id);
    if (ref.startsWith('a_')) return reviewActivityDraft(deps, tx, ref.slice(2), String(rv.state), payload.edits);
    if (!ref.startsWith('h_')) return;
    const hid = ref.slice(2);
    if (rv.state === 'rejected') {
      await tx.query(`update public.highlights set status = 'archived', updated_at = now() where id = $1 and status = 'draft'`, [hid]);
      return;
    }
    if (rv.state !== 'approved') return;
    const edits = (payload.edits ?? {}) as { title?: unknown; summary?: unknown; fieldToggles?: unknown };
    // The owner's field toggles (DraftReview.fieldToggles): a missing toggle means "on".
    const toggles = (edits.fieldToggles && typeof edits.fieldToggles === 'object' ? edits.fieldToggles : {}) as Record<string, unknown>;
    if (toggles.highlight === false) {
      // The owner kept the highlight to themselves: nothing posts (the stats card is unaffected).
      await tx.query(`update public.highlights set status = 'archived', updated_at = now() where id = $1 and status = 'draft'`, [hid]);
      return;
    }
    let title = typeof edits.title === 'string' ? fitRedacted(pass2(edits.title), HIGHLIGHT_TITLE_MAX) : null;
    let summary = typeof edits.summary === 'string' ? fitRedacted(pass2(edits.summary), HIGHLIGHT_SUMMARY_MAX) : null;
    if (title !== null || summary !== null) {
      const s = screenAction([title, summary].filter(Boolean).join('\n'), 'highlight');
      if (s.action !== 'allow' && s.action !== 'label') {
        await tx.query(`update public.highlights set status = 'quarantined', screen_label = $2, screen_action = $3 where id = $1`, [hid, s.label, s.action]);
        return;
      }
    }
    if (toggles.title === false) title = NEUTRAL_HIGHLIGHT_TITLE;
    if (toggles.summary === false) summary = '';
    // Team visibility only while the owner still belongs to the highlight's team. Otherwise it
    // publishes private and lets go of the old team (an owner can update visibility but not
    // team_id, so it cannot be flipped back to that team later).
    const r = await tx.query<{ owner_user_id: string; team_id: string | null; activity_id: string | null; visibility: string }>(
      `with member as (
         select exists (select 1 from public.highlights x join public.team_members m on m.team_id = x.team_id and m.user_id = x.owner_user_id
                         where x.id = $1) as ok
       )
       update public.highlights h set status = 'active', published_at = now(),
          title = coalesce(nullif($2, ''), h.title), summary = coalesce($3, h.summary),
          visibility = case when h.team_id is not null and (select ok from member) then 'team' else 'private' end,
          team_id = case when (select ok from member) then h.team_id else null end,
          updated_at = now()
        where h.id = $1 and h.status = 'draft' and h.screen_action in ('allow', 'label')
        returning h.owner_user_id, h.team_id, h.activity_id, h.visibility::text as visibility`,
      [hid, title, summary],
    );
    const h = r.rows[0];
    if (!h) return;
    if (h.activity_id) {
      const teamId = h.visibility === 'team' ? h.team_id : null;
      await deps.bus.publish(
        { type: 'activity.updated', audienceAgentIds: [], audienceUserIds: await teamAudience(tx, teamId, h.owner_user_id), payload: { activityId: `a_${h.activity_id}` } },
        tx,
      );
    }
    await deps.jobs.enqueue('embed', { kind: 'highlight', id: hid }, { dedupeKey: `embed:h:${hid}`, tx });
  });
};

/**
 * An agent's post_activity draft (ref a_<id>): approving a 'draft' runs it through the card
 * screen and the publish flow; a DLP-held ('held') post never publishes on a plain approve.
 * Rejecting retires either.
 */
async function reviewActivityDraft(deps: CoreDeps, tx: Tx, activityId: string, state: string, rawEdits: unknown): Promise<void> {
  if (state === 'rejected') {
    await tx.query(
      `update public.activities set status = 'rejected', updated_at = now()
        where id = $1 and source = 'agent_reported' and status in ('draft', 'held')`,
      [activityId],
    );
    return;
  }
  if (state !== 'approved') return;
  // The owner's title/summary edits and field toggles apply before the card screen, so the
  // screen sees (and the team gets) the final text. A missing toggle means "on".
  const edits = (rawEdits && typeof rawEdits === 'object' ? rawEdits : {}) as { title?: unknown; summary?: unknown; fieldToggles?: unknown };
  const toggles = (edits.fieldToggles && typeof edits.fieldToggles === 'object' ? edits.fieldToggles : {}) as Record<string, unknown>;
  let title = typeof edits.title === 'string' ? fitRedacted(pass2(edits.title), ACTIVITY_TITLE_MAX) : null;
  const summary = typeof edits.summary === 'string' ? fitRedacted(pass2(edits.summary), ACTIVITY_SUMMARY_MAX) : null;
  if (toggles.title === false) title = NEUTRAL_ACTIVITY_TITLE;
  const r = await tx.query<{ id: string }>(
    `update public.activities set status = 'distilling', updated_at = now(),
        title = coalesce(nullif($2, ''), title),
        summary = case when $4 then null else coalesce(nullif($3, ''), summary) end
      where id = $1 and source = 'agent_reported' and status = 'draft' returning id`,
    [activityId, title, summary, toggles.summary === false],
  );
  if (r.rows[0]) await deps.jobs.enqueue('screen', { kind: 'activity', id: r.rows[0].id }, { dedupeKey: `screen:a:${r.rows[0].id}`, tx });
}

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
  // Keyed by tick: a reopened activity (resumed session) must be finalizable again.
  const tick = Math.floor(deps.now().getTime() / 60_000);
  await deps.db.asService(async (tx) => {
    const s = await tx.query<{ id: string }>(
      `update public.sessions set status = 'closed', close_reason = 'idle_timeout', ended_at = now(), updated_at = now()
        where status = 'open' and last_event_at < now() - make_interval(mins => $1) returning id`,
      [IDLE_MINUTES],
    );
    // I6 backstop: digests are purged within 24 h even if distill never ran (23 h leaves room for the tick).
    await tx.query(
      `update public.activity_chunks set digest_enc = null, digest_purged_at = now()
        where digest_enc is not null and received_at < now() - $1::interval`,
      [DIGEST_BACKSTOP],
    );
    if (s.rows.length === 0) return;
    const a = await tx.query<{ id: string }>(
      `select id from public.activities where session_id = any($1::uuid[]) and status = 'open'`,
      [s.rows.map((r) => r.id)],
    );
    // Same transaction as closing the sessions: the next close_idle only looks at open sessions.
    for (const { id } of a.rows) await deps.jobs.enqueue('finalize', { activityId: id }, { dedupeKey: `finalize:${id}:idle:${tick}`, tx });
  });
  await scheduleCloseIdle(deps);
};

/* =========================================================== purge_expired */

/**
 * Retention (api.purge_expired: events, digests, finished jobs, buckets, leases, ledger, link
 * tokens, review expiry). Supabase runs it from pg_cron; server mode (plain Postgres, PGlite)
 * has no pg_cron, so the worker runs it hourly. Idempotent, so running both is harmless.
 */
const purgeExpired: JobHandler = async (_payload, deps) => {
  await deps.db.asService((tx) => tx.query('select api.purge_expired()'));
  if (deps.config.mode === 'server') await schedulePurgeExpired(deps);
};

export async function schedulePurgeExpired(deps: CoreDeps): Promise<void> {
  const { slot, runAfterMs } = recurringSlot(deps.now().getTime(), PURGE_EVERY_MS);
  await deps.jobs.enqueue('purge_expired', {}, { dedupeKey: `purge_expired:${slot}`, runAfterMs });
}

export async function scheduleCloseIdle(deps: CoreDeps): Promise<void> {
  // Due just before a tick boundary: `now + period` would land after the cron tick and wait one more.
  const { slot, runAfterMs } = recurringSlot(deps.now().getTime(), CLOSE_IDLE_EVERY_MS);
  await deps.jobs.enqueue('close_idle', {}, { dedupeKey: `close_idle:${slot}`, runAfterMs });
}

/** Arm every self-rescheduling job: close_idle, presence_sweep and (server mode) purge_expired, deduped per bucket. */
export async function scheduleRecurring(deps: CoreDeps): Promise<void> {
  await scheduleCloseIdle(deps);
  await schedulePresenceSweep(deps);
  if (deps.config.mode === 'server') await schedulePurgeExpired(deps);
}

export const PLATFORM_JOBS: Record<string, JobHandler> = {
  finalize,
  screen,
  publish,
  distill_heuristic: distillHeuristic,
  'review.draft': reviewDraft,
  embed,
  close_idle: closeIdle,
  presence_sweep: presenceSweep,
  purge_expired: purgeExpired,
};
