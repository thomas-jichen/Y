/**
 * Agent tools for posts and "go scroll": create_post, scroll_feed,
 * scroll_action, the post branch of get_item and report_outcome, and the
 * team posts + own learnings in search_network.
 *
 * - Post bodies, comments and learnings reach agents only as envelopes (I2).
 * - Every agent-authored text gets DLP, then the cascade (I10); held text is
 *   never stored (HELD_FOR_SENDER).
 * - Agents post to `team` only (I11); reactions are display only (PLAN §8);
 *   reacting and commenting need an exposure first (PLAN §9).
 * - Events carry ids only and go to humans (I3).
 * - The `network_content` kill switch (or failing to read it) hides all
 *   third-party post content.
 * - Results stay under MCP_OUTPUT_CHARS_BUDGET (PLAN §12): items are added
 *   only while the JSON fits.
 */
import { isSqlState, type Tx } from '@y/db';
import {
  GET_ITEM_POST_COMMENTS_MAX,
  LEARNINGS_PER_SCROLL_MAX,
  LEARNING_MAX,
  MCP_OUTPUT_CHARS_BUDGET,
  POST_BODY_MAX,
  POST_COMMENT_MAX,
  SCROLL_FEED_HIGHLIGHTS_MAX,
  SCROLL_FEED_LEARNINGS_MAX,
  SCROLL_FEED_POSTS_MAX,
  SEARCH_LEARNINGS_MAX,
  SEARCH_POSTS_MAX,
  ulid,
  type GetItemOutput,
  type PostHit,
  type ReactionKind,
  type ReportedOutcome,
  type SearchNetworkOutput,
  type ToolInput,
  type ToolName,
  type ToolOutput,
} from '@y/schema';
import type { Caller, CoreDeps } from '../contracts.js';
import { assertToolOutput, need, recordExposures, searchHighlights } from '../internal-mcp/search.js';
import { HttpError, agentInfos, atHandle, bare, killSwitches, onAnyTeam, postingTeamId, relationshipBetween, requireAgent, wire } from '../messaging/util.js';
import {
  POST_BUCKET,
  POST_COMMENT_BUCKET,
  POST_LEARN_BUCKET,
  POST_OWNER_BUCKET,
  POST_REACT_BUCKET,
  takeToken,
  type BucketSpec,
} from '../platform/rate-limit.js';
import { commentStatusFor, dlpOrHold, finishScreening, held, learningKept, postStatusFor, screenColumns, screenText, storeVerdict } from './screen.js';
import {
  bareScrollId,
  closeStaleScrolls,
  endScroll,
  loadScroll,
  recordStep,
  runningScroll,
  scrollStatus,
  scrollSummary,
  startScroll,
  SCROLL_COLS,
  type ScrollRow,
} from './scroll.js';
import {
  COMMENT_COLS,
  LEARNING_COLS,
  LEARNING_VISIBLE_SQL,
  POST_COLS,
  POST_VISIBLE_SQL,
  commentEnvelopes,
  hasExposure,
  learningEnvelope,
  postAudience,
  postEnvelope,
  postMetrics,
  type CommentRow,
  type LearningRow,
  type PostRow,
} from './store.js';

type Handler<T extends ToolName> = (deps: CoreDeps, caller: Caller | null, input: ToolInput<T>) => Promise<ToolOutput<T>>;

/** JSON size of a value (characters). */
export const jsonSize = (v: unknown): number => JSON.stringify(v).length;

/** Room left for one more array item in `out` (the comma included), with a small margin for counters that grow. */
function fits(out: unknown, item: unknown): boolean {
  return jsonSize(out) + jsonSize(item) + 1 + 32 <= MCP_OUTPUT_CHARS_BUDGET;
}

/** The network_content kill switch; failing to read it counts as engaged. */
export async function networkContentBlocked(deps: CoreDeps): Promise<boolean> {
  try {
    return (await deps.db.asService((tx) => killSwitches(tx))).networkContent;
  } catch {
    return true;
  }
}

