/**
 * Posts storage helpers: row shapes, agent-facing envelopes and metrics
 * (snake_case, I2), and the web view mappers (camelCase, packages/schema
 * posts.ts). Content reads run under the caller's RLS; the service role is
 * used only for identity metadata (handles, refs) and for counts over ids
 * already loaded under RLS (seen_by, reactor owners), as PLAN §10 allows.
 */
import type { Tx } from '@y/db';
import { makeEnvelope } from '@y/safety';
import {
  SCROLL_EXCERPT_CHARS,
  type AgentRef,
  type LearningEnvelope,
  type McpReactionCounts,
  type Post,
  type PostAttachment,
  type PostComment,
  type PostCommentEnvelope,
  type PostEnvelope,
  type PostMetrics,
  type PostReactions,
  type ReactionKind,
  type Screen,
  type ScrollSession,
  type ScrollStep,
  type Trust,
} from '@y/schema';
import type { Caller, CoreDeps } from '../contracts.js';
import { atHandle, agentInfos, relationshipBetween, toIso, userInfos, userRef, wire } from '../messaging/util.js';
import { loadAgentRefs } from '../platform/mappers.js';
import { stepLabel, type ScrollRow } from './scroll.js';

export const REACTION_KINDS = ['useful', 'tried', 'worked', 'didnt_work'] as const satisfies readonly ReactionKind[];

/** Agent-facing reads filter explicitly (never rely on the owner-sees-all branch of RLS). */
export const POST_VISIBLE_SQL = `p.status = 'published' and p.screen_action in ('allow','label')`;

export interface PostRow {
  id: string; author_agent_id: string; owner_user_id: string; team_id: string; kind: Post['kind']; body: string; tags: string[];
  attach_kind: 'activity' | 'highlight' | null; attach_id: string | null; status: string; screen_label: string | null;
  screen_layers: string[] | null; screen_categories: string[] | null; screen_action: string | null;
  published_at: Date | string | null; created_at: Date | string;
}

export const POST_COLS = `p.id, p.author_agent_id, p.owner_user_id, p.team_id, p.kind, p.body, p.tags::text[] as tags, p.attach_kind,
  p.attach_id::text as attach_id, p.status, p.screen_label::text as screen_label, p.screen_layers::text[] as screen_layers,
  p.screen_categories::text[] as screen_categories, p.screen_action::text as screen_action, p.published_at, p.created_at`;

export interface CommentRow {
  id: string; post_id: string; author_kind: 'agent' | 'user'; author_agent_id: string | null; author_user_id: string | null;
  owner_user_id: string; trust: string | null; body: string; status: string; screen_label: string | null;
  screen_layers: string[] | null; screen_categories: string[] | null; created_at: Date | string;
}

export const COMMENT_COLS = `c.id, c.post_id, c.author_kind, c.author_agent_id, c.author_user_id, c.owner_user_id, c.trust, c.body, c.status,
  c.screen_label::text as screen_label, c.screen_layers::text[] as screen_layers, c.screen_categories::text[] as screen_categories, c.created_at`;

/** Screen chip from stored columns; unscreened never looks clean (I8). */
export function screenOf(r: { screen_label: string | null; screen_layers: string[] | null; screen_categories?: string[] | null }): Screen {
  const s: Screen = { label: (r.screen_label ?? 'warn') as Screen['label'], layers: (r.screen_layers ?? []) as Screen['layers'] };
  if (r.screen_categories && r.screen_categories.length > 0) s.categories = r.screen_categories.slice(0, 8) as Screen['categories'];
  return s;
}

export function excerpt(text: string, max = SCROLL_EXCERPT_CHARS): { text: string; truncated: boolean } {
  const chars = [...text];
  if (chars.length <= max) return { text, truncated: false };
  // ASCII dots: envelopes NFKC-normalize text, which would turn '…' into three characters.
  return { text: `${chars.slice(0, max - 3).join('').trimEnd()}...`, truncated: true };
}

/* ============================================================ agent-facing */

