/**
 * Round-3 red-team regression (R11/R34): a new core must not break an
 * apps/mcp built before SetupSignalName. That build sends meta without
 * `wideSetupNames` and validates compare_setups names as ComponentName, so
 * core leaves out `model:...[1m]` and long plugin@marketplace names for it
 * (the old behaviour) and keeps them for a sender that says it parses them.
 * PGlite, fake safety (no network).
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompareSetupsOutput, ComponentName, McpSetupComponentSignal, type SetupSnapshot } from '@y/schema';
import { fx } from '@y/schema/fixtures';
import { z } from 'zod';

vi.mock('@y/safety', () => import('../messaging/test-fakes.js').then((m) => m.safety));
vi.mock('@y/domain', () => import('../messaging/test-fakes.js').then((m) => m.domain));
vi.mock('@y/retrieval', () => import('../messaging/test-fakes.js').then((m) => m.retrieval));

import { internalMcpModule } from '../internal-mcp/index.js';
import { GOOD_HMAC, agentCaller, makeEnv, seedPerson, seedTeam, type Person, type TestEnv } from '../messaging/test-support.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const base: Partial<SetupSnapshot> = { skills: [], subagents: [], hooks: [] };

/** compare_setups output as an apps/mcp built from the old schema validates it. */
const OldSignal = McpSetupComponentSignal.extend({ name: ComponentName });
const OldCompareSetupsOutput = CompareSetupsOutput.extend({ components: z.array(OldSignal).max(8) });

let env: TestEnv;
let alice: Person; let bob: Person;
let acme: string;

beforeEach(async () => {
  env = await makeEnv([internalMcpModule]);
  alice = await seedPerson(env.db, 'alice');
  bob = await seedPerson(env.db, 'bob');
  acme = await seedTeam(env.db, 'acme', [alice, bob]);
});
afterEach(async () => { await env.db.close(); });

async function seedSetup(p: Person, label: string, snap: SetupSnapshot): Promise<string> {
  const r = await env.db.query<{ id: string }>(
    `insert into public.setup_versions (agent_id, hash, snapshot, model) values ($1, $2, $3::jsonb, $4) returning id`,
    [p.agentId, sha(label), JSON.stringify(snap), snap.model]);
  return r.rows[0]!.id;
}

async function seedSessions(p: Person, sv: string, n: number, outcome = 'green') {
  for (let i = 0; i < n; i++) {
    await env.db.query(
      `insert into public.activities (agent_id, owner_user_id, team_id, kind, source, visibility, status, setup_version_id, outcome_status, tokens_total,
                                      screen_action, screen_label, screen_layers, published_at)
       values ($1, $2, $3, 'work', 'captured', 'team', 'published', $4, $5, 1000, 'allow', 'clean', '{l0}', now() - interval '1 day')`,
      [p.agentId, p.userId, acme, sv, outcome]);
  }
}

async function compare(p: Person, meta?: Record<string, unknown>) {
  const res = await env.app.request('/internal/mcp/compare_setups', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-y-internal': GOOD_HMAC, authorization: env.token(p.handle, agentCaller(p)) },
    body: JSON.stringify({ input: {}, ...(meta ? { meta } : {}) }),
  });
  const body = (await res.json()) as any;
  expect(body.ok).toBe(true);
  return body.output as unknown;
}

describe('R11: compare_setups names for an older apps/mcp', () => {
  const fixer = { name: 'vitest-fixer', scope: 'user' as const, descriptionRedacted: '', bodySha256: sha('vitest-fixer') };
  const longPlugin = { name: 'superpowers-extended-toolkit-for-agents', marketplace: 'anthropic-claude-plugins-official', version: '1.0.0' };

  beforeEach(async () => {
    const s1 = await seedSetup(alice, 'm1', fx.setupSnapshot({ ...base, model: 'claude-opus-5-5[1m]', plugins: [longPlugin] } as Partial<SetupSnapshot>));
    const s2 = await seedSetup(bob, 'm2', fx.setupSnapshot({ ...base, model: 'claude-opus-5-5', plugins: [], skills: [fixer] } as Partial<SetupSnapshot>));
    const s3 = await seedSetup(bob, 'm3', fx.setupSnapshot({ ...base, model: 'claude-opus-5-5', plugins: [longPlugin], skills: [fixer] } as Partial<SetupSnapshot>));
    await seedSessions(alice, s1, 3);
    await seedSessions(bob, s2, 3, 'unknown');
    await seedSessions(bob, s3, 2);
  });

  it('meta without wideSetupNames (an older apps/mcp): only ComponentName names, and the old schema accepts the result', async () => {
    const out = await compare(bob, { client: { name: 'claude-code', version: '2.5.0' }, requestId: 'req-1' });
    const parsed = CompareSetupsOutput.parse(out);
    const names = parsed.components.map((c) => c.name);
    expect(names).not.toContain('model:claude-opus-5-5[1m]');
    expect(names).not.toContain(`${longPlugin.name}@${longPlugin.marketplace}`);
    expect(names).toContain('vitest-fixer');
    for (const c of parsed.components) expect(OldSignal.safeParse(c).success).toBe(true);
    expect(OldCompareSetupsOutput.safeParse(out).success).toBe(true);
  });

  it('wideSetupNames: true (this apps/mcp) keeps the composed names', async () => {
    const out = CompareSetupsOutput.parse(await compare(bob, { wideSetupNames: true, nonce: 'n'.repeat(32) }));
    const names = out.components.map((c) => c.name);
    expect(names).toContain('model:claude-opus-5-5[1m]');
    expect(names).toContain(`${longPlugin.name}@${longPlugin.marketplace}`);
  });
});