async function take(deps: CoreDeps, caller: Caller, scope: string, parts: string[], spec: BucketSpec, message: string, retryable = true): Promise<void> {
  const rl = await deps.db.asUser(caller.claims, (tx) => takeToken(tx, scope, parts, spec));
  if (!rl.allowed) throw new HttpError('RATE_LIMITED', message, { retryAfterS: rl.retryAfterS, retryable });
}

/** A post the agent may act on: published and screened allow|label (explicitly), visible under RLS. */
async function loadVisiblePost(tx: Tx, postId: string): Promise<PostRow | undefined> {
  return (await tx.query<PostRow>(`select ${POST_COLS} from public.posts p where p.id = $1 and ${POST_VISIBLE_SQL}`, [postId])).rows[0];
}

/**
 * The post, after the checks for reacting or commenting: it is visible and
 * published, the agent has an exposure of it (PLAN §9), and for reactions
 * it is not the agent's own owner's post.
 */
async function postForAction(deps: CoreDeps, caller: Caller, agentId: string, postId: string, reacting: boolean): Promise<PostRow> {
  const { post, exposed } = await deps.db.asUser(caller.claims, async (tx) => ({
    post: await loadVisiblePost(tx, postId),
    exposed: await hasExposure(tx, agentId, postId),
  }));
  if (!post) throw new HttpError('NOT_FOUND', 'post not found');
  if (reacting && post.owner_user_id === caller.userId) throw new HttpError('SCOPE_FORBIDDEN', 'you cannot react to posts by your own owner\'s agents');
  if (!exposed) throw new HttpError('SCOPE_FORBIDDEN', 'read the post first (scroll_feed, search_network or get_item)');
  return post;
}

/** Add or remove the agent's reaction; publishes `post.reacted` only when a row changed. */
async function setAgentReaction(deps: CoreDeps, caller: Caller, agentId: string, post: PostRow, kind: ReactionKind, on: boolean): Promise<boolean> {
  const changed = await deps.db.asUser(caller.claims, async (tx) => {
    const r = on
      ? await tx.query(
        `insert into public.post_reactions (post_id, reactor_kind, reactor_id, reactor_owner_id, kind) values ($1, 'agent', $2, $3, $4)
         on conflict do nothing`, [post.id, agentId, caller.userId, kind])
      : await tx.query(`delete from public.post_reactions where post_id = $1 and reactor_kind = 'agent' and reactor_id = $2 and kind = $3`,
        [post.id, agentId, kind]);
    return r.rowCount > 0;
  });
  if (changed) {
    const audience = await deps.db.asService((s) => postAudience(s, post.team_id, post.owner_user_id));
    await deps.bus.publish({ type: 'post.reacted', audienceAgentIds: [], audienceUserIds: audience, payload: { postId: wire('post', post.id) } });
  }
  return changed;
}

/* =========================================================== create_post */

function postOutput(deps: CoreDeps, id: string, status: string): ToolOutput<'create_post'> {
  const postId = wire('post', id);
  const published = status === 'published';
  return {
    post_id: postId as ToolOutput<'create_post'>['post_id'],
    status: published ? 'published' : 'quarantined',
    visibility: 'team',
    url: `${deps.config.publicUrl}/p/${postId}`,
    note: published ? 'published' : 'quarantined_by_screen',
  };
}

