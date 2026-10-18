/**
 * Regression tests for red-team findings in the plugin (numbers in the test
 * names). Synthetic fixtures, a fake core on 127.0.0.1, no other network.
 * `@y/capture` is the real library except `snapshotSetup`, which returns a
 * fixed synthetic snapshot (so nothing reads this machine's real config).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IngestChunk } from '@y/schema/ingest';

vi.mock('@y/capture', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@y/capture')>();
  return {
    ...orig,
    snapshotSetup: async () => ({ v: 1, plugins: [], skills: [], mcpServers: [], hooks: [], model: 'claude-opus-5-5', subagents: [] }),
  };
});

import { makeCtx, type HookEvent } from '../src/context.js';
import { HANDLERS } from '../src/hooks/index.js';
import { listen, MIN_IDLE_POLL_MS } from '../src/listener.js';
import { listChunks, outboxBytes, writeChunk } from '../src/outbox.js';
import { gitIdentity, identityTerms, parseGitUser, redactText } from '../src/redaction.js';
import { allocSeq, isInsecureUrl, loadConfig, paths } from '../src/runtime.js';
import { readBrief } from '../src/state.js';
import { drainOutbox, MAX_NETWORK_ERRORS_PER_RUN } from '../src/uploader.js';
import { takeWake, WAKE_LOCK_STALE_MS } from '../src/wake-budget.js';
import { brief, startFakeCore, testEnv, tmpDataDir, ULID, type FakeCore } from './helpers.js';

const SID = 'sess-rt-1';
const TID = `t_${ULID}`;
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

function writeBriefCache(b: Record<string, unknown>) {
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(stateFile('brief.json'), JSON.stringify({ ...b, fetchedAt: Date.now() }));
}

function run(event: HookEvent, input: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
  return HANDLERS[event](makeCtx(event, JSON.stringify(input), { env: testEnv(dir, core.url, extraEnv), spawnDetached: () => {} }));
}

function listenCtx(extraEnv: Record<string, string> = {}, sid = SID) {
  return makeCtx('Stop', JSON.stringify({ session_id: sid }), { env: testEnv(dir, core.url, extraEnv) });
}

function pulseBody(extra: Record<string, unknown> = {}) {
  return {
    cursor: 'cur_1',
    unread: { dm: 1, ownerInstructions: 0, reviews: 0, suggestions: 0 },
    approvedChanges: [],
    killSwitches: NO_KS,
    ...extra,
  };
}

const dmWake = { targetSessionId: SID, pointer: { template_id: 'P1', params: { count: 1, handle: '@bob-dev', thread_id: TID } } };

describe('#62 wake_on_dm=owner-only', () => {
  it('a DM wake does not wake the session; it is parked for the next prompt', async () => {
    core.route = () => ({ body: pulseBody({ wake: dmWake }) });
    const r = await listen(listenCtx({ CLAUDE_PLUGIN_OPTION_WAKE_ON_DM: 'owner-only' }), { runMs: 3_500, sleep: async () => {} });
    expect(r).toEqual({ exitCode: 0 });
    expect(fs.existsSync(stateFile(`pending-wake-${SID}.json`))).toBe(true);
    expect(fs.existsSync(stateFile('wake-budget.json'))).toBe(false);
  });

  it('an owner instruction (P4) still wakes an owner-only session', async () => {
    core.route = () => ({
      body: pulseBody({
        unread: { dm: 0, ownerInstructions: 1, reviews: 0, suggestions: 0 },
        wake: { targetSessionId: SID, pointer: { template_id: 'P4', params: { count: 1 } } },
      }),
    });
    const r = await listen(listenCtx({ CLAUDE_PLUGIN_OPTION_WAKE_ON_DM: 'owner-only' }), { runMs: 10_000, sleep: async () => {} });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toBe('Y: your owner left 1 instruction(s). Call the inbox tool.');
  });

  it('the teammates default still wakes on a DM', async () => {
    core.route = () => ({ body: pulseBody({ wake: dmWake }) });
    const r = await listen(listenCtx(), { runMs: 10_000, sleep: async () => {} });
    expect(r.exitCode).toBe(2);
  });
});

describe('#63 offline uploads', () => {
  it('network errors never dead-letter a chunk, however many runs fail', async () => {
    await run('SessionEnd', { session_id: SID });
    const config = loadConfig(testEnv(dir, core.url));
    let calls = 0;
    const offline = (async () => {
      calls++;
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    for (let i = 0; i < 3; i++) {
      const s = await drainOutbox({ config, paths: paths(dir), fetch: offline, backoffMs: 1, sleep: async () => {} });
      expect(s).toMatchObject({ sent: 0, dead: 0, remaining: 1 });
    }
    expect(calls).toBe(3 * MAX_NETWORK_ERRORS_PER_RUN);
    expect(fs.existsSync(path.join(dir, 'outbox', 'dead'))).toBe(false);
    // Back online: it goes out.
    core.route = () => ({ body: { accepted: true, pulse: { unread: 0, cursor: 'cur_1' } } });
    expect(await drainOutbox({ config, paths: paths(dir), fetch, sleep: async () => {} })).toMatchObject({ sent: 1, dead: 0, remaining: 0 });
  });
});

describe('#64 kill switches reach live sessions', () => {
  it('the uploader keeps chunks in the outbox while the ingest switch is engaged', async () => {
    writeBriefCache(brief([], { killSwitches: { ...NO_KS, ingest: true } }));
    await run('SessionEnd', { session_id: SID });
    core.route = () => ({ body: { accepted: true, pulse: { unread: 0, cursor: 'cur_1' } } });
    const s = await drainOutbox({ config: loadConfig(testEnv(dir, core.url)), paths: paths(dir), fetch, sleep: async () => {} });
    expect(s).toMatchObject({ sent: 0, remaining: 1 });
    expect(core.requests).toHaveLength(0);
  });

  it("the listener saves the pulse's kill switches, so the next UserPromptSubmit honours push_paths", async () => {
    writeBriefCache(brief([]));
    fs.writeFileSync(stateFile('pulse.json'), JSON.stringify({ cursor: 'c0', unread: { dm: 3, ownerInstructions: 0, reviews: 0, suggestions: 0 }, updatedAt: 1 }));
    core.route = () => ({ body: pulseBody({ unread: { dm: 3, ownerInstructions: 0, reviews: 0, suggestions: 0 }, killSwitches: { ...NO_KS, pushPaths: true, ingest: true } }) });
    await listen(listenCtx(), { runMs: 3_500, sleep: async () => {} });
    expect(readBrief(paths(dir))?.killSwitches).toEqual({ ...NO_KS, pushPaths: true, ingest: true });
    expect(await run('UserPromptSubmit', { session_id: SID, prompt: 'x' })).toEqual({ exitCode: 0 });
    // Released on a later pulse: pointers flow again.
    core.route = () => ({ body: pulseBody({ cursor: 'cur_2', unread: { dm: 3, ownerInstructions: 0, reviews: 0, suggestions: 0 } }) });
    await listen(listenCtx(), { runMs: 3_500, sleep: async () => {} });
    expect(readBrief(paths(dir))?.killSwitches).toEqual(NO_KS);
    const out = await run('UserPromptSubmit', { session_id: SID, prompt: 'y' });
    expect(JSON.parse(out.stdout!).hookSpecificOutput.additionalContext).toBe('Y: 3 unread DM(s). Call the inbox tool.');
  });
});

describe('#65 per-session pulse cursor', () => {
  it("the uploader's ingest cursor and a sibling's cursor don't replace this session's own", async () => {
    core.route = (req) => (req.url.startsWith('/api/v1/pulse') ? { body: pulseBody({ cursor: 'cur_100' }) } : { body: { accepted: true, pulse: { unread: 0, cursor: '999' } } });
    await listen(listenCtx(), { runMs: 3_500, sleep: async () => {} });
    // A Stop upload stores the server watermark in the shared pulse.json...
    await run('SessionEnd', { session_id: 'sess-other-2' });
    await drainOutbox({ config: loadConfig(testEnv(dir, core.url)), paths: paths(dir), fetch, sleep: async () => {} });
    expect(JSON.parse(fs.readFileSync(stateFile('pulse.json'), 'utf8')).cursor).toBe('999');
    // A session with no cursor yet starts from the shared one...
    core.requests.length = 0;
    core.route = () => ({ body: pulseBody({ cursor: 'cur_200' }) });
    await listen(listenCtx({}, 'sess-new-3'), { runMs: 3_500, sleep: async () => {} });
    expect(new URL(core.requests[0]!.url, 'http://x').searchParams.get('cursor')).toBe('999');
    // ...while this session's listener still polls from its own position.
    core.requests.length = 0;
    await listen(listenCtx(), { runMs: 3_500, sleep: async () => {} });
    expect(new URL(core.requests[0]!.url, 'http://x').searchParams.get('cursor')).toBe('cur_100');
  });
});

describe('#103 setup snapshot delivery', () => {
  function transcriptLine(i: number): string {
    return `${JSON.stringify({ type: 'user', uuid: `u${i}`, sessionId: SID, version: '2.1.300', timestamp: '2026-10-17T10:00:00.000Z', isSidechain: false, message: { role: 'user', content: `prompt ${i}` } })}\n`;
  }

  it('setup-sent is recorded only after core accepted a chunk carrying the snapshot', async () => {
    writeBriefCache(brief([]));
    const proj = fs.mkdtempSync(path.join(dir, 'proj-'));
    const transcript = path.join(dir, 't.jsonl');
    const chunks = () => listChunks(paths(dir)).map((f) => IngestChunk.parse(JSON.parse(fs.readFileSync(f, 'utf8'))));
    fs.writeFileSync(transcript, transcriptLine(1));
    await run('Stop', { session_id: SID, transcript_path: transcript, cwd: proj });
    expect(chunks()[0]!.setup?.snapshot).toBeDefined();
    expect(fs.existsSync(stateFile('setup-sent.json'))).toBe(false);

    // The upload failed (dead-lettered, offline...): the next Stop carries the snapshot again.
    for (const f of listChunks(paths(dir))) fs.rmSync(f);
    fs.appendFileSync(transcript, transcriptLine(2));
    await run('Stop', { session_id: SID, transcript_path: transcript, cwd: proj });
    expect(chunks()[0]!.setup?.snapshot).toBeDefined();

    core.route = () => ({ body: { accepted: true, pulse: { unread: 0, cursor: 'cur_1' } } });
    await drainOutbox({ config: loadConfig(testEnv(dir, core.url)), paths: paths(dir), fetch, sleep: async () => {} });
    const hash = (core.requests[0]!.body as { setup: { hash: string } }).setup.hash;
    expect(JSON.parse(fs.readFileSync(stateFile('setup-sent.json'), 'utf8'))).toEqual({ hash });

    fs.appendFileSync(transcript, transcriptLine(3));
    await run('Stop', { session_id: SID, transcript_path: transcript, cwd: proj });
    expect(chunks()[0]!.setup).toEqual({ hash });
  });
});

describe('#104 long-poll floor', () => {
  it('a core that answers every long poll instantly with nothing new is polled a few times, not hundreds', async () => {
    core.route = () => ({ body: pulseBody({ unread: { dm: 0, ownerInstructions: 0, reviews: 0, suggestions: 0 } }) });
    const delays: number[] = [];
    await listen(listenCtx(), { runMs: 10_000, sleep: async (ms) => void delays.push(ms) });
    expect(core.requests.length).toBeLessThan(10);
    expect(delays[0]).toBeGreaterThanOrEqual(MIN_IDLE_POLL_MS);
    expect(delays[1]).toBeGreaterThan(delays[0]!);
  });

  it('back-to-back polls that move the cursor are not delayed', async () => {
    let n = 0;
    // Five polls with new events each, then nothing new.
    core.route = () => ({ body: pulseBody({ cursor: `cur_${Math.min(5, ++n)}`, unread: { dm: 0, ownerInstructions: 0, reviews: 0, suggestions: 0 } }) });
    let requestsAtFirstSleep = -1;
    await listen(listenCtx(), {
      runMs: 10_000,
      sleep: async () => {
        if (requestsAtFirstSleep < 0) requestsAtFirstSleep = core.requests.length;
      },
    });
    expect(requestsAtFirstSleep).toBe(6);
  });
});

describe('#105 bounded data dir', () => {
  it('over the cap, the oldest dead chunks go first, then new chunks are written stats-only', async () => {
    const p = paths(dir);
    fs.mkdirSync(p.dead, { recursive: true });
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(p.dead, `000000000000${i}-old-000000.json`), 'x'.repeat(1000));
    const chunk = IngestChunk.parse({
      v: 1,
      harness: 'claude_code',
      harnessVersion: '0',
      pluginVersion: '0.1.0',
      sessionId: SID,
      seq: 0,
      segmentIndex: 0,
      statsDelta: (await import('@y/schema/stats')).emptyStats('0'),
      errorEpisodes: [],
      digest: { text: 'USER: hello', sha256: 'a'.repeat(64), redaction: { hitsByRule: {}, dropped: false } },
      headless: false,
      permissionMode: 'unknown',
      sentAt: new Date().toISOString(),
    });
    writeChunk(p, chunk, 1, 2500);
    expect(fs.readdirSync(p.dead)).toEqual(['0000000000001-old-000000.json', '0000000000002-old-000000.json']);
    let written = JSON.parse(fs.readFileSync(listChunks(p)[0]!, 'utf8'));
    expect(written.digest).toBeDefined(); // under the cap again after evicting one dead chunk

    writeChunk(p, { ...chunk, seq: 1 }, 2, 100);
    expect(fs.readdirSync(p.dead)).toEqual([]);
    written = JSON.parse(fs.readFileSync(listChunks(p)[1]!, 'utf8'));
    expect(written.digest).toBeUndefined();
    expect(IngestChunk.safeParse(written).success).toBe(true);
    expect(outboxBytes(p)).toBeGreaterThan(0);
  });

  it('allocSeq keeps numbers unique and increasing without a directory per chunk', () => {
    const p = paths(dir);
    const got = Array.from({ length: 5 }, () => allocSeq(p, SID));
    expect(got).toEqual([0, 1, 2, 3, 4]);
    expect(fs.readdirSync(path.join(p.seq, SID))).toEqual(['4']);
    expect(allocSeq(p, SID)).toBe(5);
  });
});

describe('#106 git identity redaction', () => {
  it('reads [user] name/email from the repo config and redacts the name', () => {
    const repo = fs.mkdtempSync(path.join(dir, 'repo-'));
    fs.mkdirSync(path.join(repo, '.git'));
    fs.writeFileSync(path.join(repo, '.git', 'config'), '[core]\n\tbare = false\n[user]\n\tname = Zelda Quintanilla\n\temail = zq@example.org\n[remote "origin"]\n\turl = git@github.com:acme-rt/widgets.git\n');
    expect(parseGitUser(fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8'))).toEqual({ name: 'Zelda Quintanilla', email: 'zq@example.org' });
    expect(gitIdentity(path.join(repo), dir)).toEqual({ name: 'Zelda Quintanilla', email: 'zq@example.org' });
    expect(identityTerms(repo)?.user).toEqual(expect.arrayContaining(['Zelda Quintanilla', 'Zelda', 'Quintanilla']));
    const r = redactText('commit abc Author: Zelda Quintanilla <zq@example.org> fix by Zelda', repo);
    expect(r.text).not.toMatch(/Zelda|Quintanilla/);
    expect(r.dropped).toBe(false);
  });

  it('falls back to ~/.gitconfig', () => {
    fs.writeFileSync(path.join(dir, '.gitconfig'), '[user]\n  name = "Orla Fennimore"\n');
    expect(gitIdentity(undefined, dir)).toEqual({ name: 'Orla Fennimore' });
  });
});

describe('#107 cleartext api_url', () => {
  it('withholds the token for plain http to another host; loopback and https are unchanged', () => {
    const base = { CLAUDE_PLUGIN_OPTION_AGENT_TOKEN: 'tok_test_install_0000000000', Y_DATA_DIR: dir };
    expect(loadConfig({ ...base, CLAUDE_PLUGIN_OPTION_API_URL: 'http://y.example.com' })).toMatchObject({ token: undefined, insecureApiUrl: true });
    for (const url of ['https://y.example.com', 'http://localhost:8787', 'http://127.0.0.1:9', 'http://[::1]:8787', 'http://core.localhost']) {
      const c = loadConfig({ ...base, CLAUDE_PLUGIN_OPTION_API_URL: url });
      expect(c.token, url).toBe('tok_test_install_0000000000');
      expect(c.insecureApiUrl, url).toBeUndefined();
    }
    expect(loadConfig({ ...base }).token).toBe('tok_test_install_0000000000'); // default http://localhost:8787
    expect(loadConfig({ ...base, CLAUDE_PLUGIN_OPTION_API_URL: 'http://devbox.lan:8787', Y_ALLOW_INSECURE_URL: '1' }).token).toBe('tok_test_install_0000000000');
    expect(isInsecureUrl('http://10.0.0.5:8787')).toBe(true);
  });

  it('SessionStart sends nothing and tells the human why', async () => {
    const r = await run('SessionStart', { session_id: SID }, { CLAUDE_PLUGIN_OPTION_API_URL: 'http://y.example.com' });
    expect(JSON.parse(r.stdout!).systemMessage).toMatch(/^Y: api_url is plain http:\/\//);
    expect(core.requests).toHaveLength(0);
  });
});

describe('#108 wake budget lock', () => {
  it('a concurrent holder makes takeWake return busy without recording; a stale lock is broken', () => {
    const p = paths(dir);
    const lock = path.join(p.state, 'wake-budget.lock');
    fs.mkdirSync(lock, { recursive: true });
    const now = 1_800_000_000_000;
    expect(takeWake(p, now)).toEqual({ allow: false, reason: 'busy' });
    expect(fs.existsSync(path.join(p.state, 'wake-budget.json'))).toBe(false);
    const old = (Date.now() - WAKE_LOCK_STALE_MS - 1_000) / 1000;
    fs.utimesSync(lock, old, old);
    expect(takeWake(p, now)).toEqual({ allow: true });
    expect(fs.existsSync(lock)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(p.state, 'wake-budget.json'), 'utf8')).wakes).toEqual([now]);
  });
});
