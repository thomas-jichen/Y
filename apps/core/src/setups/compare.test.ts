import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompareSetupsOutput, type SetupSnapshot } from '@y/schema';
import { fx } from '@y/schema/fixtures';

vi.mock('@y/safety', () => import('../messaging/test-fakes.js').then((m) => m.safety));
vi.mock('@y/domain', () => import('../messaging/test-fakes.js').then((m) => m.domain));
vi.mock('@y/retrieval', () => import('../messaging/test-fakes.js').then((m) => m.retrieval));

import { internalMcpModule } from '../internal-mcp/index.js';
import { agentCaller, callTool, makeEnv, seedPerson, seedTeam, type Person, type TestEnv } from '../messaging/test-support.js';
import { computeSignals, headlineFor, wilsonLower, type Session } from './compare.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const skill = (name: string) => ({ name, scope: 'user' as const, descriptionRedacted: '', bodySha256: sha(name) });
const DAY = 86_400_000;

let env: TestEnv;
let alice: Person; let bob: Person; let carol: Person; let dave: Person;
let acme: string; let other: string;

async function seedSetup(p: Person, label: string, snap: SetupSnapshot, ageDays = 0): Promise<string> {
  const r = await env.db.query<{ id: string }>(
    `insert into public.setup_versions (agent_id, hash, snapshot, model, created_at) values ($1, $2, $3::jsonb, $4, now() - make_interval(days => $5)) returning id`,
    [p.agentId, sha(label), JSON.stringify(snap), snap.model, ageDays]);
  return r.rows[0]!.id;
}

interface ActOpts { status?: string; source?: string; visibility?: string; ageDays?: number; kind?: string; sessionId?: string; startedInMin?: number }
async function seedAct(p: Person, team: string, sv: string | null, outcome: string, tokens: number, o: ActOpts = {}) {
  const status = o.status ?? 'published';
  await env.db.query(
    `insert into public.activities (agent_id, owner_user_id, team_id, kind, source, visibility, status, setup_version_id, outcome_status, tokens_total,
                                    screen_action, screen_label, screen_layers, published_at, session_id, started_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'allow', 'clean', '{l0}', case when $7 = 'published' then now() - make_interval(days => $11) end,
             $12, clock_timestamp() + make_interval(mins => $13))`,
    [p.agentId, p.userId, team, o.kind ?? 'work', o.source ?? 'captured', o.visibility ?? 'team', status, sv, outcome, tokens, o.ageDays ?? 1,
     o.sessionId ?? null, o.startedInMin ?? 0]);
}

/** n sessions, the first `wins` verified (alternating shipped/green), the rest unknown/partial. */
async function seedMany(p: Person, team: string, sv: string, n: number, wins: number, tokensOnWin: number) {
  for (let i = 0; i < n; i++) {
    const ok = i < wins;
    await seedAct(p, team, sv, ok ? (i % 2 ? 'green' : 'shipped') : (i % 2 ? 'partial' : 'unknown'), ok ? tokensOnWin : 99_000);
  }
}

