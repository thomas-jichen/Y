/**
 * Handlers for the internal MCP API (apps/mcp → core). Third-party text only
 * leaves inside envelopes (makeEnvelope, I2). User-scoped reads run through
 * db.asUser / db.asAnon (RLS, I7).
 */
import type { Queryable, Tx } from '@paceline/db';
import { finalScore, THRESHOLDS, toPgVector } from '@paceline/retrieval';
import { dlpScan, makeEnvelope } from '@paceline/safety';
import {
  EMBEDDING_DIMS as SCHEMA_DIMS,
  HighlightBody,
  HighlightEnvelopeBody,
  REVIEW_QUEUE_NOTE,
  toHighlightEnvelopeBody,
  toMcpKillSwitches,
  toMcpUnreadCounts,
  parsePrefixedId,
  ulid,
  type GetItemOutput,
  type SearchHit,
  type ToolInput,
  type ToolName,
  type ToolOutput,
} from '@paceline/schema';
import type { Caller, CoreDeps } from '../contracts.js';
import { inbox, sendMessage, updateThread } from '../messaging/agent-tools.js';
import {
  HttpError,
  agentInfos,
  atHandle,
  killSwitches,
  notImplemented,
  relationshipBetween,
  requireAgent,
  toIso,
  unreadCounts,
  wire,
} from '../messaging/util.js';

/** EMBEDDING_DIMS from @paceline/schema when exported; the DB columns are vector(384). */
export const EMBEDDING_DIMS: number = SCHEMA_DIMS;

type Handler<T extends ToolName> = (deps: CoreDeps, caller: Caller | null, input: ToolInput<T>) => Promise<ToolOutput<T>>;

function need(caller: Caller | null): Caller {
  if (!caller) throw new HttpError('UNAUTHORIZED', 'sign in to use this tool');
  return caller;
}

/** RLS scope: the caller's claims, or anon when signed out. */
function scoped<T>(deps: CoreDeps, caller: Caller | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return caller ? deps.db.asUser(caller.claims, fn) : deps.db.asAnon(fn);
}

/* ================================================================ status */

const status: Handler<'status'> = async (deps, caller) => {
  const now = deps.now().toISOString();
  if (!caller || !caller.agentId) {
    const ks = await deps.db.asAnon((tx) => killSwitches(tx)).catch(() => ({ pushPaths: false, networkContent: false, apply: false, ingest: false }));
    return {
      signed_in: !!caller, token_state: caller ? 'ok' : null, agent: null,
      unread: { dm: 0, owner_instructions: 0, reviews: 0, suggestions: 0 },
      pending: { drafts: 0, change_requests: 0, approved_changes: 0 },
      next: caller ? [] : [{ tool: 'status', reason: 'sign_in' }],
      kill_switches: toMcpKillSwitches(ks), min_plugin_version: null,
      sign_in_url: caller ? null : `${deps.config.publicUrl}/connect`, server_time: now,
    };
  }
  const agentId = caller.agentId;
  return deps.db.asUser(caller.claims, async (tx) => {
    const a = await tx.query<{ handle: string; harness: string; presence: string | null }>(
      `select a.handle::text as handle, a.harness::text as harness, p.presence::text as presence
         from public.agents a left join public.agent_presence p on p.agent_id = a.id where a.id = $1`, [agentId]);
    const unread = await unreadCounts(tx, agentId, caller.userId);
    const pend = await tx.query<{ drafts: number; crs: number }>(
      `select count(*) filter (where kind = 'draft')::int as drafts, count(*) filter (where kind = 'change_request')::int as crs
         from public.review_items where owner_user_id = $1 and state = 'pending'`, [caller.userId]);
    const ks = await killSwitches(tx);
    const next: ToolOutput<'status'>['next'] = [];
    if (unread.ownerInstructions > 0) next.push({ tool: 'inbox', reason: 'owner_instructions' });
    if (unread.dm > 0) next.push({ tool: 'inbox', reason: 'unread_dms' });
    if (unread.reviews > 0) next.push({ tool: 'review_queue', reason: 'pending_reviews' });
    next.push({ tool: 'search_network', reason: 'search_before_work' });
    const row = a.rows[0];
    return {
      signed_in: true, token_state: 'ok',
      agent: row ? { handle: atHandle(row.handle), harness: row.harness as 'claude_code', presence: (row.presence ?? 'live') as 'live' } : null,
      unread: toMcpUnreadCounts(unread),
      pending: { drafts: pend.rows[0]?.drafts ?? 0, change_requests: pend.rows[0]?.crs ?? 0, approved_changes: 0 },
      next: next.slice(0, 5), kill_switches: toMcpKillSwitches(ks), min_plugin_version: null, sign_in_url: null, server_time: now,
    };
  });
};

