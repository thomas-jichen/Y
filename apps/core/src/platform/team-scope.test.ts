/**
 * The web app shows one team at a time (the viewer's posting team): feed, posts, threads and review
 * items from the viewer's other teams are left out, and switching the posting team switches them.
 * PGlite, synthetic users, no network.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FeedPage, PostPage, ReviewList } from '@y/schema';

vi.mock('@y/safety', () => import('../messaging/test-fakes.js').then((m) => m.safety));
vi.mock('@y/domain', () => import('../messaging/test-fakes.js').then((m) => m.domain));
vi.mock('@y/retrieval', () => import('../messaging/test-fakes.js').then((m) => m.retrieval));

import { messagingModule } from '../messaging/index.js';
import { makeEnv, seedPerson, seedTeam, webCaller, type Person, type TestEnv } from '../messaging/test-support.js';
import { migrateCore, platformModule } from './index.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let env: TestEnv;
let viv: Person;
let dana: Person; // dev teammate only
let cal: Person; // calhacks teammate only
let dev: string;
let hack: string;

beforeAll(async () => {
  env = await makeEnv([platformModule, messagingModule]);
  await migrateCore(env.db);
  viv = await seedPerson(env.db, 'scope-viv');
  dana = await seedPerson(env.db, 'scope-dana');
  cal = await seedPerson(env.db, 'scope-cal');
  dev = await seedTeam(env.db, 'scope-dev', [viv, dana]);
  hack = await seedTeam(env.db, 'scope-hack', [viv, cal]);

  // One published activity, one post and one pending draft per team; a DM with each teammate.
  for (const [team, owner, n] of [[dev, dana, 'dev'], [hack, cal, 'hack']] as const) {
    await env.db.query(
      `insert into public.activities (agent_id, owner_user_id, team_id, visibility, status, title, published_at, screen_label, screen_action)
       values ($1, $2, $3, 'team', 'published', $4, now(), 'clean', 'allow')`, [owner.agentId, owner.userId, team, `${n} activity`]);
    await env.db.query(
      `insert into public.posts (author_agent_id, owner_user_id, team_id, kind, body, visibility, status, published_at, screen_label, screen_action)
       values ($1, $2, $3, 'tip', $4, 'team', 'published', now(), 'clean', 'allow')`, [owner.agentId, owner.userId, team, `${n} post body that is long enough`]);
    const a = await env.db.query<{ id: string }>(
      `insert into public.activities (agent_id, owner_user_id, team_id, visibility, status, title)
       values ($1, $2, $3, 'private', 'draft', $4) returning id`, [viv.agentId, viv.userId, team, `${n} draft`]);
    await env.db.query(`insert into public.review_items (owner_user_id, kind, ref_id, agent_id, summary) values ($1, 'draft', $2, $3, $4)`,
      [viv.userId, `a_${a.rows[0]!.id}`, viv.agentId, `${n} draft`]);
    const t = await env.db.query<{ id: string }>(
      `insert into public.threads (kind, team_id, requested_subject, state, created_by_user_id) values ('dm', $1, $2, 'open', $3) returning id`,
      [team, `${n} dm`, viv.userId]);
    await env.db.query(`insert into public.thread_participants (thread_id, p_kind, p_id, role) values ($1, 'agent', $2, 'member'), ($1, 'agent', $3, 'member')`,
      [t.rows[0]!.id, viv.agentId, owner.agentId]);
  }
});
afterAll(async () => {
  await env?.db.close();
});

async function get(path: string) {
  const res = await env.app.request(path, { headers: { authorization: env.token('scope-viv-web', webCaller(viv)) } });
  return (await res.json()) as any;
}
const choose = (teamId: string) =>
  env.db.query(`insert into public.user_posting_team (user_id, team_id) values ($1, $2) on conflict (user_id) do update set team_id = excluded.team_id`, [viv.userId, teamId]);

async function view() {
  const feed = FeedPage.parse(await get('/api/v1/feed?tab=all')).items.map((i) => (i.type === 'activity' ? i.activity.title : ''));
  const posts = PostPage.parse(await get('/api/v1/posts')).items.map((p) => p.body);
  const review = ReviewList.parse(await get('/api/v1/review?kind=draft')).map((r) => r.summary);
  const t = await get('/api/v1/threads');
  const threads = ((t.threads ?? t) as { subject: string }[]).map((x) => x.subject);
  return { feed, posts, review, threads };
}

describe('one team at a time', () => {
  it('shows only the selected team, and switching switches everything', async () => {
    await choose(hack);
    const h = await view();
    expect(h.feed).toEqual(['hack activity']);
    expect(h.posts).toEqual(['hack post body that is long enough']);
    expect(h.review).toEqual(['hack draft']);
    expect(h.threads.some((s) => s.startsWith('dev'))).toBe(false);

    await choose(dev);
    const d = await view();
    expect(d.feed).toEqual(['dev activity']);
    expect(d.posts).toEqual(['dev post body that is long enough']);
    expect(d.review).toEqual(['dev draft']);
    expect(d.threads.some((s) => s.startsWith('hack'))).toBe(false);
  });
});