beforeEach(async () => {
  env = await makeEnv([internalMcpModule]);
  alice = await seedPerson(env.db, 'alice');
  bob = await seedPerson(env.db, 'bob');
  carol = await seedPerson(env.db, 'carol');
  dave = await seedPerson(env.db, 'dave');
  acme = await seedTeam(env.db, 'acme', [alice, bob, carol]);
  other = await seedTeam(env.db, 'other', [dave]);

  // Everyone has plugin y@y, MCP y, model claude-opus-5-5 (universal: no contrast).
  const base: Partial<SetupSnapshot> = { skills: [], subagents: [], hooks: [] };
  const fixer = fx.setupSnapshot({ ...base, skills: [skill('vitest-fixer'), skill('zz-helper')], claudeMd: { sha256: sha('md'), headings: ['Secret heading text'] } });
  const plain = fx.setupSnapshot({ ...base });
  const rare = fx.setupSnapshot({ ...base, skills: [skill('rare-skill')] });
  delete (plain as Partial<SetupSnapshot>).claudeMd;
  delete (rare as Partial<SetupSnapshot>).claudeMd;

  const aFix = await seedSetup(alice, 'a-fix', fixer);
  const bFix = await seedSetup(bob, 'b-fix', fixer, 5);
  const bPlain = await seedSetup(bob, 'b-plain', plain, 10);
  const cPlain = await seedSetup(carol, 'c-plain', plain, 1);
  const cRare = await seedSetup(carol, 'c-rare', rare);

  // With vitest-fixer: 7 sessions, 2 owners, 5 wins (71%); median tokens on win 20k.
  await seedMany(alice, acme, aFix, 4, 3, 20_000);
  await seedMany(bob, acme, bFix, 3, 2, 20_000);
  // Without: 11 sessions, 6 wins (55%); median tokens on win 30k. rare-skill: 3 sessions, carol only.
  await seedMany(bob, acme, bPlain, 5, 3, 30_000);
  await seedMany(carol, acme, cPlain, 3, 2, 30_000);
  await seedMany(carol, acme, cRare, 3, 1, 30_000);

  // Excluded: drafts, agent-reported, private, scroll reports, outside the window, no team.
  await seedAct(alice, acme, aFix, 'unknown', 1, { status: 'draft' });
  await seedAct(alice, acme, aFix, 'green', 1, { source: 'agent_reported' });
  await seedAct(alice, acme, aFix, 'unknown', 1, { visibility: 'private' });
  await seedAct(alice, acme, aFix, 'green', 1, { ageDays: 120 });

  // Another team: dave, with vitest-fixer, all failing. Never pooled with acme.
  const dFix = await seedSetup(dave, 'd-fix', fixer);
  const dPlain = await seedSetup(dave, 'd-plain', plain, 3);
  await seedMany(dave, other, dFix, 6, 0, 1);
  await seedMany(dave, other, dPlain, 6, 6, 1);
});
afterEach(async () => { await env.db.close(); });

describe('compare_setups', () => {
  it('contrasts team sessions with vs without each component (measured, Wilson, tokens, you)', async () => {
    const r = await callTool(env, 'compare_setups', env.token('alice', agentCaller(alice)), {});
    expect(r.body.ok).toBe(true);
    const out = CompareSetupsOutput.parse(r.body.output);
    expect(out.signed_in).toBe(true);
    expect(out.segment).toMatchObject({ slug: 'all-work', n: 18, owners: 3 });
    expect(out.insufficient_data).toBe(false);
    const top = out.components[0]!;
    expect(top).toMatchObject({
      kind: 'skill', name: 'vitest-fixer', label: 'measured', you_use: true,
      with: { n: 7, owners: 2, success_rate: 0.714, median_tokens_on_success: 20_000 },
      without: { n: 11, owners: 2, success_rate: 0.545, median_tokens_on_success: 30_000 },
      tokens_delta: -0.333,
      // zz-helper and CLAUDE.md are in exactly the same sessions.
      collinear: 2,
    });
    expect(top.with.success_wilson).toBeCloseTo(wilsonLower(5, 7), 3);
    expect(top.with.success_wilson).toBeCloseTo(0.359, 2);
    expect(top.lift).toBeCloseTo(0.169, 3);
    expect(top.top_owner_share).toBeCloseTo(4 / 7, 3);
    expect(out.you).toEqual({ rank: null, success_rate: 0.75, n: 4, trend_30d: 0 });
    expect(out.headline).toBe(
      'skill vitest-fixer: 71% verified success with it vs 55% without (n=7 sessions, 2 owners vs n=11); your agent: 75% (n=4); you already use it');

    // rare-skill: 3 sessions from one owner → shown only as an early signal.
    const rare = out.components.find((c) => c.name === 'rare-skill')!;
    expect(rare).toMatchObject({ label: 'early_signal', with: { n: 3, owners: 1 }, top_owner_share: 1, you_use: false });

    // Universal components (y plugin, y MCP server, model) have no contrast; headings never appear.
    const names = out.components.map((c) => `${c.kind}:${c.name}`);
    expect(names).not.toContain('plugin:y@y');
    expect(names).not.toContain('mcp_server:y');
    expect(names).not.toContain('setting:model:claude-opus-5-5');
    expect(names).not.toContain('skill:zz-helper');
    expect(JSON.stringify(out)).not.toContain('Secret heading');
    // Output budget: well under 1,500 tokens (~4 chars/token).
    expect(JSON.stringify(out).length).toBeLessThan(6000);
  });

  it('is team-scoped: another team sees only its own sessions; a teammate gets you_use false', async () => {
    const d = CompareSetupsOutput.parse((await callTool(env, 'compare_setups', env.token('dave', agentCaller(dave)), {})).body.output);
    expect(d.segment).toMatchObject({ n: 12, owners: 1 });
    const fx = d.components.find((c) => c.name === 'vitest-fixer')!;
    expect(fx).toMatchObject({ label: 'early_signal', with: { n: 6, owners: 1, success_rate: 0 }, without: { n: 6, success_rate: 1 }, lift: -1 });
    expect(d.headline).toBeNull();
    expect(d.insufficient_data).toBe(true);

    const c = CompareSetupsOutput.parse((await callTool(env, 'compare_setups', env.token('carol', agentCaller(carol)), {})).body.output);
    expect(c.segment!.n).toBe(18);
    expect(c.components[0]).toMatchObject({ name: 'vitest-fixer', you_use: false, with: { n: 7 } });
    expect(c.you).toMatchObject({ n: 6, success_rate: 0.5 });
    expect(c.headline).toMatch(/your agent: 50% \(n=6\); you do not use it$/);
  });

  it('a stranger with no team, and a signed-out caller, get nothing', async () => {
    const eve = await seedPerson(env.db, 'eve');
    const s = CompareSetupsOutput.parse((await callTool(env, 'compare_setups', env.token('eve', agentCaller(eve)), {})).body.output);
    expect(s).toEqual({ segment: null, rows: [], you: null, insufficient_data: true, signed_in: true, components: [], headline: null });
    const anon = CompareSetupsOutput.parse((await callTool(env, 'compare_setups', undefined, {})).body.output);
    expect(anon).toEqual({ segment: null, rows: [], you: null, insufficient_data: true, signed_in: false, components: [], headline: null });
  });
});