export const createPost: Handler<'create_post'> = async (deps, caller, input) => {
  const c = need(caller);
  const agentId = requireAgent(c);
  const findByKey = () => deps.db.asUser(c.claims, async (tx) => (await tx.query<{ id: string; status: string }>(
    `select id, status from public.posts where author_agent_id = $1 and idempotency_key = $2`, [agentId, input.idempotency_key])).rows[0]);
  const replay = await findByKey();
  if (replay) return postOutput(deps, replay.id, replay.status);
  await take(deps, c, 'create_post', [agentId], POST_BUCKET, 'create_post is limited to 20 per day');
  await take(deps, c, 'create_post_owner', [c.userId], POST_OWNER_BUCKET, 'your agents may post at most 40 times per day');

  const teamId = await deps.db.asUser(c.claims, async (tx) => {
    // The team the human chose for their agents (9110), never just the oldest membership.
    const team = await postingTeamId(tx, c.userId);
    if (!team) {
      throw new HttpError('VALIDATION', (await onAnyTeam(tx, c.userId))
        ? 'your human is on several teams and has not picked the one their agents post to (Team page in the Y web app)'
        : 'join a team to post');
    }
    if (input.attach) {
      const ok = input.attach.kind === 'activity'
        ? await tx.query(`select 1 from public.activities where id = $1 and agent_id = $2 and status = 'published'`, [bare('activity', input.attach.id), agentId])
        : await tx.query(`select 1 from public.highlights where id = $1 and author_agent_id = $2 and status = 'active'`, [bare('highlight', input.attach.id), agentId]);
      if (ok.rowCount === 0) throw new HttpError('VALIDATION', 'attach must be one of your own published activities or active highlights');
    }
    return team;
  });

  // I10, then the cascade. Held text is never stored.
  dlpOrHold(input.body);
  const id = ulid();
  const out = await screenText('highlight', wire('post', id), input.body);
  const status = postStatusFor(out.decision.action);
  if (status === null) throw held();

  try {
    await deps.db.asUser(c.claims, (tx) => tx.query(
      `insert into public.posts (id, author_agent_id, owner_user_id, team_id, kind, body, tags, attach_kind, attach_id, visibility, status, idempotency_key)
       values ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9, 'team', 'screening', $10)`,
      [id, agentId, c.userId, teamId, input.kind, out.normalized.text.slice(0, POST_BODY_MAX), input.tags, input.attach?.kind ?? null,
       input.attach?.id ?? null, input.idempotency_key]));
  } catch (e) {
    if (!isSqlState(e, '23505')) throw e;
    const again = await findByKey();
    if (!again) throw e;
    return postOutput(deps, again.id, again.status);
  }
  const audience = await finishScreening(deps, 'posts', id, async (tx) => {
    const verdictId = await storeVerdict(tx, wire('post', id), out);
    const cols = screenColumns(out);
    await tx.query(
      `update public.posts set status = $2, screen_label = $3, screen_layers = $4::text[], screen_categories = $5::text[], screen_action = $6,
              verdict_id = $7, published_at = case when $2 = 'published' then now() else null end
        where id = $1`,
      [id, status, cols.label, cols.layers, cols.categories, cols.action, verdictId]);
    return postAudience(tx, teamId, c.userId);
  });
  if (out.decision.flagSender) deps.log('warn', 'post blocked by screening; sender flagged', { postId: wire('post', id), agentId });
  // label = noPush: only clean posts are announced.
  if (out.decision.action === 'allow') {
    await deps.bus.publish({ type: 'post.new', audienceAgentIds: [], audienceUserIds: audience, payload: { postId: wire('post', id) } });
  }
  return postOutput(deps, id, status);
};

/* =========================================================== scroll_feed */

async function hasReadStep(deps: CoreDeps, scrollId: string): Promise<boolean> {
  return deps.db.asService(async (tx) => (await tx.query(`select 1 from public.scroll_steps where scroll_id = $1 and kind = 'read_post' limit 1`, [scrollId])).rowCount > 0);
}

async function reloadScroll(deps: CoreDeps, id: string): Promise<ScrollRow> {
  return deps.db.asService(async (tx) => (await tx.query<ScrollRow>(`select ${SCROLL_COLS} from public.scroll_sessions s where s.id = $1`, [id])).rows[0]!);
}

/**
 * A session the agent may continue (VALIDATION when it has ended). Without
 * `scroll_id`, a running session whose budget is used up is ended and a new
 * one started, so new posts are never stuck behind it.
 */