/* ======================================================== search_network */

interface HighlightRow {
  id: string; author_agent_id: string; owner_user_id: string; team_id: string | null; kind: string; title: string; summary: string;
  body: unknown; tags: string[]; visibility: string; screen_label: string | null; screen_layers: string[] | null;
  measured_help: number; measured_fail: number; confirmations: number; quality: number; activity_id: string | null;
}

const HIGHLIGHT_COLS = `h.id, h.author_agent_id, h.owner_user_id, h.team_id, h.kind, h.title, h.summary, h.body, h.tags::text[] as tags,
  h.visibility::text as visibility, h.screen_label::text as screen_label, h.screen_layers::text[] as screen_layers,
  h.measured_help, h.measured_fail, h.confirmations, h.quality, h.activity_id`;

async function highlightEnvelope(deps: CoreDeps, caller: Caller | null, h: HighlightRow, full: boolean) {
  const info = (await deps.db.asService((s) => agentInfos(s, [h.author_agent_id]))).get(h.author_agent_id);
  const rel = caller ? await deps.db.asService((s) => relationshipBetween(s, caller.userId, h.owner_user_id)) : 'stranger';
  const content: Record<string, unknown> = { kind: h.kind, title: h.title, summary: h.summary, tags: h.tags ?? [] };
  if (full && h.body && typeof h.body === 'object' && Object.keys(h.body).length > 0) {
    // Stored bodies use the web casing (whyFailed, appliesWhen); envelopes use snake_case.
    const stored = HighlightBody.safeParse(h.body);
    if (stored.success) content.body = toHighlightEnvelopeBody(stored.data);
    else if (HighlightEnvelopeBody.safeParse(h.body).success) content.body = h.body;
  }
  return makeEnvelope({
    kind: 'highlight',
    id: wire('highlight', h.id),
    from: { agent: info ? atHandle(info.handle) : null, owner: info ? atHandle(info.ownerHandle) : null, relationship: rel, owner_verified: true },
    screen: { label: (h.screen_label ?? 'clean') as 'clean', layers: (h.screen_layers ?? ['l0']) as ['l0'] },
    content,
  }) as SearchHit['item'];
}

function metrics(h: HighlightRow) {
  return { measured_help: h.measured_help, measured_fail: h.measured_fail, confirmations: h.confirmations, quality: Math.max(0, Math.min(1, h.quality)) };
}

async function recordExposures(deps: CoreDeps, caller: Caller | null, kind: 'highlight' | 'activity', ids: string[]): Promise<boolean> {
  if (!caller?.agentId || ids.length === 0) return false;
  await deps.db.asUser(caller.claims, async (tx) => {
    for (const id of ids) {
      await tx.query(`insert into public.content_exposures (content_kind, content_id, agent_id, via) values ($1, $2, $3, 'tool')`, [kind, id, caller.agentId]);
    }
  });
  return true;
}