describe('compare_setups review fixes', () => {
  const svId = async (label: string) =>
    (await env.db.query<{ id: string }>('select id from public.setup_versions where hash = $1', [sha(label)])).rows[0]!.id;
  const out = async (p: Person) =>
    CompareSetupsOutput.parse((await callTool(env, 'compare_setups', env.token(p.handle.slice(1), agentCaller(p)), {})).body.output);

  it('counts several work segments of one harness session as ONE session (success if any segment verified)', async () => {
    const sid = (await env.db.query<{ id: string }>(
      `insert into public.sessions (agent_id, harness_session_id) values ($1, 'multi-seg') returning id`, [alice.agentId])).rows[0]!.id;
    const aFix = await svId('a-fix');
    await seedAct(alice, acme, aFix, 'unknown', 1000, { sessionId: sid });
    await seedAct(alice, acme, aFix, 'partial', 1000, { sessionId: sid });
    await seedAct(alice, acme, aFix, 'green', 1000, { sessionId: sid });
    const r = await out(alice);
    expect(r.segment).toMatchObject({ n: 19, owners: 3 });
    const top = r.components.find((c) => c.name === 'vitest-fixer')!;
    expect(top.with).toMatchObject({ n: 8, owners: 2, success_rate: 0.75 });
    expect(r.you).toMatchObject({ n: 5, success_rate: 0.8 });
  });

  it('you_use follows the setup the agent most recently ran, not the newest setup row (A → B → A)', async () => {
    // carol's newest setup_versions row is c-rare; her latest activity runs c-plain again.
    expect((await out(carol)).components.find((c) => c.name === 'rare-skill')!.you_use).toBe(true);
    await seedAct(carol, acme, await svId('c-plain'), 'unknown', 1, { status: 'open', startedInMin: 5 });
    expect((await out(carol)).components.find((c) => c.name === 'rare-skill')!.you_use).toBe(false);
  });

  it('segment.n counts only sessions the component arms are built from', async () => {
    await seedAct(alice, acme, null, 'green', 1);
    await seedAct(alice, acme, null, 'green', 1);
    const r = await out(alice);
    expect(r.segment).toMatchObject({ n: 18, owners: 3 });
  });

  it('returns nothing while the network_content kill switch is engaged', async () => {
    await env.db.query(`update public.kill_switches set engaged = true where name = 'network_content'`);
    expect(await out(alice)).toEqual({ segment: null, rows: [], you: null, insufficient_data: true, signed_in: true, components: [], headline: null });
  });

  it('headline omits a zero token change instead of printing −0%', () => {
    const c = {
      kind: 'skill' as const, name: 'x', label: 'measured' as const,
      with: { n: 5, owners: 2, success_rate: 0.8, success_wilson: 0.3, median_tokens_on_success: 10 },
      without: { n: 5, owners: 2, success_rate: 0.4, success_wilson: 0.1, median_tokens_on_success: 10 },
      lift: 0.4, tokens_delta: 0, top_owner_share: 0.6, you_use: false, collinear: 0,
    };
    const h = headlineFor(c, null)!;
    expect(h).not.toContain('tokens');
    expect(h).not.toContain('−0%');
  });
});

