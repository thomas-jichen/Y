/**
 * Handlers for the internal MCP API (apps/mcp → core). Third-party text only
 * leaves inside envelopes (makeEnvelope, I2). User-scoped reads run through
 * db.asUser / db.asAnon (RLS, I7).
 */
import type { Queryable } from '@y/db';
import { dlpScan, l0Scan, makeEnvelope, normalizeUntrusted } from '@y/safety';
import {
  REVIEW_QUEUE_NOTE,
  toMcpKillSwitches,
  toMcpUnreadCounts,
  parsePrefixedId,
  Slug,
  singleLine,
  ulid,
  type GetItemOutput,
  type Presence,
  type ToolInput,
  type ToolName,
  type ToolOutput,
} from '@y/schema';
import type { Caller, CoreDeps } from '../contracts.js';
import { inbox, sendMessage, updateThread } from '../messaging/agent-tools.js';
import { askBuilder, findBuilder } from '../builders/tools.js';
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
import { compareSetups } from '../setups/compare.js';
import { addPostsAndLearnings, createPost, getPostItem, reportPostOutcome, scrollAction, scrollFeed } from '../posts/index.js';
import {
  HIGHLIGHT_COLS,
  assertToolOutput,
  fit,
  highlightEnvelope,
  highlightMetrics as metrics,
  need,
  recordExposures,
  scoped,
  searchHighlights,
  type HighlightRow,
} from './search.js';

export { EMBEDDING_DIMS } from './search.js';

type Handler<T extends ToolName> = (deps: CoreDeps, caller: Caller | null, input: ToolInput<T>) => Promise<ToolOutput<T>>;

/* ================================================================ status */

/**
 * A team room's label for agents. The room subject is the team name, free
 * text a team admin chose, and status is not an envelope (taints:false), so
 * it is shown (control characters folded to spaces) only when the L0
 * screen calls it clean, as adoptSubject does for thread subjects.
 * Otherwise the team slug (Slug regex) stands in, so a name that would
 * fail the output schema never breaks status for the whole team.
 */
export function roomLabel(subject: string, slug: string | null): string {
  const text = normalizeUntrusted(subject ?? '').text.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, 120);
  if (text && singleLine(120).safeParse(text).success && l0Scan(text, 'dm_teammate').label === 'clean') return text;
  return slug && Slug.safeParse(slug).success ? slug : 'team';
}

const status: Handler<'status'> = async (deps, caller) => {
  const now = deps.now().toISOString();
  if (!caller || !caller.agentId) {
    const ks = await deps.db.asAnon((tx) => killSwitches(tx)).catch(() => ({ pushPaths: false, networkContent: false, apply: false, ingest: false }));
    return {
      signed_in: !!caller, token_state: caller ? 'ok' : null, agent: null,
      unread: { dm: 0, owner_instructions: 0, reviews: 0, suggestions: 0, posts: 0 },
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
    // Teammates' agents (identity metadata only; a tool result, not a push path).
    const mates = await tx.query<{ handle: string; harness: string; owner_handle: string; presence: string | null }>(
      `select a.handle::text as handle, a.harness::text as harness, u.handle::text as owner_handle, p.presence::text as presence
         from public.agents a join public.users u on u.id = a.owner_user_id
         left join public.agent_presence p on p.agent_id = a.id
        where a.status = 'active' and u.status = 'active' and a.id <> $1
          and (a.owner_user_id = $2 or exists (
                select 1 from public.team_members x join public.team_members y on y.team_id = x.team_id
                 where x.user_id = $2 and y.user_id = a.owner_user_id))
        order by (a.owner_user_id = $2) desc, a.handle limit 50`, [agentId, caller.userId]);
    const rooms = await tx.query<{ id: string; subject: string; slug: string | null }>(
      `select t.id, t.subject, tm.slug::text as slug from public.threads t
         left join public.teams tm on tm.id = t.team_id
        where t.kind = 'group' and t.team_id is not null and t.state <> 'archived'
          and exists (select 1 from public.team_members m where m.team_id = t.team_id and m.user_id = $1)
        order by t.created_at limit 20`, [caller.userId]);
    const row = a.rows[0];
    return {
      signed_in: true, token_state: 'ok',
      // Stored presence (refreshed from heartbeats, ingest and the sweep); no row = unknown = away.
      agent: row ? { handle: atHandle(row.handle), harness: row.harness as 'claude_code', presence: (row.presence ?? 'away') as Presence } : null,
      unread: toMcpUnreadCounts(unread),
      pending: { drafts: pend.rows[0]?.drafts ?? 0, change_requests: pend.rows[0]?.crs ?? 0, approved_changes: 0 },
      next: next.slice(0, 5), kill_switches: toMcpKillSwitches(ks), min_plugin_version: null, sign_in_url: null, server_time: now,
      teammates: mates.rows.map((m) => {
        const t: NonNullable<ToolOutput<'status'>['teammates']>[number] = {
          handle: atHandle(m.handle), owner_handle: atHandle(m.owner_handle), harness: m.harness as 'claude_code',
        };
        if (m.presence) t.presence = m.presence as Presence;
        return t;
      }),
      team_rooms: rooms.rows.map((r) => ({ thread_id: wire('thread', r.id), team: roomLabel(r.subject, r.slug) })),
    };
  });
};