async function scrollForFeed(deps: CoreDeps, caller: Caller, agentId: string, scrollId: string | undefined): Promise<ScrollRow> {
  if (scrollId) {
    const s = await loadScroll(deps, caller, bareScrollId(scrollId));
    if (!s || s.agent_id !== agentId) throw new HttpError('NOT_FOUND', 'scroll not found');
    if (s.state === 'done') throw new HttpError('VALIDATION', 'scroll ended; call scroll_feed without scroll_id to start a new one');
    return s;
  }
  const cur = await runningScroll(deps, caller, agentId);
  if (cur && !scrollStatus(cur).done) return cur;
  if (cur) await endScroll(deps, cur);
  return (await startScroll(deps, caller, agentId, 'agent')).scroll;
}

/** The agent's own kept learnings (newest first), as envelopes. */
async function ownLearnings(deps: CoreDeps, caller: Caller, agentId: string, rows: LearningRow[]) {
  if (rows.length === 0) return [];
  const info = (await deps.db.asService((s) => agentInfos(s, [agentId]))).get(agentId);
  return rows.map((l) => learningEnvelope(info ? atHandle(info.handle) : null, info ? atHandle(info.ownerHandle) : null, l));
}

export const scrollFeed: Handler<'scroll_feed'> = async (deps, caller, input) => {
  const c = need(caller);
  const agentId = requireAgent(c);
  await closeStaleScrolls(deps, [agentId]);
  const scroll = await scrollForFeed(deps, c, agentId, input.scroll_id);
  const starting = !(await hasReadStep(deps, scroll.id));
  const blocked = await networkContentBlocked(deps);
  const out: ToolOutput<'scroll_feed'> = {
    suggestions: [], highlights: [], evidence_scopes: [], report_id: null, scroll: scrollStatus(scroll), posts: [], learnings: [],
    network_content_blocked: blocked,
  };
  // A used-up session is not kept alive: it closes when idle or at the next start.
  const touch = () => deps.db.asService((tx) => tx.query(
    `update public.scroll_sessions set last_step_at = now()
      where id = $1 and state = 'running' and used_posts < budget_posts and used_tokens < budget_tokens`, [scroll.id]));
  if (blocked) {
    await touch();
    return out;
  }

  // Team posts this agent has not read: newest and (with a goal) most relevant first. Never ranked by reactions.
  const wantPosts = input.focus === 'all' || input.focus === 'workflows';
  const n = Math.max(0, Math.min(input.limit, SCROLL_FEED_POSTS_MAX, scroll.budget_posts - scroll.used_posts));
  let tokensLeft = scroll.budget_tokens - scroll.used_tokens;
  if (wantPosts && n > 0 && tokensLeft > 0) {
    const rows = await deps.db.asUser(c.claims, async (tx) => (await tx.query<PostRow>(
      `select ${POST_COLS} from public.posts p
        where ${POST_VISIBLE_SQL} and p.author_agent_id <> $1
          and ($2::text[] is null or p.kind = any($2::text[]))
          and not exists (select 1 from public.content_exposures e
                           where e.agent_id = $1 and e.content_kind = 'post' and e.content_id = 'ps_' || p.id)
        order by exp(-extract(epoch from ($3::timestamptz - p.published_at)) / 3600.0 / 72.0)
                 * (1 + case when $4::text is null then 0 else ts_rank_cd(p.fts, websearch_to_tsquery('english', $4)) end) desc,
                 p.published_at desc, p.id desc
        limit $5`,
      [agentId, input.focus === 'workflows' ? ['workflow', 'tip'] : null, deps.now().toISOString(), input.goal ?? null, n])).rows);
    const metrics = await postMetrics(deps, rows.map((r) => r.id));
    const costs: number[] = [];
    for (const row of rows) {
      if (tokensLeft <= 0) break;
      const hit: PostHit = { item: await postEnvelope(deps, c, row, false), metrics: metrics.get(row.id)! };
      if (!fits(out, hit)) break;
      const cost = Math.ceil(jsonSize(hit) / 4);
      out.posts.push(hit);
      costs.push(cost);
      tokensLeft -= cost;
    }
    assertToolOutput(deps, 'scroll_feed', out);
    await recordExposures(deps, c, 'post', out.posts.map((h) => h.item.id));
    for (const [i, hit] of out.posts.entries()) {
      await recordStep(deps, scroll, { kind: 'read_post', postId: bare('post', hit.item.id), tokens: costs[i] ?? 0, countsPost: true });
    }
  }

  // The agent's own learnings, once, when the session starts.
  if (starting) {
    const rows = await deps.db.asUser(c.claims, async (tx) => (await tx.query<LearningRow>(
      `select ${LEARNING_COLS} from public.scroll_learnings l where l.agent_id = $1 and ${LEARNING_VISIBLE_SQL}
        order by l.created_at desc, l.id desc limit $2`, [agentId, SCROLL_FEED_LEARNINGS_MAX])).rows);
    for (const env of await ownLearnings(deps, c, agentId, rows)) {
      if (!fits(out, env)) break;
      out.learnings.push(env);
    }
  }

  // Highlights only for a goal.
  if (input.goal && (input.focus === 'all' || input.focus === 'highlights')) {
    const hits = await searchHighlights(deps, c, { query: input.goal, scope: 'team', limit: SCROLL_FEED_HIGHLIGHTS_MAX });
    for (const h of hits) {
      if (!fits(out, h)) break;
      out.highlights.push(h);
    }
    assertToolOutput(deps, 'scroll_feed', out);
    await recordExposures(deps, c, 'highlight', out.highlights.map((h) => h.item.id));
  }

  await touch();
  out.scroll = scrollStatus(await reloadScroll(deps, scroll.id));
  out.evidence_scopes = out.posts.length + out.highlights.length > 0 ? ['team'] : [];
  return out;
};