describe('computeSignals', () => {
  const mk = (owner: string, sv: string, success: boolean, i: number): Session => ({
    id: `s${i}`, agentId: `ag-${owner}`, ownerId: owner, setupVersionId: sv, success, tokens: 1000, publishedAt: new Date(),
  });
  const run = (withOwners: string[], nWithout: number, withoutOwners = ['y', 'z']) => {
    const sessions: Session[] = [];
    withOwners.forEach((o, i) => sessions.push(mk(o, 'w', i % 2 === 0, i)));
    for (let i = 0; i < nWithout; i++) sessions.push(mk(withoutOwners[i % withoutOwners.length]!, 'wo', false, 100 + i));
    const comps = new Map([['w', new Set(['skill\u0000x', 'plugin\u0000base'])], ['wo', new Set(['plugin\u0000base'])]]);
    return computeSignals(sessions, comps, { agentId: null, latestSetupId: null });
  };

  it('labels measured only at n ≥ 5 per arm and ≥ 2 owners per arm', () => {
    expect(run(['a', 'b', 'a', 'b', 'a'], 5)[0]!.label).toBe('measured');
    // a without arm from a single owner is one person's habits, not a contrast
    expect(run(['a', 'b', 'a', 'b', 'a'], 5, ['z'])[0]!.label).toBe('early_signal');
    expect(run(['a', 'b', 'a', 'b'], 5)[0]!.label).toBe('early_signal');
    expect(run(['a', 'a', 'a', 'a', 'a'], 5)[0]!.label).toBe('early_signal');
    expect(run(['a', 'b', 'a', 'b', 'a'], 4)[0]!.label).toBe('early_signal');
    // universal plugin never shows; an arm under 2 sessions is not shown at all
    expect(run(['a', 'b', 'a', 'b', 'a'], 5).map((c) => c.name)).toEqual(['x']);
    expect(run(['a', 'b'], 1)).toEqual([]);
  });

  it('caps the list at 8 and keeps the output within budget', () => {
    const sessions: Session[] = [];
    const comps = new Map<string, Set<string>>();
    for (let i = 0; i < 400; i++) {
      const sv = `sv${i % 40}`;
      sessions.push(mk(`o${i % 7}`, sv, i % 3 === 0, i));
      if (!comps.has(sv)) {
        const set = new Set<string>();
        for (let k = 0; k < 60; k++) if (sha(`${sv}:${k}`).charCodeAt(0) % 3 === 0) set.add(`skill\u0000skill-with-a-long-name-${String(k).padStart(2, '0')}-abcdefghijklmnopqrstuvwxyz0123`);
        comps.set(sv, set);
      }
    }
    const out = computeSignals(sessions, comps, { agentId: 'ag-o1', latestSetupId: 'sv1' });
    expect(out.length).toBe(8);
    const full: CompareSetupsOutput = {
      segment: { slug: 'all-work', name: 'All captured work on your team', kind: 'organic', n: 400, owners: 7, method: 'x'.repeat(300) },
      rows: [], you: { rank: null, success_rate: 0.333, n: 57, trend_30d: 0 }, insufficient_data: false, signed_in: true,
      components: out, headline: headlineFor(out[0], { rank: null, success_rate: 0.333, n: 57, trend_30d: 0 }) ?? 'x'.repeat(300),
    };
    expect(CompareSetupsOutput.safeParse(full).success).toBe(true);
    expect(JSON.stringify(full).length / 4).toBeLessThan(1500);
  });
});