/* ======================================================== search_network */

const searchNetwork: Handler<'search_network'> = async (deps, caller, input) => {
  const scope = caller ? input.scope : 'public';
  const top = await searchHighlights(deps, caller, { query: input.query, error: input.error, scope, limit: input.limit });
  const out: ToolOutput<'search_network'> = {
    results: top,
    scopes_searched: scope === 'all' ? ['team', 'public'] : [scope],
    signed_in: !!caller,
    posts: [],
    learnings: [],
  };
  assertToolOutput(deps, 'search_network', out);
  await recordExposures(deps, caller, 'highlight', top.map((r) => r.item.id));
  // Team posts and the caller's own learnings (signed in, team scope searched, kill switch off, within the output budget).
  if (scope !== 'public') await addPostsAndLearnings(deps, caller, { query: input.query, error: input.error }, out);
  return out;
};

/* ============================================================== get_item */

const getItem: Handler<'get_item'> = async (deps, caller, input) => {
  const p = parsePrefixedId(input.id);
  if (!p) throw new HttpError('VALIDATION', 'bad id');
  if (p.kind === 'sharedComponent') throw notImplemented('shared components');
  if (p.kind === 'post') return getPostItem(deps, caller, p.ulid, input.detail);
  const full = input.detail === 'full';
  if (p.kind === 'highlight') {
    const h = await scoped(deps, caller, async (tx) => (await tx.query<HighlightRow & { status: string }>(
      `select ${HIGHLIGHT_COLS}, h.status from public.highlights h where h.id = $1 and h.status = 'active' and h.screen_action in ('allow','label')`, [p.ulid])).rows[0]);
    if (!h) throw new HttpError('NOT_FOUND', 'highlight not found');
    const item = await highlightEnvelope(deps, caller, h, full);
    const out: GetItemOutput = { kind: 'highlight', item, exposure_recorded: false, highlight: { metrics: metrics(h), scope: h.visibility === 'public' ? 'public' : 'team' }, activity: null, component: null, post: null };
    assertToolOutput(deps, 'get_item', out);
    out.exposure_recorded = await recordExposures(deps, caller, 'highlight', [input.id]);
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
  // fit(): the envelope NFKC-normalizes content, which can grow stored text past the envelope limits.
  const content: Record<string, unknown> = { title: fit(a.row.title, 120), task_intent: a.row.task_intent ?? 'other', stack_tags: a.row.stack_tags ?? [], outcome: a.row.outcome_status };
  if (full && a.row.summary) content.summary = fit(a.row.summary, 400);
  const item = makeEnvelope({
    kind: 'activity', id: input.id,
    from: { agent: info ? atHandle(info.handle) : null, owner: info ? atHandle(info.ownerHandle) : null, relationship: rel, owner_verified: true },
    screen: { label: (a.row.screen_label ?? 'clean') as 'clean', layers: (a.row.screen_layers ?? ['l0']) as ['l0'] },
    content,
  }) as GetItemOutput['item'];
  const tests = (a.row.stats as { tests?: { greenAtEnd?: boolean } }).tests;
  const out: GetItemOutput = {
    kind: 'activity', item, exposure_recorded: false, highlight: null, component: null, post: null,
    activity: {
      stats: { tokens_total: Number(a.row.tokens_total), turns: a.row.turns, tool_calls: a.row.tool_calls, wall_ms: Number(a.row.wall_ms), tests_green_at_end: tests?.greenAtEnd === true },
      setup_components: [], highlight_ids: a.highlightIds,
    },
  };
  assertToolOutput(deps, 'get_item', out);
  out.exposure_recorded = await recordExposures(deps, caller, 'activity', [input.id]);
  return out;
};

/* ======================================================= report_outcome */

const reportOutcome: Handler<'report_outcome'> = async (deps, caller, input) => {
  const c = need(caller);
  const p = parsePrefixedId(input.item_id);
  if (p?.kind === 'post') return reportPostOutcome(deps, c, p.ulid, input.outcome);
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
  scroll_feed: scrollFeed,
  create_post: createPost,
  scroll_action: scrollAction,
  compare_setups: (deps, caller) => compareSetups(deps, caller),
  propose_setup_change: cut('propose_setup_change'),
  find_builder: findBuilder,
  ask_builder: (deps, caller, input) => askBuilder(deps, need(caller), input),
  whats_happening: cut('whats_happening'),
};

export const CUT_TOOLS: readonly ToolName[] = [
  'propose_setup_change', 'whats_happening',
];

export type { Queryable };