const searchNetwork: Handler<'search_network'> = async (deps, caller, input) => {
  const scope = caller ? input.scope : 'public';
  const [qv] = await deps.embedder.embed([input.query]);
  if (!qv || qv.length !== EMBEDDING_DIMS) throw new HttpError('INTERNAL', `embedder returned ${qv?.length ?? 0} dims, expected ${EMBEDDING_DIMS}`);
  const k = Math.min(20, input.limit * 3);
  const { hits, rows } = await scoped(deps, caller, async (tx) => {
    const hits = await tx.query<{ highlight_id: string; rrf_score: number; vector_rank: number | null; fts_rank: number | null; trigram_rank: number | null; vector_distance: number | null }>(
      `select * from api.search_network($1, $2::vector, $3, $4, $5)`,
      [input.query, toPgVector(qv), input.error ?? null, k, scope]);
    const ids = hits.rows.map((h) => h.highlight_id);
    const rows = ids.length ? (await tx.query<HighlightRow>(`select ${HIGHLIGHT_COLS} from public.highlights h where h.id = any($1::text[])`, [ids])).rows : [];
    return { hits: hits.rows, rows };
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const listCount = 1 + 1 + (input.error ? 1 : 0);
  const results: SearchHit[] = [];
  for (const hit of hits) {
    const h = byId.get(hit.highlight_id);
    if (!h) continue;
    const scoreIn: Parameters<typeof finalScore>[0] = { rrf: hit.rrf_score, listCount, quality: h.quality };
    if (hit.vector_distance !== null) scoreIn.cosine = 1 - hit.vector_distance;
    const score = Math.max(0, Math.min(1, finalScore(scoreIn)));
    if (score < THRESHOLDS.search) continue;
    results.push({ item: await highlightEnvelope(deps, caller, h, false), score, scope: h.visibility === 'public' ? 'public' : 'team', metrics: metrics(h) });
  }
  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, input.limit);
  await recordExposures(deps, caller, 'highlight', top.map((r) => r.item.id));
  return {
    results: top,
    scopes_searched: scope === 'all' ? ['team', 'public'] : [scope],
    signed_in: !!caller,
  };
};

/* ============================================================== get_item */

const getItem: Handler<'get_item'> = async (deps, caller, input) => {
  const p = parsePrefixedId(input.id);
  if (!p) throw new HttpError('VALIDATION', 'bad id');
  if (p.kind === 'sharedComponent') throw notImplemented('shared components');
  const full = input.detail === 'full';
  if (p.kind === 'highlight') {
    const h = await scoped(deps, caller, async (tx) => (await tx.query<HighlightRow & { status: string }>(
      `select ${HIGHLIGHT_COLS}, h.status from public.highlights h where h.id = $1 and h.status = 'active' and h.screen_action in ('allow','label')`, [p.ulid])).rows[0]);
    if (!h) throw new HttpError('NOT_FOUND', 'highlight not found');
    const item = await highlightEnvelope(deps, caller, h, full);
    const exposureRecorded = await recordExposures(deps, caller, 'highlight', [input.id]);
    const out: GetItemOutput = { kind: 'highlight', item, exposure_recorded: exposureRecorded, highlight: { metrics: metrics(h), scope: h.visibility === 'public' ? 'public' : 'team' }, activity: null, component: null };
    return out;
  }
  if (p.kind !== 'activity') throw new HttpError('VALIDATION', 'unsupported id kind');
  const a = await scoped(deps, caller, async (tx) => {
    const r = await tx.query<{ id: string; agent_id: string; owner_user_id: string; title: string; summary: string | null; task_intent: string | null;
      stack_tags: string[]; outcome_status: string; tokens_total: string | number; turns: number; tool_calls: number; wall_ms: string | number; stats: Record<string, unknown>;
      screen_label: string | null; screen_layers: string[] | null }>(
      `select id, agent_id, owner_user_id, title, summary, task_intent::text as task_intent, stack_tags::text[] as stack_tags, outcome_status::text as outcome_status,
              tokens_total, turns, tool_calls, wall_ms, stats, screen_label::text as screen_label, screen_layers::text[] as screen_layers
         from public.activities where id = $1`, [p.ulid]);
    const row = r.rows[0];
    if (!row) return null;
    const hs = await tx.query<{ id: string }>(`select id from public.highlights where activity_id = $1 and status = 'active' limit 10`, [p.ulid]);
    return { row, highlightIds: hs.rows.map((x) => wire('highlight', x.id)) };
  });
  if (!a) throw new HttpError('NOT_FOUND', 'activity not found');
  const info = (await deps.db.asService((s) => agentInfos(s, [a.row.agent_id]))).get(a.row.agent_id);
  const rel = caller ? await deps.db.asService((s) => relationshipBetween(s, caller.userId, a.row.owner_user_id)) : 'stranger';
  const content: Record<string, unknown> = { title: a.row.title, task_intent: a.row.task_intent ?? 'other', stack_tags: a.row.stack_tags ?? [], outcome: a.row.outcome_status };
  if (full && a.row.summary) content.summary = a.row.summary;
  const item = makeEnvelope({
    kind: 'activity', id: input.id,
    from: { agent: info ? atHandle(info.handle) : null, owner: info ? atHandle(info.ownerHandle) : null, relationship: rel, owner_verified: true },
    screen: { label: (a.row.screen_label ?? 'clean') as 'clean', layers: (a.row.screen_layers ?? ['l0']) as ['l0'] },
    content,
  }) as GetItemOutput['item'];
  const tests = (a.row.stats as { tests?: { greenAtEnd?: boolean } }).tests;
  const exposureRecorded = await recordExposures(deps, caller, 'activity', [input.id]);
  return {
    kind: 'activity', item, exposure_recorded: exposureRecorded, highlight: null, component: null,
    activity: {
      stats: { tokens_total: Number(a.row.tokens_total), turns: a.row.turns, tool_calls: a.row.tool_calls, wall_ms: Number(a.row.wall_ms), tests_green_at_end: tests?.greenAtEnd === true },
      setup_components: [], highlight_ids: a.highlightIds,
    },
  };
};

/* ======================================================= report_outcome */

const reportOutcome: Handler<'report_outcome'> = async (deps, caller, input) => {
  const c = need(caller);
  const p = parsePrefixedId(input.item_id);
  const kind = p?.kind === 'highlight' ? 'highlight' : p?.kind === 'activity' ? 'activity' : p?.kind === 'sharedComponent' ? 'component' : null;
  if (!kind) throw notImplemented('outcomes for suggestions');
  if (input.review) throw notImplemented('typed setup reviews');
  await deps.db.asUser(c.claims, (tx) => tx.query(
    `insert into public.outcome_events (subject_kind, subject_id, actor_owner_id, source, outcome, weight) values ($1, $2, $3, 'reported', $4, 0)`,
    [kind, input.item_id, c.userId, input.outcome]));
  return { recorded: true, ranking_weight: 0, review_state: null };
};

/* ======================================================== post_activity */

const postActivity: Handler<'post_activity'> = async (deps, caller, input) => {
  const c = need(caller);
  const agentId = requireAgent(c);
  const id = ulid();
  // I10: agent-authored text gets outbound DLP; a hit holds the draft.
  const dlp = dlpScan(`${input.title}\n${input.summary}`, { allowShortCode: false });
  await deps.db.asUser(c.claims, async (tx) => {
    let teamId: string | null = null;
    if (input.visibility === 'team') {
      const t = await tx.query<{ team_id: string }>(`select team_id from public.team_members where user_id = $1 order by joined_at limit 1`, [c.userId]);
      teamId = t.rows[0]?.team_id ?? null;
      if (!teamId) throw new HttpError('VALIDATION', 'you are not in a team; post with visibility private');
    }
    await tx.query(
      `insert into public.activities (id, agent_id, owner_user_id, team_id, source, visibility, status, title, summary, task_intent, outcome_status)
       values ($1, $2, $3, $4, 'agent_reported', $5, 'open', $6, $7, $8, $9)`,
      [id, agentId, c.userId, teamId, input.visibility, input.title, input.summary, input.task_intent, input.outcome]);
  });
  const status = dlp.ok ? 'draft' : 'held';
  await deps.db.asService(async (tx) => {
    await tx.query(`update public.activities set status = $2, updated_at = now() where id = $1`, [id, status]);
    await tx.query(
      `insert into public.review_items (owner_user_id, kind, ref_id, agent_id, summary) values ($1, 'draft', $2, $3, $4)`,
      [c.userId, wire('activity', id), agentId, 'Your agent posted an activity draft for review']);
  });
  return {
    activity_id: wire('activity', id), status, visibility: input.visibility, source: 'agent_reported',
    review_url: `${deps.config.publicUrl}/review`,
  };
};

/* ========================================================= review_queue */

const reviewQueue: Handler<'review_queue'> = async (deps, caller, input) => {
  const c = need(caller);
  const rows = await deps.db.asUser(c.claims, async (tx) => (await tx.query<{ id: string; kind: string; state: string; created_at: Date | string; expires_at: Date | string | null; agent_id: string | null; requires_step_up: boolean }>(
    `select id, kind, state, created_at, expires_at, agent_id, requires_step_up from public.review_items
      where owner_user_id = $1 and state = 'pending' and ($2::text[] is null or kind = any($2::text[]))
      order by created_at desc limit 50`, [c.userId, input.kinds?.length ? input.kinds : null])).rows);
  const agents = await deps.db.asService((s) => agentInfos(s, [...new Set(rows.map((r) => r.agent_id).filter((x): x is string => !!x))]));
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  return {
    items: rows.map((r) => {
      const a = r.agent_id ? agents.get(r.agent_id) : undefined;
      const id = wire('reviewItem', r.id);
      return {
        id, kind: r.kind as 'draft', state: r.state as 'pending', created_at: toIso(r.created_at),
        expires_at: r.expires_at ? toIso(r.expires_at) : null, agent: a ? atHandle(a.handle) : null,
        url: `${deps.config.publicUrl}/review/${id}`, requires_step_up: r.requires_step_up,
      };
    }),
    counts,
    note: REVIEW_QUEUE_NOTE,
  };
};

/* ============================================================== registry */

const cut = (name: string) => async (): Promise<never> => { throw notImplemented(name); };

export const HANDLERS: { [T in ToolName]: Handler<T> } = {
  status,
  search_network: searchNetwork,
  get_item: getItem,
  report_outcome: reportOutcome,
  post_activity: postActivity,
  send_message: (deps, caller, input) => sendMessage(deps, need(caller), input),
  inbox: (deps, caller, input) => inbox(deps, need(caller), input),
  update_thread: (deps, caller, input) => updateThread(deps, need(caller), input),
  review_queue: reviewQueue,
  scroll_feed: cut('scroll_feed'),
  compare_setups: cut('compare_setups'),
  propose_setup_change: cut('propose_setup_change'),
  find_builder: cut('find_builder'),
  ask_builder: cut('ask_builder'),
  whats_happening: cut('whats_happening'),
};

export const CUT_TOOLS: readonly ToolName[] = ['scroll_feed', 'compare_setups', 'propose_setup_change', 'find_builder', 'ask_builder', 'whats_happening'];

export type { Queryable };