/** Post envelope; `full` sends the whole body, else an excerpt. */
export async function postEnvelope(deps: CoreDeps, caller: Caller, p: PostRow, full: boolean): Promise<PostEnvelope> {
  const info = (await deps.db.asService((s) => agentInfos(s, [p.author_agent_id]))).get(p.author_agent_id);
  const rel = await deps.db.asService((s) => relationshipBetween(s, caller.userId, p.owner_user_id));
  const body = full ? { text: p.body, truncated: false } : excerpt(p.body);
  return makeEnvelope({
    kind: 'post',
    id: wire('post', p.id),
    from: { agent: info ? atHandle(info.handle) : null, owner: info ? atHandle(info.ownerHandle) : null, relationship: rel, owner_verified: true },
    screen: screenOf(p),
    content: {
      kind: p.kind, body: body.text, tags: p.tags ?? [],
      attachment: p.attach_kind && p.attach_id ? { kind: p.attach_kind, id: p.attach_id } : null,
      created_at: toIso(p.published_at ?? p.created_at), truncated: body.truncated,
    },
  }) as PostEnvelope;
}

/** Comment envelope (body excerpted). Human authors carry relationship `human_comment` (the human note). */
export async function commentEnvelopes(deps: CoreDeps, caller: Caller, rows: CommentRow[]): Promise<PostCommentEnvelope[]> {
  if (rows.length === 0) return [];
  const agentIds = [...new Set(rows.map((r) => r.author_agent_id).filter((x): x is string => !!x))];
  const userIds = [...new Set(rows.map((r) => r.author_user_id).filter((x): x is string => !!x))];
  const { agents, users, rels } = await deps.db.asService(async (s) => {
    const agents = await agentInfos(s, agentIds);
    const users = await userInfos(s, userIds);
    const rels = new Map<string, string>();
    for (const o of new Set(rows.filter((r) => r.author_kind === 'agent').map((r) => r.owner_user_id))) rels.set(o, await relationshipBetween(s, caller.userId, o));
    return { agents, users, rels };
  });
  return rows.map((r) => {
    const body = excerpt(r.body);
    const a = r.author_agent_id ? agents.get(r.author_agent_id) : undefined;
    const u = r.author_user_id ? users.get(r.author_user_id) : undefined;
    const from = r.author_kind === 'user'
      ? { agent: null, owner: u ? atHandle(u.handle) : null, relationship: 'human_comment' as const, owner_verified: true }
      : { agent: a ? atHandle(a.handle) : null, owner: a ? atHandle(a.ownerHandle) : null, relationship: (rels.get(r.owner_user_id) ?? 'stranger') as 'teammate', owner_verified: true };
    const content: Record<string, unknown> = { body: body.text, created_at: toIso(r.created_at) };
    if (body.truncated) content.truncated = true;
    return makeEnvelope({ kind: 'post_comment', id: wire('postComment', r.id), from, screen: screenOf(r), content }) as PostCommentEnvelope;
  });
}

export interface LearningRow {
  id: string; body: string; source_post_id: string | null; screen_label: string | null; screen_layers: string[] | null;
  screen_categories: string[] | null; created_at: Date | string;
}

export const LEARNING_COLS = `l.id, l.body, l.source_post_id, l.screen_label::text as screen_label, l.screen_layers::text[] as screen_layers,
  l.screen_categories::text[] as screen_categories, l.created_at`;

/** Kept learnings whose source post (if any) is still visible: the takedown hides what came from it. */
export const LEARNING_VISIBLE_SQL = `l.status = 'kept' and (l.source_post_id is null or exists (
  select 1 from public.posts sp where sp.id = l.source_post_id and sp.status = 'published' and sp.screen_action in ('allow','label')))`;

/** The reader's own learning (relationship `self`). Still an envelope: it was written by an agent. */
export function learningEnvelope(agentHandle: string | null, ownerHandle: string | null, l: LearningRow): LearningEnvelope {
  return makeEnvelope({
    kind: 'learning',
    id: wire('learning', l.id),
    from: { agent: agentHandle, owner: ownerHandle, relationship: 'self', owner_verified: true },
    screen: screenOf(l),
    content: { text: l.body, source_post_id: l.source_post_id ? wire('post', l.source_post_id) : null, created_at: toIso(l.created_at) },
  }) as LearningEnvelope;
}

const zeroCounts = (): McpReactionCounts => ({ useful: 0, tried: 0, worked: 0, didnt_work: 0 });

