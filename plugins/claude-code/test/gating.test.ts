// Repo gating in the plugin: outside the team's linked repos nothing is queued or sent, and a
// pulse with a new policy version refreshes the cached brief.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IngestChunk } from '@y/schema/ingest';
import { emptyStats } from '@y/schema/stats';

vi.mock('@y/capture', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@y/capture')>();
  return {
    ...orig,
    snapshotSetup: async () => ({ v: 1, plugins: [], skills: [], mcpServers: [], hooks: [], model: 'claude-opus-5-5', subagents: [] }),
  };
});

import { computeRepoKey } from '@y/capture';
import { makeCtx, type HookEvent } from '../src/context.js';
import { repoAllowed, sessionRepoKey } from '../src/gating.js';
import { HANDLERS } from '../src/hooks/index.js';
import { listen } from '../src/listener.js';
import { listChunks, writeChunk } from '../src/outbox.js';
import { paths } from '../src/runtime.js';
import { readBrief } from '../src/state.js';
import { drainOutbox } from '../src/uploader.js';
import { loadConfig } from '../src/runtime.js';
import { brief, startFakeCore, testEnv, tmpDataDir, type FakeCore } from './helpers.js';

const SID = 'sess-gate-1';
const SALT = 's'.repeat(32);
const LINKED = computeRepoKey('git@github.com:acme/web.git', SALT)!;
const NO_KS = { pushPaths: false, networkContent: false, apply: false, ingest: false };