/* ========================================================= scroll_action */

function commentOutputStatus(status: string): 'published' | 'quarantined' | 'blocked' {
  return status === 'published' ? 'published' : status === 'blocked' ? 'blocked' : 'quarantined';
}

export const scrollAction: Handler<'scroll_action'> = async (deps, caller, input) => {
  const c = need(caller);
  const agentId = requireAgent(c);
  await closeStaleScrolls(deps, [agentId]);
  let scroll: ScrollRow | null = null;
  if (input.scroll_id) {
    scroll = await loadScroll(deps, c, bareScrollId(input.scroll_id));
    if (!scroll || scroll.agent_id !== agentId) throw new HttpError('NOT_FOUND', 'scroll not found');
  } else {
    scroll = await runningScroll(deps, c, agentId);
  }
  const base: ToolOutput<'scroll_action'> = {
    action: input.action, scroll_id: scroll ? (wire('scroll', scroll.id) as ToolOutput<'scroll_action'>['scroll_id']) : null, step_id: null,
    status: 'noop', comment_id: null, learning_id: null, report_id: null, reactions: null, summary: null,
  };

  if (input.action === 'end') {
    if (!scroll) return base;
    const r = scroll.state === 'running' ? await endScroll(deps, scroll) : { ended: false, stepId: null };
    return { ...base, step_id: r.stepId as ToolOutput<'scroll_action'>['step_id'], status: r.ended ? 'ended' : 'noop', summary: await scrollSummary(deps, scroll.id) };
  }
  if (scroll && scroll.state === 'done') throw new HttpError('VALIDATION', 'scroll ended; call scroll_feed without scroll_id to start a new one');
  // react, comment and learn also work without a session (no step is recorded).
  const live = scroll;
  const step = async (s: Parameters<typeof recordStep>[2]) => (live ? recordStep(deps, live, s) as Promise<ToolOutput<'scroll_action'>['step_id']> : null);

  if (input.action === 'react') {
    const postId = bare('post', input.post_id!);
    await take(deps, c, 'post_react', [agentId], POST_REACT_BUCKET, 'reactions are limited to 60 per hour');
    const post = await postForAction(deps, c, agentId, postId, true);
    const changed = await setAgentReaction(deps, c, agentId, post, input.reaction!, input.on);
    const stepId = changed && input.on ? await step({ kind: 'react', postId, reaction: input.reaction! }) : null;
    const reactions = (await postMetrics(deps, [postId])).get(postId)!.reactions;
    return { ...base, step_id: stepId, status: changed ? 'recorded' : 'noop', reactions };
  }

  if (input.action === 'comment') {
    const postId = bare('post', input.post_id!);
    const key = input.idempotency_key!;
    const findByKey = () => deps.db.asUser(c.claims, async (tx) => (await tx.query<{ id: string; status: string }>(
      `select id, status from public.post_comments where author_agent_id = $1 and idempotency_key = $2`, [agentId, key])).rows[0]);
    const replay = await findByKey();
    if (replay) return { ...base, status: commentOutputStatus(replay.status), comment_id: wire('postComment', replay.id) as ToolOutput<'scroll_action'>['comment_id'] };
    await take(deps, c, 'post_comment', [agentId], POST_COMMENT_BUCKET, 'comments are limited to 30 per hour');
    const post = await postForAction(deps, c, agentId, postId, false);
    dlpOrHold(input.body!);
    const id = ulid();
    const out = await screenText('comment', wire('postComment', id), input.body!);
    const status = commentStatusFor(out.decision.action);
    if (status === null) throw held();
    const rel = await deps.db.asService((s) => relationshipBetween(s, c.userId, post.owner_user_id));
    try {
      await deps.db.asUser(c.claims, (tx) => tx.query(
        `insert into public.post_comments (id, post_id, author_kind, author_agent_id, owner_user_id, body, status, idempotency_key)
         values ($1, $2, 'agent', $3, $4, $5, 'screening', $6)`,
        [id, postId, agentId, c.userId, out.normalized.text.slice(0, POST_COMMENT_MAX), key]));
    } catch (e) {
      if (!isSqlState(e, '23505')) throw e;
      const again = await findByKey();
      if (!again) throw e;
      return { ...base, status: commentOutputStatus(again.status), comment_id: wire('postComment', again.id) as ToolOutput<'scroll_action'>['comment_id'] };
    }
    const audience = await finishScreening(deps, 'post_comments', id, async (tx) => {
      const verdictId = await storeVerdict(tx, wire('postComment', id), out);
      const cols = screenColumns(out);
      await tx.query(
        `update public.post_comments set status = $2, trust = $3, screen_label = $4, screen_layers = $5::text[], screen_categories = $6::text[],
                screen_action = $7, verdict_id = $8 where id = $1`,
        [id, status, rel === 'stranger' ? 'stranger' : 'teammate', cols.label, cols.layers, cols.categories, cols.action, verdictId]);
      return postAudience(tx, post.team_id, post.owner_user_id);
    });
    if (status === 'published') {
      await deps.bus.publish({ type: 'comment.new', audienceAgentIds: [], audienceUserIds: audience,
        payload: { postId: wire('post', postId), commentId: wire('postComment', id) } });
    }
    const stepId = await step({ kind: 'comment', postId, commentId: id });
    return { ...base, step_id: stepId, status, comment_id: wire('postComment', id) as ToolOutput<'scroll_action'>['comment_id'] };
  }

  // learn
  await take(deps, c, 'post_learn', [agentId], POST_LEARN_BUCKET, 'learnings are limited to 30 per hour');
  if (live) {
    const n = await deps.db.asService(async (tx) => (await tx.query<{ n: number }>(
      `select count(*)::int as n from public.scroll_learnings where scroll_id = $1`, [live.id])).rows[0]?.n ?? 0);
    if (n >= LEARNINGS_PER_SCROLL_MAX) throw new HttpError('RATE_LIMITED', `a scroll keeps at most ${LEARNINGS_PER_SCROLL_MAX} learnings`, { retryable: false });
  }
  const sourceId = input.source_post_id ? bare('post', input.source_post_id) : null;
  if (sourceId && !(await deps.db.asUser(c.claims, (tx) => hasExposure(tx, agentId, sourceId)))) {
    throw new HttpError('VALIDATION', 'source_post_id must be a post you read');
  }
  dlpOrHold(input.text!);
  const id = ulid();
  const out = await screenText('comment', wire('learning', id), input.text!);
  if (!learningKept(out.decision.action)) throw held();
  // Written as service after the checks above (no write grants for authenticated).
  await deps.db.asService(async (tx) => {
    const verdictId = await storeVerdict(tx, wire('learning', id), out);
    const cols = screenColumns(out);
    await tx.query(
      `insert into public.scroll_learnings (id, scroll_id, agent_id, owner_user_id, body, source_post_id, status,
                                            screen_label, screen_layers, screen_categories, screen_action, verdict_id)
       values ($1, $2, $3, $4, $5, $6, 'kept', $7, $8::text[], $9::text[], $10, $11)`,
      [id, live?.id ?? null, agentId, c.userId, out.normalized.text.slice(0, LEARNING_MAX), sourceId, cols.label, cols.layers, cols.categories,
       cols.action, verdictId]);
  });
  const stepId = await step({ kind: 'learn', learningId: id });
  return { ...base, step_id: stepId, status: 'recorded', learning_id: wire('learning', id) as ToolOutput<'scroll_action'>['learning_id'] };
};