/**
 * Agent-facing metrics for posts already loaded under RLS (service counts):
 * reactions = distinct reactor owners per kind excluding the post owner;
 * comments = published comments; seen_by = distinct non-author owners with
 * an exposure. Display only (ranking weight 0, PLAN §8).
 */
export async function postMetrics(deps: CoreDeps, postIds: readonly string[]): Promise<Map<string, PostMetrics>> {
  const out = new Map<string, PostMetrics>();
  for (const id of postIds) out.set(id, { reactions: zeroCounts(), comments: 0, seen_by: 0 });
  if (postIds.length === 0) return out;
  await deps.db.asService(async (s) => {
    const ids = [...postIds];
    const reactions = await s.query<{ post_id: string; kind: ReactionKind; n: number }>(
      `select r.post_id, r.kind, count(distinct r.reactor_owner_id)::int as n
         from public.post_reactions r join public.posts p on p.id = r.post_id
        where r.post_id = any($1::text[]) and r.reactor_owner_id <> p.owner_user_id group by 1, 2`, [ids]);
    for (const r of reactions.rows) out.get(r.post_id)!.reactions[r.kind] = r.n;
    const comments = await s.query<{ post_id: string; n: number }>(
      `select post_id, count(*)::int as n from public.post_comments
        where post_id = any($1::text[]) and status = 'published' and screen_action in ('allow','label') group by 1`, [ids]);
    for (const r of comments.rows) out.get(r.post_id)!.comments = r.n;
    const seen = await s.query<{ post_id: string; n: number }>(
      `select p.id as post_id, count(distinct a.owner_user_id)::int as n
         from public.posts p join public.content_exposures e on e.content_kind = 'post' and e.content_id = 'ps_' || p.id
         join public.agents a on a.id = e.agent_id
        where p.id = any($1::text[]) and a.owner_user_id <> p.owner_user_id group by 1`, [ids]);
    for (const r of seen.rows) out.get(r.post_id)!.seen_by = r.n;
  });
  return out;
}

/** True when this agent has an exposure of the post (PLAN §9: react and comment only after real reading). */
export async function hasExposure(tx: Tx, agentId: string, postId: string): Promise<boolean> {
  const r = await tx.query(`select 1 from public.content_exposures where agent_id = $1 and content_kind = 'post' and content_id = $2 limit 1`,
    [agentId, wire('post', postId)]);
  return r.rowCount > 0;
}

/** Owner plus the post team's members (≤100): the audience of post events. */
export async function postAudience(tx: Tx, teamId: string, ownerId: string): Promise<string[]> {
  const r = await tx.query<{ user_id: string }>('select user_id from public.team_members where team_id = $1 limit 100', [teamId]);
  return [...new Set([ownerId, ...r.rows.map((x) => x.user_id)])].slice(0, 100);
}

/* ================================================================== web */

/** Web reactions: count = every reactor, sample = up to 3 agent reactors newest first, viewerReacted = the viewer human's own. */
async function webReactions(deps: CoreDeps, caller: Caller, postIds: string[]): Promise<Map<string, PostReactions>> {
  const out = new Map<string, PostReactions>();
  const empty = (): PostReactions => ({
    useful: { count: 0, sample: [], viewerReacted: false }, tried: { count: 0, sample: [], viewerReacted: false },
    worked: { count: 0, sample: [], viewerReacted: false }, didnt_work: { count: 0, sample: [], viewerReacted: false },
  });
  for (const id of postIds) out.set(id, empty());
  if (postIds.length === 0) return out;
  const rows = await deps.db.asUser(caller.claims, async (tx) => (await tx.query<{ post_id: string; reactor_kind: 'agent' | 'user'; reactor_id: string; kind: ReactionKind }>(
    `select post_id, reactor_kind, reactor_id, kind from public.post_reactions where post_id = any($1::text[]) order by created_at desc`, [postIds])).rows);
  const agentIds = [...new Set(rows.filter((r) => r.reactor_kind === 'agent').map((r) => r.reactor_id))];
  const refs = await deps.db.asService((s) => loadAgentRefs(s, agentIds, caller.userId));
  for (const r of rows) {
    const sum = out.get(r.post_id)?.[r.kind];
    if (!sum) continue;
    sum.count += 1;
    if (r.reactor_kind === 'agent') {
      const ref = refs.get(r.reactor_id);
      if (ref && sum.sample.length < 3) sum.sample.push(ref);
    } else if (r.reactor_id === caller.userId) sum.viewerReacted = true;
  }
  return out;
}

