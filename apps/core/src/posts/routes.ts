/**
 * Web JSON API for posts and scrolls (packages/schema posts.ts). Human
 * callers only; reads and inserts run through db.asUser (RLS, I7); status
 * and screen transitions and the scroll tables are written as service
 * after those checks. Bodies are withheld unless published (I8). Human
 * comments are screened (class `comment`, no DLP: humans, not agents).
 * `/posts/:id/ask` and `/agents/:handle/scroll` issue owner instructions:
 * step-up (STEP_UP_ROUTES) and remote instructions on, like
 * `/threads/:id/instruct`. Events carry ids only (I3).
 */
import type { Context } from 'hono';
import { isSqlState } from '@y/db';
import {
  AskOnPostRequest,
  POSTS_PAGE_SIZE,
  POST_COMMENT_MAX,
  PostCommentRequest,
  PostsQuery,
  ReactRequest,
  ulid,
  type ActiveScrollResponse,
  type AskOnPostResponse,
  type FollowResponse,
  type FollowStatus,
  type PostComment,
  type PostDetail,
  type PostPage,
  type ReactResponse,
  type RemovePostResponse,
  type ScrollPage,
  type ScrollSession,
  type StartScrollResponse,
} from '@y/schema';
import type { App, Caller, CoreDeps } from '../contracts.js';
import { HttpError, errorResponse, postingTeamId, wire } from '../messaging/util.js';
import { authenticate } from '../platform/http.js';
import { WEB_POST_COMMENT_BUCKET, WEB_POST_REACT_BUCKET, takeToken, type BucketSpec } from '../platform/rate-limit.js';
import { bareId, fail, parseOr, readJson } from '../platform/util.js';
import { askInstructionBody, issueOwnerInstruction, requireInstructable, scrollInstructionBody } from './instruct.js';
import { commentStatusFor, finishScreening, held, screenColumns, screenText, storeVerdict } from './screen.js';
import { closeStaleScrolls, endScroll, loadScroll, ownedAgentIds, runningScroll, scrollStatus, startScroll, SCROLL_COLS, type ScrollRow } from './scroll.js';
import { COMMENT_COLS, POST_VISIBLE_SQL, loadWebPosts, loadWebScrolls, postAudience, webComments, webReactionsFor, type CommentRow } from './store.js';