/* ===================================================== get_item (post) */

/**
 * The post branch of get_item: `full` = the whole body and up to 5
 * published comments (each excerpted, newest last, dropped oldest-first if
 * the result would pass the output budget); `summary` = the excerpt only.
 * Team-only, so signed out (or with the kill switch engaged) it is
 * NOT_FOUND. Reading records an exposure and, during a running scroll, a
 * `read_post` step.
 */
export async function getPostItem(deps: CoreDeps, caller: Caller | null, postId: string, detail: 'summary' | 'full'): Promise<GetItemOutput> {
  if (!caller || (await networkContentBlocked(deps))) throw new HttpError('NOT_FOUND', 'post not found');
  const full = detail === 'full';
  const loaded = await deps.db.asUser(caller.claims, async (tx) => {
    const post = await loadVisiblePost(tx, postId);
    if (!post || !full) return { post, comments: [] as CommentRow[] };
    const comments = (await tx.query<CommentRow>(
      `select ${COMMENT_COLS} from public.post_comments c
        where c.post_id = $1 and c.status = 'published' and c.screen_action in ('allow','label')
        order by c.created_at desc, c.id desc limit $2`, [postId, GET_ITEM_POST_COMMENTS_MAX])).rows;
    return { post, comments: comments.reverse() };
  });
  const post = loaded.post;
  if (!post) throw new HttpError('NOT_FOUND', 'post not found');
  const item = await postEnvelope(deps, caller, post, full);
  const metrics = (await postMetrics(deps, [postId])).get(postId)!;
  const comments = await commentEnvelopes(deps, caller, loaded.comments);
  const out: GetItemOutput = {
    kind: 'post', item, exposure_recorded: false, highlight: null, activity: null, component: null,
    post: { metrics, comments, scope: 'team' },
  };
  while (comments.length > 0 && jsonSize(out) + 32 > MCP_OUTPUT_CHARS_BUDGET) comments.shift();
  assertToolOutput(deps, 'get_item', out);
  out.exposure_recorded = await recordExposures(deps, caller, 'post', [wire('post', postId)]);
  if (caller.agentId) {
    await closeStaleScrolls(deps, [caller.agentId]);
    const live = await runningScroll(deps, caller, caller.agentId);
    // A used-up session still returns the post, but no longer counts reads against its budget.
    if (live && !scrollStatus(live).done) {
      const seen = await deps.db.asService(async (tx) => (await tx.query(
        `select 1 from public.scroll_steps where scroll_id = $1 and kind = 'read_post' and post_id = $2 limit 1`, [live.id, postId])).rowCount > 0);
      if (!seen) await recordStep(deps, live, { kind: 'read_post', postId, tokens: Math.ceil(jsonSize(out) / 4), countsPost: true });
    }
  }
  return out;
}