/** Response of a react toggle (web). */
export async function webReactionsFor(deps: CoreDeps, caller: Caller, postId: string): Promise<PostReactions> {
  return (await webReactions(deps, caller, [postId])).get(postId)!;
}

/** Map comments for a web viewer: trust per reader (agents) or human_comment; body only when published. */
export async function webComments(deps: CoreDeps, caller: Caller, rows: CommentRow[]): Promise<PostComment[]> {
  if (rows.length === 0) return [];
  const agentIds = [...new Set(rows.map((r) => r.author_agent_id).filter((x): x is string => !!x))];
  const userIds = [...new Set(rows.map((r) => r.author_user_id).filter((x): x is string => !!x))];
  const { refs, users, rels } = await deps.db.asService(async (s) => {
    const refs = await loadAgentRefs(s, agentIds, caller.userId);
    const users = await userInfos(s, userIds);
    const rels = new Map<string, string>();
    for (const o of new Set(rows.filter((r) => r.author_kind === 'agent').map((r) => r.owner_user_id))) rels.set(o, await relationshipBetween(s, caller.userId, o));
    return { refs, users, rels };
  });
  const out: PostComment[] = [];
  for (const r of rows) {
    let author: PostComment['author'];
    let trust: Trust;
    if (r.author_kind === 'user') {
      const u = r.author_user_id ? users.get(r.author_user_id) : undefined;
      if (!u) continue;
      author = { kind: 'user', user: userRef(u) };
      trust = 'human_comment';
    } else {
      const ref = r.author_agent_id ? refs.get(r.author_agent_id) : undefined;
      if (!ref) continue;
      author = { kind: 'agent', agent: ref };
      const rel = rels.get(r.owner_user_id);
      trust = rel === 'self' || rel === 'teammate' ? 'teammate' : 'stranger';
    }
    out.push({
      id: wire('postComment', r.id) as PostComment['id'], postId: wire('post', r.post_id) as PostComment['postId'], author, trust,
      body: r.status === 'published' ? r.body : '', createdAt: toIso(r.created_at), screen: screenOf(r),
    });
  }
  return out;
}

async function webAttachments(tx: Tx, posts: PostRow[]): Promise<Map<string, PostAttachment>> {
  const out = new Map<string, PostAttachment>();
  const acts = posts.filter((p) => p.attach_kind === 'activity' && p.attach_id).map((p) => p.attach_id!.slice(2));
  const hls = posts.filter((p) => p.attach_kind === 'highlight' && p.attach_id).map((p) => p.attach_id!.slice(2));
  if (acts.length) {
    const r = await tx.query<{ id: string; title: string; tokens_total: string | number; tool_calls: number; active_ms: string | number; outcome_status: string }>(
      `select id, title, tokens_total, tool_calls, active_ms, outcome_status::text as outcome_status from public.activities
        where id = any($1::text[]) and status = 'published'`, [acts]);
    for (const a of r.rows) {
      out.set(`a_${a.id}`, { kind: 'activity', activityId: `a_${a.id}`, title: a.title.slice(0, 120), tokens: Number(a.tokens_total),
        toolCalls: a.tool_calls, activeMs: Number(a.active_ms), outcome: a.outcome_status as Extract<PostAttachment, { kind: 'activity' }>['outcome'] });
    }
  }
  if (hls.length) {
    const r = await tx.query<{ id: string; title: string; summary: string; measured_help: number }>(
      `select id, title, summary, measured_help from public.highlights
        where id = any($1::text[]) and status = 'active' and screen_action in ('allow','label')`, [hls]);
    for (const h of r.rows) {
      out.set(`h_${h.id}`, { kind: 'highlight', highlightId: `h_${h.id}`, title: h.title.slice(0, 90), summary: h.summary.slice(0, 400), measuredHelp: h.measured_help });
    }
  }
  return out;
}

const QUARANTINE_REASON: Record<string, string> = {
  quarantined: 'flagged by screening', removed: 'removed', held: 'held for review', screening: 'screening',
};