const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** `at` is the row's timestamp as text with microseconds (see AT_US); ms would skip rows within the last row's millisecond. */
function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`).toString('base64url');
}

const AT_US = `to_char(coalesce(p.published_at, p.created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
function decodeCursor(cursor: string): { at: string; id: string } | null {
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!at || !id || Number.isNaN(Date.parse(at)) || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return null;
    return { at, id };
  } catch {
    return null;
  }
}

interface AgentTarget { id: string; owner_user_id: string }

export function registerPostsRoutes(app: App, deps: CoreDeps): void {
  /** Human (web session) routes; thrown HttpErrors become the standard error body. */
  const human = (fn: (c: Context, caller: Caller) => Promise<Response>) => async (c: Context) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    try {
      return await fn(c, caller);
    } catch (err) {
      if (err instanceof HttpError && err.opts.retryAfterS !== undefined) c.header('retry-after', String(err.opts.retryAfterS));
      return errorResponse(c, err, deps);
    }
  };

  const limit = async (caller: Caller, scope: string, spec: BucketSpec, message: string) => {
    const rl = await deps.db.asUser(caller.claims, (tx) => takeToken(tx, scope, [caller.userId], spec));
    if (!rl.allowed) throw new HttpError('RATE_LIMITED', message, { retryAfterS: rl.retryAfterS });
  };

  /** A published post the viewer can see (RLS + explicit status), or NOT_FOUND. */
  const publishedPost = async (caller: Caller, postId: string) => {
    const p = await deps.db.asUser(caller.claims, async (tx) => (await tx.query<{ id: string; team_id: string; owner_user_id: string }>(
      `select p.id, p.team_id, p.owner_user_id from public.posts p where p.id = $1 and ${POST_VISIBLE_SQL}`, [postId])).rows[0]);
    if (!p) throw new HttpError('NOT_FOUND', 'post not found');
    return p;
  };

  const postIdParam = (c: Context): string => {
    const id = bareId('ps', c.req.param('id') ?? '');
    if (!id) throw new HttpError('VALIDATION', 'expected a post id (ps_…)');
    return id;
  };

  /** Handles in URLs come without `@`. NOT_FOUND when unknown or not visible to the viewer. */
  const agentByHandle = async (caller: Caller, raw: string): Promise<AgentTarget> => {
    const handle = raw.replace(/^@/, '').toLowerCase();
    const a = await deps.db.asUser(caller.claims, async (tx) => (await tx.query<AgentTarget>(
      `select id, owner_user_id from public.agents where handle = $1`, [handle])).rows[0]);
    if (!a) throw new HttpError('NOT_FOUND', 'agent not found');
    return a;
  };

  const scrollsOf = async (caller: Caller, rows: ScrollRow[]): Promise<ScrollSession[]> => loadWebScrolls(deps, caller, rows);

  /* ----------------------------------------------------------------- posts */

  // v0: for_you = team (newest first; ranking is a follow-up); following =
  // followed agents plus your own. Owners also see their own unpublished
  // posts (quarantined, body withheld); RLS hides them from everyone else.
  app.get('/api/v1/posts', human(async (c, caller) => {
    const q = parseOr(c, PostsQuery, c.req.query());
    if (!q.ok) return q.res;
    const cur = q.data.cursor ? decodeCursor(q.data.cursor) : null;
    if (q.data.cursor && !cur) return fail(c, 'VALIDATION', 'invalid cursor');
    const rows = await deps.db.asUser(caller.claims, async (tx) => {
      // One team at a time: the viewer's posting team (the team switcher).
      const params: unknown[] = [await postingTeamId(tx, caller.userId)];
      const where: string[] = [`p.status <> 'screening'`, `($1::uuid is null or p.team_id is null or p.team_id = $1::uuid)`];
      if (cur) {
        params.push(cur.at, cur.id);
        where.push(`(coalesce(p.published_at, p.created_at), p.id::text) < ($${params.length - 1}::timestamptz, $${params.length})`);
      }
      if (q.data.tab === 'following') {
        params.push(caller.userId);
        where.push(`(p.owner_user_id = $${params.length}
                     or exists (select 1 from public.follows f where f.follower_user_id = $${params.length} and f.agent_id = p.author_agent_id))`);
      }
      params.push(POSTS_PAGE_SIZE + 1);
      return (await tx.query<{ id: string; at: string }>(
        `select p.id, ${AT_US} as at from public.posts p where ${where.join(' and ')}
          order by coalesce(p.published_at, p.created_at) desc, p.id desc limit $${params.length}`, params)).rows;
    });
    const page = rows.slice(0, POSTS_PAGE_SIZE);
    const last = page[page.length - 1];
    const res: PostPage = {
      items: await loadWebPosts(deps, caller, page.map((r) => r.id)),
      ...(rows.length > POSTS_PAGE_SIZE && last ? { nextCursor: encodeCursor(last.at, last.id) } : {}),
    };
    return c.json(res);
  }));

  app.get('/api/v1/posts/:id', human(async (c, caller) => {
    const id = postIdParam(c);
    const [post] = await loadWebPosts(deps, caller, [id]);
    if (!post) return fail(c, 'NOT_FOUND', 'post not found');
    // Published comments, plus the viewer's own (and their agents') in any state, body withheld unless published.
    const rows = await deps.db.asUser(caller.claims, async (tx) => (await tx.query<CommentRow>(
      `select ${COMMENT_COLS} from public.post_comments c where c.post_id = $1 and c.status <> 'screening'
        order by c.created_at, c.id limit 500`, [id])).rows);
    const res: PostDetail = { post, comments: await webComments(deps, caller, rows) };
    return c.json(res);
  }));

  // Toggle the viewer's own reaction of that kind (kinds are independent).
  app.post('/api/v1/posts/:id/react', human(async (c, caller) => {
    const id = postIdParam(c);
    const body = parseOr(c, ReactRequest, await readJson(c));
    if (!body.ok) return body.res;
    await limit(caller, 'web_post_react', WEB_POST_REACT_BUCKET, 'reactions are limited to 120 per hour');
    const post = await publishedPost(caller, id);
    await deps.db.asUser(caller.claims, async (tx) => {
      const del = await tx.query(`delete from public.post_reactions where post_id = $1 and reactor_kind = 'user' and reactor_id = $2 and kind = $3`,
        [id, caller.userId, body.data.reaction]);
      if (del.rowCount === 0) {
        await tx.query(`insert into public.post_reactions (post_id, reactor_kind, reactor_id, reactor_owner_id, kind) values ($1, 'user', $2, $2, $3)`,
          [id, caller.userId, body.data.reaction]);
      }
    });
    const audience = await deps.db.asService((s) => postAudience(s, post.team_id, post.owner_user_id));
    await deps.bus.publish({ type: 'post.reacted', audienceAgentIds: [], audienceUserIds: audience, payload: { postId: wire('post', id) } });
    const res: ReactResponse = { reactions: await webReactionsFor(deps, caller, id) };
    return c.json(res);
  }));

  app.post('/api/v1/posts/:id/comment', human(async (c, caller) => {
    const id = postIdParam(c);
    const body = parseOr(c, PostCommentRequest, await readJson(c));
    if (!body.ok) return body.res;
    const keyHeader = c.req.header('idempotency-key');
    const key = keyHeader && IDEMPOTENCY_RE.test(keyHeader) ? keyHeader : null;
    const loadComment = async (where: string, params: unknown[]): Promise<PostComment | null> => {
      const rows = await deps.db.asUser(caller.claims, async (tx) => (await tx.query<CommentRow>(
        `select ${COMMENT_COLS} from public.post_comments c where ${where}`, params)).rows);
      return (await webComments(deps, caller, rows))[0] ?? null;
    };
    if (key) {
      const replay = await loadComment(`c.author_user_id = $1 and c.idempotency_key = $2`, [caller.userId, key]);
      if (replay) return c.json(replay);
    }
    await limit(caller, 'web_post_comment', WEB_POST_COMMENT_BUCKET, 'comments are limited to 30 per hour');
    const post = await publishedPost(caller, id);
    const commentId = ulid();
    const out = await screenText('comment', wire('postComment', commentId), body.data.body);
    const status = commentStatusFor(out.decision.action);
    if (status === null) throw held();
    try {
      await deps.db.asUser(caller.claims, (tx) => tx.query(
        `insert into public.post_comments (id, post_id, author_kind, author_user_id, owner_user_id, body, status, idempotency_key)
         values ($1, $2, 'user', $3, $3, $4, 'screening', $5)`,
        [commentId, id, caller.userId, out.normalized.text.slice(0, POST_COMMENT_MAX), key]));
    } catch (e) {
      if (!key || !isSqlState(e, '23505')) throw e;
      const again = await loadComment(`c.author_user_id = $1 and c.idempotency_key = $2`, [caller.userId, key]);
      if (!again) throw e;
      return c.json(again);
    }
    const audience = await finishScreening(deps, 'post_comments', commentId, async (tx) => {
      const verdictId = await storeVerdict(tx, wire('postComment', commentId), out);
      const cols = screenColumns(out);
      await tx.query(
        `update public.post_comments set status = $2, trust = 'human_comment', screen_label = $3, screen_layers = $4::text[],
                screen_categories = $5::text[], screen_action = $6, verdict_id = $7 where id = $1`,
        [commentId, status, cols.label, cols.layers, cols.categories, cols.action, verdictId]);
      return postAudience(tx, post.team_id, post.owner_user_id);
    });
    if (status === 'published') {
      await deps.bus.publish({ type: 'comment.new', audienceAgentIds: [], audienceUserIds: audience,
        payload: { postId: wire('post', id), commentId: wire('postComment', commentId) } });
    }
    const res = await loadComment(`c.id = $1`, [commentId]);
    if (!res) throw new HttpError('INTERNAL', 'comment not readable after insert');
    return c.json(res);
  }));

  // Ask your own agent to read the post and reply (an owner instruction).
  app.post('/api/v1/posts/:id/ask', human(async (c, caller) => {
    const id = postIdParam(c);
    const body = parseOr(c, AskOnPostRequest, await readJson(c));
    if (!body.ok) return body.res;
    await publishedPost(caller, id);
    let agentId = body.data.agentId ?? null;
    if (!agentId) {
      agentId = await deps.db.asUser(caller.claims, async (tx) => (await tx.query<{ id: string }>(
        `select id from public.agents where owner_user_id = $1 order by created_at, id limit 1`, [caller.userId])).rows[0]?.id ?? null);
      if (!agentId) throw new HttpError('SCOPE_FORBIDDEN', 'connect an agent first');
    }
    const instruction = await issueOwnerInstruction(deps, caller, agentId, askInstructionBody(wire('post', id), body.data.body));
    const res: AskOnPostResponse = { ok: true, instruction };
    return c.json(res);
  }));

  // Takedown: the author's owner or an admin of the post's team.
  app.post('/api/v1/posts/:id/remove', human(async (c, caller) => {
    const id = postIdParam(c);
    const allowed = await deps.db.asUser(caller.claims, async (tx) => {
      const p = (await tx.query<{ owner_user_id: string; team_id: string }>(`select owner_user_id, team_id from public.posts where id = $1`, [id])).rows[0];
      if (!p) throw new HttpError('NOT_FOUND', 'post not found');
      if (p.owner_user_id === caller.userId) return true;
      return (await tx.query(`select 1 from public.team_members where team_id = $1 and user_id = $2 and role in ('owner','admin')`,
        [p.team_id, caller.userId])).rowCount > 0;
    });
    if (!allowed) throw new HttpError('SCOPE_FORBIDDEN', 'only the author\'s owner or a team admin can remove a post');
    await deps.db.asService((tx) => tx.query(`update public.posts set status = 'removed' where id = $1`, [id]));
    const res: RemovePostResponse = { ok: true };
    return c.json(res);
  }));

  /* ---------------------------------------------------------------- agents */

  app.get('/api/v1/agents/:handle/posts', human(async (c, caller) => {
    const agent = await agentByHandle(caller, c.req.param('handle') ?? '');
    const rows = await deps.db.asUser(caller.claims, async (tx) => (await tx.query<{ id: string }>(
      `select p.id from public.posts p where p.author_agent_id = $1 and p.status <> 'screening'
        order by coalesce(p.published_at, p.created_at) desc, p.id desc limit 50`, [agent.id])).rows);
    const res: PostPage = { items: await loadWebPosts(deps, caller, rows.map((r) => r.id)) };
    return c.json(res);
  }));

  app.get('/api/v1/agents/:handle/scrolls', human(async (c, caller) => {
    const agent = await agentByHandle(caller, c.req.param('handle') ?? '');
    if (agent.owner_user_id !== caller.userId) return c.json({ items: [] } satisfies ScrollPage);
    await closeStaleScrolls(deps, [agent.id]);
    const rows = await deps.db.asUser(caller.claims, async (tx) => (await tx.query<ScrollRow>(
      `select ${SCROLL_COLS} from public.scroll_sessions s where s.agent_id = $1 order by s.started_at desc, s.id desc limit 50`, [agent.id])).rows);
    const res: ScrollPage = { items: await scrollsOf(caller, rows) };
    return c.json(res);
  }));

  // Send your agent to scroll: gate first (nothing is created when remote
  // instructions are off), then reuse the running session or start one and
  // instruct the agent. A running session gets no second instruction; one
  // whose budget is used up is ended and replaced.
  app.post('/api/v1/agents/:handle/scroll', human(async (c, caller) => {
    const agent = await agentByHandle(caller, c.req.param('handle') ?? '');
    if (agent.owner_user_id !== caller.userId) throw new HttpError('SCOPE_FORBIDDEN', 'you can only send your own agent to scroll');
    await requireInstructable(deps, caller, agent.id);
    await closeStaleScrolls(deps, [agent.id]);
    const running = await runningScroll(deps, caller, agent.id);
    if (running && !scrollStatus(running).done) return c.json({ scrollId: wire('scroll', running.id), instruction: null } as StartScrollResponse);
    if (running) await endScroll(deps, running);
    const started = await startScroll(deps, caller, agent.id, 'web');
    const scrollId = wire('scroll', started.scroll.id);
    const instruction = started.created ? await issueOwnerInstruction(deps, caller, agent.id, scrollInstructionBody(scrollId)) : null;
    return c.json({ scrollId, instruction } as StartScrollResponse);
  }));

  app.get('/api/v1/agents/:handle/follow', human(async (c, caller) => {
    const agent = await agentByHandle(caller, c.req.param('handle') ?? '');
    const following = await deps.db.asUser(caller.claims, async (tx) => (await tx.query(
      `select 1 from public.follows where follower_user_id = $1 and agent_id = $2`, [caller.userId, agent.id])).rowCount > 0);
    // A count only (follows rows are private to the follower and the agent's owner).
    const followers = await deps.db.asService(async (tx) => (await tx.query<{ n: number }>(
      `select count(*)::int as n from public.follows where agent_id = $1`, [agent.id])).rows[0]?.n ?? 0);
    const res: FollowStatus = { following, followers };
    return c.json(res);
  }));

  app.post('/api/v1/agents/:handle/follow', human(async (c, caller) => {
    const agent = await agentByHandle(caller, c.req.param('handle') ?? '');
    const following = await deps.db.asUser(caller.claims, async (tx) => {
      const del = await tx.query(`delete from public.follows where follower_user_id = $1 and agent_id = $2`, [caller.userId, agent.id]);
      if (del.rowCount > 0) return false;
      await tx.query(`insert into public.follows (follower_user_id, agent_id) values ($1, $2) on conflict do nothing`, [caller.userId, agent.id]);
      return true;
    });
    const res: FollowResponse = { following };
    return c.json(res);
  }));

  /* --------------------------------------------------------------- scrolls */

  // Registered before /scrolls/:id (Hono matches in registration order).
  app.get('/api/v1/scrolls/active', human(async (c, caller) => {
    await closeStaleScrolls(deps, await ownedAgentIds(deps, caller));
    const rows = await deps.db.asUser(caller.claims, async (tx) => (await tx.query<ScrollRow>(
      `select ${SCROLL_COLS} from public.scroll_sessions s where s.owner_user_id = $1 and s.state = 'running'
        order by s.started_at desc, s.id desc limit 1`, [caller.userId])).rows);
    const res: ActiveScrollResponse = (await scrollsOf(caller, rows))[0] ?? null;
    return c.json(res);
  }));

  app.get('/api/v1/scrolls/:id', human(async (c, caller) => {
    const id = bareId('sc', c.req.param('id') ?? '');
    if (!id) return fail(c, 'VALIDATION', 'expected a scroll id (sc_…)');
    await closeStaleScrolls(deps, await ownedAgentIds(deps, caller));
    const s = await loadScroll(deps, caller, id);
    if (!s || s.owner_user_id !== caller.userId) return fail(c, 'NOT_FOUND', 'scroll not found');
    const [session] = await scrollsOf(caller, [s]);
    if (!session) return fail(c, 'NOT_FOUND', 'scroll not found');
    return c.json(session);
  }));
}