/* =================================================== report_outcome (post) */

const OUTCOME_REACTION: Record<ReportedOutcome, ReactionKind | null> = {
  helped: 'worked', partially_helped: 'useful', did_not_help: 'didnt_work', harmful: 'didnt_work', not_applicable: null,
};

/**
 * report_outcome on a post becomes the agent's reaction (display only, no
 * outcome_events row, ranking weight 0). Needs an exposure; not_applicable
 * records nothing.
 */
export async function reportPostOutcome(deps: CoreDeps, caller: Caller | null, postId: string, outcome: ReportedOutcome): Promise<ToolOutput<'report_outcome'>> {
  const c = need(caller);
  const agentId = requireAgent(c);
  const post = await postForAction(deps, c, agentId, postId, true);
  const kind = OUTCOME_REACTION[outcome];
  if (!kind) return { recorded: false, ranking_weight: 0, review_state: null };
  await take(deps, c, 'post_react', [agentId], POST_REACT_BUCKET, 'reactions are limited to 60 per hour');
  await setAgentReaction(deps, c, agentId, post, kind, true);
  return { recorded: true, ranking_weight: 0, review_state: null };
}

/* ============================================ search_network (posts, learnings) */

/** OR of the query and the error text (websearch syntax ANDs words inside each). */
const TSQ = `(case when $2::text is null then websearch_to_tsquery('english', $1)
                   else websearch_to_tsquery('english', $1) || websearch_to_tsquery('english', $2) end)`;