/**
 * Web posts for ids the viewer can see (RLS), in the given order. Bodies
 * are withheld (`''`) unless published and screened allow|label: the owner
 * sees their own other posts as `quarantined`.
 */
export async function loadWebPosts(deps: CoreDeps, caller: Caller, ids: readonly string[]): Promise<Post[]> {
  if (ids.length === 0) return [];
  const loaded = await deps.db.asUser(caller.claims, async (tx) => {
    const posts = (await tx.query<PostRow>(`select ${POST_COLS} from public.posts p where p.id = any($1::text[])`, [[...ids]])).rows;
    const visible = posts.filter((p) => p.status === 'published').map((p) => p.id);
    const counts = visible.length ? (await tx.query<{ post_id: string; n: number }>(
      `select post_id, count(*)::int as n from public.post_comments c
        where c.post_id = any($1::text[]) and c.status = 'published' and c.screen_action in ('allow','label') group by 1`, [visible])).rows : [];
    const tops = visible.length ? (await tx.query<CommentRow>(
      `select distinct on (c.post_id) ${COMMENT_COLS} from public.post_comments c
        where c.post_id = any($1::text[]) and c.author_kind = 'agent' and c.status = 'published' and c.screen_action in ('allow','label')
        order by c.post_id, c.created_at desc, c.id desc`, [visible])).rows : [];
    const attachments = await webAttachments(tx, posts.filter((p) => p.status === 'published'));
    return { posts, counts, tops, attachments };
  });
  const published = loaded.posts.filter((p) => p.status === 'published').map((p) => p.id);
  const reactions = await webReactions(deps, caller, published);
  const { refs, seen } = await deps.db.asService(async (s) => {
    const refs = await loadAgentRefs(s, loaded.posts.map((p) => p.author_agent_id), caller.userId);
    const seen = published.length ? (await s.query<{ post_id: string; n: number }>(
      `select substr(e.content_id, 4) as post_id, count(distinct e.agent_id)::int as n from public.content_exposures e
        where e.content_kind = 'post' and e.content_id = any($1::text[]) group by 1`, [published.map((id) => wire('post', id))])).rows : [];
    return { refs, seen };
  });
  const tops = new Map((await webComments(deps, caller, loaded.tops)).map((c) => [c.postId, c]));
  const countBy = new Map(loaded.counts.map((r) => [r.post_id, r.n]));
  const seenBy = new Map(seen.map((r) => [r.post_id, r.n]));
  const byId = new Map(loaded.posts.map((p) => [p.id, p]));
  const out: Post[] = [];
  for (const id of ids) {
    const p = byId.get(id);
    const author = p ? refs.get(p.author_agent_id) : undefined;
    if (!p || !author) continue;
    const pub = p.status === 'published' && (p.screen_action === 'allow' || p.screen_action === 'label');
    const post: Post = {
      id: wire('post', p.id) as Post['id'], author, kind: p.kind, body: pub ? p.body : '', createdAt: toIso(p.published_at ?? p.created_at),
      reactions: reactions.get(p.id) ?? emptyReactions(),
      commentCount: pub ? countBy.get(p.id) ?? 0 : 0, seenBy: pub ? seenBy.get(p.id) ?? 0 : 0,
      screen: screenOf(p), state: pub ? 'published' : 'quarantined', tags: (p.tags ?? []) as Post['tags'],
    };
    if (!pub) post.quarantineReason = QUARANTINE_REASON[p.status] ?? 'not published';
    const att = pub && p.attach_id ? loaded.attachments.get(p.attach_id) : undefined;
    if (att) post.attachment = att;
    const top = pub ? tops.get(wire('post', p.id)) : undefined;
    if (top) post.topComment = top;
    out.push(post);
  }
  return out;
}

function emptyReactions(): PostReactions {
  const s = () => ({ count: 0, sample: [] as AgentRef[], viewerReacted: false });
  return { useful: s(), tried: s(), worked: s(), didnt_work: s() };
}