let dir: string;
let core: FakeCore;
beforeEach(async () => {
  dir = tmpDataDir();
  core = await startFakeCore(() => undefined);
});
afterEach(async () => {
  await core.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const stateFile = (name: string) => path.join(dir, 'state', name);
function gatedBrief(allowed: string[] | undefined, version = 'a'.repeat(16)): Record<string, unknown> {
  const b = brief([]);
  return { ...b, policy: { ...(b.policy as object), repoKeySalt: SALT, ...(allowed ? { allowedRepoKeys: allowed, policyVersion: version } : {}) } };
}
function writeBriefCache(b: Record<string, unknown>) {
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(stateFile('brief.json'), JSON.stringify({ ...b, fetchedAt: Date.now() }));
}
function project(remote?: string): string {
  const p = fs.mkdtempSync(path.join(dir, 'proj-'));
  if (remote) {
    fs.mkdirSync(path.join(p, '.git'));
    fs.writeFileSync(path.join(p, '.git', 'config'), `[remote "origin"]\n\turl = ${remote}\n`);
  }
  return p;
}
function run(event: HookEvent, input: Record<string, unknown>) {
  return HANDLERS[event](makeCtx(event, JSON.stringify(input), { env: testEnv(dir, core.url), spawnDetached: () => {} }));
}
const chunks = () => listChunks(paths(dir)).map((f) => IngestChunk.parse(JSON.parse(fs.readFileSync(f, 'utf8'))));
function transcript(): string {
  const t = path.join(dir, 't.jsonl');
  fs.writeFileSync(t, `${JSON.stringify({ type: 'user', uuid: 'u1', sessionId: SID, version: '2.1.300', timestamp: '2026-10-20T10:00:00.000Z', isSidechain: false, message: { role: 'user', content: 'hi' } })}\n`);
  return t;
}

describe('repoAllowed / sessionRepoKey', () => {
  it('allows only listed keys; an absent list (older core) allows everything', () => {
    expect(repoAllowed(undefined, undefined)).toBe(true);
    expect(repoAllowed({ policy: { capture: 'on' } } as never, undefined)).toBe(true);
    expect(repoAllowed({ policy: { capture: 'on', allowedRepoKeys: [LINKED] } } as never, LINKED)).toBe(true);
    expect(repoAllowed({ policy: { capture: 'on', allowedRepoKeys: [LINKED] } } as never, undefined)).toBe(false);
    expect(repoAllowed({ policy: { capture: 'on', allowedRepoKeys: [] } } as never, LINKED)).toBe(false);
  });

  it('keys the session from the git remote under the team salt', () => {
    writeBriefCache(gatedBrief([LINKED]));
    const b = readBrief(paths(dir));
    expect(sessionRepoKey(b, project('https://github.com/Acme/web'))).toBe(LINKED);
    expect(sessionRepoKey(b, project())).toBeUndefined();
  });

  it('a malformed allowed list fails closed', () => {
    writeBriefCache({ ...gatedBrief([LINKED]), policy: { ...(gatedBrief([LINKED]).policy as object), allowedRepoKeys: ['nope'] } });
    expect(readBrief(paths(dir))?.policy?.allowedRepoKeys).toEqual([]);
  });
});

describe('Stop and SessionEnd', () => {
  it('queue chunks (with the repo key) in a linked repo', async () => {
    writeBriefCache(gatedBrief([LINKED]));
    const cwd = project('git@github.com:acme/web.git');
    await run('Stop', { session_id: SID, transcript_path: transcript(), cwd });
    await run('SessionEnd', { session_id: SID, cwd, reason: 'other' });
    expect(chunks().map((c) => c.repoKey)).toEqual([LINKED, LINKED]);
  });

  it('queue nothing in an unlinked repo, a folder without a remote, or for a team with no repos', async () => {
    writeBriefCache(gatedBrief([LINKED]));
    for (const cwd of [project('git@github.com:acme/side-project.git'), project()]) {
      await run('Stop', { session_id: SID, transcript_path: transcript(), cwd });
      await run('SessionEnd', { session_id: SID, cwd, reason: 'other' });
    }
    writeBriefCache(gatedBrief([]));
    await run('Stop', { session_id: `${SID}-b`, transcript_path: transcript(), cwd: project('git@github.com:acme/web.git') });
    expect(chunks()).toEqual([]);
  });

  it('keep the old behaviour with a brief from a core without gating', async () => {
    writeBriefCache(gatedBrief(undefined));
    await run('Stop', { session_id: SID, transcript_path: transcript(), cwd: project() });
    expect(chunks()).toHaveLength(1);
  });
});

describe('uploader', () => {
  it('drops queued chunks from repos that are not linked without sending them', async () => {
    writeBriefCache(gatedBrief([LINKED]));
    const base = { v: 1, harness: 'claude_code', harnessVersion: '0', pluginVersion: '0.1.0', segmentIndex: 0, errorEpisodes: [], headless: false, permissionMode: 'default', sentAt: new Date().toISOString() };
    const stats = emptyStats('0');
    const mk = (sessionId: string, repoKey?: string) => IngestChunk.safeParse({ ...base, sessionId, seq: 0, statsDelta: stats, ...(repoKey ? { repoKey } : {}) });
    const linked = mk('s-linked', LINKED);
    const other = mk('s-other', computeRepoKey('git@github.com:acme/side.git', SALT));
    if (!linked.success || !other.success) throw new Error('fixture chunk invalid');
    writeChunk(paths(dir), other.data, Date.now());
    writeChunk(paths(dir), linked.data, Date.now() + 1);
    core.route = (r) => (r.url.startsWith('/api/v1/ingest') ? { body: { accepted: true, pulse: { unread: 0, cursor: '0' } } } : { body: { killSwitches: NO_KS } });
    await drainOutbox({ config: loadConfig(testEnv(dir, core.url)), paths: paths(dir), fetch, backoffMs: 1, sleep: async () => {} });
    const sent = core.requests.filter((r) => r.url.startsWith('/api/v1/ingest')).map((r) => (r.body as { sessionId: string }).sessionId);
    expect(sent).toEqual(['s-linked']);
    expect(listChunks(paths(dir))).toEqual([]);
  });
});

describe('listener', () => {
  it('re-fetches the brief when the pulse carries another policy version', async () => {
    writeBriefCache(gatedBrief([], 'a'.repeat(16)));
    core.route = (r) => {
      if (r.url.startsWith('/api/v1/agent/brief')) return { body: gatedBrief([LINKED], 'b'.repeat(16)) };
      return { body: { cursor: 'cur_1', unread: { dm: 0, ownerInstructions: 0, reviews: 0, suggestions: 0 }, approvedChanges: [], killSwitches: NO_KS, policyVersion: 'b'.repeat(16) } };
    };
    await listen(makeCtx('Stop', JSON.stringify({ session_id: SID }), { env: testEnv(dir, core.url) }), { runMs: 3_500, sleep: async () => {} });
    expect(core.requests.some((r) => r.url.startsWith('/api/v1/agent/brief'))).toBe(true);
    expect(readBrief(paths(dir))?.policy?.allowedRepoKeys).toEqual([LINKED]);
  });
});