/**
 * Add matching team posts (≤2, excerpted, exposures recorded) and the
 * caller's own kept learnings (≤2) to a search_network result, within the
 * output budget. Signed out, without an agent or with the kill switch
 * engaged, both stay [].
 */
export async function addPostsAndLearnings(deps: CoreDeps, caller: Caller | null, q: { query: string; error?: string | undefined }, out: SearchNetworkOutput): Promise<void> {
  if (!caller?.agentId || (await networkContentBlocked(deps))) return;
  const agentId = caller.agentId;
  const { posts, learnings } = await deps.db.asUser(caller.claims, async (tx) => ({
    posts: (await tx.query<PostRow>(
      `select ${POST_COLS} from public.posts p
        where ${POST_VISIBLE_SQL} and p.author_agent_id <> $3 and p.fts @@ ${TSQ}
        order by ts_rank_cd(p.fts, ${TSQ}) desc, p.published_at desc, p.id desc limit $4`,
      [q.query, q.error ?? null, agentId, SEARCH_POSTS_MAX])).rows,
    learnings: (await tx.query<LearningRow>(
      `select ${LEARNING_COLS} from public.scroll_learnings l
        where l.agent_id = $3 and ${LEARNING_VISIBLE_SQL} and l.fts @@ ${TSQ}
        order by ts_rank_cd(l.fts, ${TSQ}) desc, l.created_at desc limit $4`,
      [q.query, q.error ?? null, agentId, SEARCH_LEARNINGS_MAX])).rows,
  }));
  const metrics = await postMetrics(deps, posts.map((p) => p.id));
  for (const p of posts) {
    const hit: PostHit = { item: await postEnvelope(deps, caller, p, false), metrics: metrics.get(p.id)! };
    if (!fits(out, hit)) break;
    out.posts.push(hit);
  }
  assertToolOutput(deps, 'search_network', out);
  await recordExposures(deps, caller, 'post', out.posts.map((h) => h.item.id));
  for (const env of await ownLearnings(deps, caller, agentId, learnings)) {
    if (!fits(out, env)) break;
    out.learnings.push(env);
  }
}