/** Scroll sessions (owner view) with templated step labels; `text` only for published comments and kept learnings. */
export async function loadWebScrolls(deps: CoreDeps, caller: Caller, rows: ScrollRow[]): Promise<ScrollSession[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const own = await deps.db.asUser(caller.claims, async (tx) => {
    const steps = (await tx.query<{ id: string; scroll_id: string; kind: ScrollStep['kind']; post_id: string | null; comment_id: string | null;
      learning_id: string | null; reaction: ReactionKind | null; created_at: Date | string }>(
      `select id, scroll_id, kind, post_id, comment_id, learning_id, reaction, created_at from public.scroll_steps
        where scroll_id = any($1::text[]) order by scroll_id, seq limit 5000`, [ids])).rows;
    const commentIds = steps.map((s) => s.comment_id).filter((x): x is string => !!x);
    const comments = commentIds.length ? (await tx.query<{ id: string; body: string; status: string }>(
      `select id, body, status from public.post_comments where id = any($1::text[])`, [commentIds])).rows : [];
    const learnings = (await tx.query<LearningRow & { scroll_id: string; status: string }>(
      `select ${LEARNING_COLS}, l.scroll_id, l.status from public.scroll_learnings l where l.scroll_id = any($1::text[]) order by l.created_at`, [ids])).rows;
    return { steps, comments, learnings };
  });
  // Trusted fields of read posts (kind enum, author handle) and source authors: identity metadata only.
  const postIds = [...new Set([...own.steps.map((s) => s.post_id), ...own.learnings.map((l) => l.source_post_id)].filter((x): x is string => !!x))];
  const meta = await deps.db.asService(async (s) => {
    const posts = postIds.length ? (await s.query<{ id: string; kind: string; author_agent_id: string }>(
      `select id, kind, author_agent_id from public.posts where id = any($1::text[])`, [postIds])).rows : [];
    const refs = await loadAgentRefs(s, [...rows.map((r) => r.agent_id), ...posts.map((p) => p.author_agent_id)], caller.userId);
    return { posts: new Map(posts.map((p) => [p.id, p])), refs };
  });
  const comments = new Map(own.comments.map((c) => [c.id, c]));
  const learnings = new Map(own.learnings.map((l) => [l.id, l]));
  const out: ScrollSession[] = [];
  for (const r of rows) {
    const agent = meta.refs.get(r.agent_id);
    if (!agent) continue;
    const steps: ScrollStep[] = own.steps.filter((s) => s.scroll_id === r.id).slice(0, 500).map((s) => {
      const post = s.post_id ? meta.posts.get(s.post_id) : undefined;
      const author = post ? meta.refs.get(post.author_agent_id) : undefined;
      const step: ScrollStep = {
        id: wire('scrollStep', s.id) as ScrollStep['id'], at: toIso(s.created_at), kind: s.kind,
        label: stepLabel(s.kind, { authorHandle: author?.handle ?? null, postKind: post?.kind ?? null, reaction: s.reaction }),
      };
      if (s.post_id) step.postId = wire('post', s.post_id) as ScrollStep['postId'];
      if (s.reaction) step.reaction = s.reaction;
      const c = s.comment_id ? comments.get(s.comment_id) : undefined;
      if (c && c.status === 'published') step.text = c.body;
      const l = s.learning_id ? learnings.get(s.learning_id) : undefined;
      if (l && l.status === 'kept') step.text = l.body;
      return step;
    });
    const session: ScrollSession = {
      id: wire('scroll', r.id) as ScrollSession['id'], agent, state: r.state, startedAt: toIso(r.started_at),
      budget: { posts: r.budget_posts, tokens: r.budget_tokens }, used: { posts: r.used_posts, tokens: r.used_tokens },
      steps,
      learnings: own.learnings.filter((l) => l.scroll_id === r.id && l.status === 'kept').slice(0, 20).map((l) => {
        const src = l.source_post_id ? meta.posts.get(l.source_post_id) : undefined;
        const sourceAgent = src ? meta.refs.get(src.author_agent_id) : undefined;
        return {
          id: wire('learning', l.id) as ScrollSession['learnings'][number]['id'], text: l.body,
          ...(l.source_post_id ? { sourcePostId: wire('post', l.source_post_id) } : {}),
          ...(sourceAgent ? { sourceAgent } : {}),
        } as ScrollSession['learnings'][number];
      }),
      proposals: [],
    };
    if (r.ended_at) session.endedAt = toIso(r.ended_at);
    out.push(session);
  }
  return out;
}
