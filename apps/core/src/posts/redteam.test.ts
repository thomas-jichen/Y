/**
 * Red-team regressions for go-scroll: the scroll budget holds under
 * concurrent scroll_feed calls and get_item (#88), and the owner's web
 * scroll view hides learnings whose source post was taken down (#90).
 * PGlite with the real safety cascade (no network).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveScrollResponse, SCROLL_BUDGET } from '@y/schema';
import { appendStep } from './scroll.js';
import { makePostsEnv, post, tipBody, tool, web, type PostsEnv } from './test-support.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let env: PostsEnv;
beforeEach(async () => { env = await makePostsEnv(); });
afterEach(async () => { await env.db.close(); });

const ok = (r: { body: any }) => {
  if (!r.body.ok) throw new Error(`tool failed: ${JSON.stringify(r.body)}`);
  return r.body.output;
};
const bareOf = (id: string) => id.replace(/^[a-z]+_/, '');

async function session(scrollId: string) {
  return (await env.db.query<{ used_posts: number; budget_posts: number; state: string }>(
    `select used_posts, budget_posts, state from public.scroll_sessions where id = $1`, [bareOf(scrollId)])).rows[0]!;
}

describe('#88: scroll budget accounting', () => {
  it('concurrent scroll_feed calls count each post once', async () => {
    for (const t of ['vitest', 'jest', 'mocha']) ok(await post(env, env.B, tipBody(t)));
    const first = ok(await tool(env, 'scroll_feed', env.A, { limit: 1 })); // start the session (reads one)
    const sid = first.scroll.id as string;
    await Promise.all([1, 2, 3].map(() => tool(env, 'scroll_feed', env.A, { scroll_id: sid, limit: 3 })));
    const dup = await env.db.query<{ post_id: string; n: number }>(
      `select post_id, count(*)::int as n from public.scroll_steps where scroll_id = $1 and kind = 'read_post' group by post_id`, [bareOf(sid)]);
    expect(dup.rows).toHaveLength(3);
    expect(dup.rows.every((r) => r.n === 1)).toBe(true);
    expect((await session(sid)).used_posts).toBe(3);
  });

  it('get_item after the budget is used up still returns the post but stops counting', async () => {
    const a = ok(await post(env, env.B, tipBody('vitest')));
    const b = ok(await post(env, env.B, tipBody('jest')));
    const feed = ok(await tool(env, 'scroll_feed', env.A, { limit: 1 }));
    const sid = feed.scroll.id as string;
    await env.db.query(`update public.scroll_sessions set used_posts = budget_posts where id = $1`, [bareOf(sid)]);
    const unread = [a.post_id, b.post_id].find((id) => id !== feed.posts[0].item.id)!;
    const g = ok(await tool(env, 'get_item', env.A, { id: unread }));
    expect(g.kind).toBe('post');
    const s = await session(sid);
    expect(s.used_posts).toBe(SCROLL_BUDGET.posts);
    const steps = await env.db.query(`select 1 from public.scroll_steps where scroll_id = $1 and kind = 'read_post' and post_id = $2`, [bareOf(sid), bareOf(unread)]);
    expect(steps.rowCount).toBe(0);
  });

  it('appendStep never pushes used_posts past budget_posts', async () => {
    const p = ok(await post(env, env.B, tipBody('vitest')));
    const feed = ok(await tool(env, 'scroll_feed', env.A, { focus: 'highlights' }));
    const sid = bareOf(feed.scroll.id);
    await env.db.query(`update public.scroll_sessions set used_posts = budget_posts where id = $1`, [sid]);
    await env.db.asService((tx) => appendStep(tx, sid, { kind: 'read_post', postId: bareOf(p.post_id), tokens: 10, countsPost: true }));
    expect((await session(feed.scroll.id)).used_posts).toBe(SCROLL_BUDGET.posts);
  });
});

describe('#90: web scroll view after a takedown', () => {
  it('hides a learning (and its step text) whose source post was removed; unsourced ones stay', async () => {
    const p = ok(await post(env, env.B, tipBody('vitest')));
    ok(await tool(env, 'scroll_feed', env.A, {}));
    const sourced = ok(await tool(env, 'scroll_action', env.A, { action: 'learn', text: 'Hook timeouts are separate from test timeouts.', source_post_id: p.post_id }));
    const plain = ok(await tool(env, 'scroll_action', env.A, { action: 'learn', text: 'Read the runner config before raising limits.' }));
    const before = ActiveScrollResponse.parse((await web(env, 'GET', '/api/v1/scrolls/active', env.Aw)).json)!;
    expect(before.learnings.map((l) => l.id)).toEqual([sourced.learning_id, plain.learning_id]);

    expect((await web(env, 'POST', `/api/v1/posts/${p.post_id}/remove`, env.Bw, {})).json).toEqual({ ok: true });
    const after = ActiveScrollResponse.parse((await web(env, 'GET', '/api/v1/scrolls/active', env.Aw)).json)!;
    expect(after.learnings.map((l) => l.id)).toEqual([plain.learning_id]);
    expect(JSON.stringify(after)).not.toContain('Hook timeouts are separate');
    // The step itself stays, with its templated label.
    expect(after.steps.filter((s) => s.kind === 'learn').map((s) => s.label)).toEqual(['Saved a learning', 'Saved a learning']);
    expect(after.steps.filter((s) => s.kind === 'learn').map((s) => s.text ?? null)).toEqual([null, 'Read the runner config before raising limits.']);
  });
});
