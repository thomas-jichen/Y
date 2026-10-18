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
import { BUSY_POLLS_FREE, listen, MIN_BUSY_POLL_MS, MIN_IDLE_POLL_MS, MIN_RING_POLL_MS } from '../src/listener.js';
import { listChunks, outboxBytes, writeChunk } from '../src/outbox.js';
import { gitConfigPath, gitIdentities, gitIdentity, gitRemote, identityTerms, nameTerms, parseGitUser, redactText } from '../src/redaction.js';
import { allocSeq, isInsecureUrl, loadConfig, paths } from '../src/runtime.js';
import { killSwitchesFile, readBrief } from '../src/state.js';
import { drainOutbox, MAX_NETWORK_ATTEMPTS, MAX_NETWORK_ERRORS_PER_RUN, MAX_REDRIVES, REDRIVE_AFTER_MS } from '../src/uploader.js';
import { takeWake, WAKE_LOCK_SPIN_MS, WAKE_LOCK_STALE_MS } from '../src/wake-budget.js';
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
  it("local owner-only stricter than core's setting: a DM wake is parked for the next prompt", async () => {
    writeBriefCache(brief([])); // core's agent_settings.wake_on_dm = teammates
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

  it("when core applies owner-only itself, its DM wakes (the owner's own agents) still wake the session", async () => {
    const b = brief([]);
    writeBriefCache({ ...b, policy: { ...(b.policy as object), wakeOnDm: 'owner-only' } });
    core.route = () => ({ body: pulseBody({ wake: { targetSessionId: SID, pointer: { template_id: 'P1', params: { count: 1, handle: '@me-laptop' } } } }) });
    const r = await listen(listenCtx({ CLAUDE_PLUGIN_OPTION_WAKE_ON_DM: 'owner-only' }), { runMs: 10_000, sleep: async () => {} });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('@me-laptop');
    expect(fs.existsSync(stateFile(`pending-wake-${SID}.json`))).toBe(false);
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

describe('#63 timeouts, dropped connections and 5xx outages (review)', () => {
  const ok = () => ({ body: { accepted: true, pulse: { unread: 0, cursor: 'cur_1' } } });

  it('a head chunk that always times out is dead-lettered after a cap, and the chunks behind it drain', async () => {
    await run('SessionEnd', { session_id: SID });
    await run('SessionEnd', { session_id: 'sess-behind-2' });
    core.route = ok;
    const config = loadConfig(testEnv(dir, core.url));
    let timeouts = 0;
    const choking = (async (url: string, init: RequestInit) => {
      if ((JSON.parse(String(init.body)) as { sessionId: string }).sessionId === SID) {
        timeouts++;
        throw new DOMException('This operation was aborted', 'AbortError');
      }
      return fetch(url, init);
    }) as unknown as typeof fetch;
    let sent = 0;
    for (let i = 0; i < 10 && sent === 0; i++) sent += (await drainOutbox({ config, paths: paths(dir), fetch: choking, backoffMs: 1, sleep: async () => {} })).sent;
    expect(timeouts).toBe(MAX_NETWORK_ATTEMPTS);
    expect(sent).toBe(1);
    expect(fs.readdirSync(paths(dir).dead)).toHaveLength(1);
    expect(listChunks(paths(dir))).toEqual([]);
  });

  it('connection refused (offline) still never counts', async () => {
    await run('SessionEnd', { session_id: SID });
    const config = loadConfig(testEnv(dir, core.url));
    const refused = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }) as unknown as typeof fetch;
    for (let i = 0; i < 5; i++) await drainOutbox({ config, paths: paths(dir), fetch: refused, backoffMs: 1, sleep: async () => {} });
    expect(listChunks(paths(dir))).toHaveLength(1);
    expect(fs.existsSync(paths(dir).dead)).toBe(false);
  });

  it('a chunk dead-lettered by a core outage (5xx) is re-driven once the outage had time to end', async () => {
    await run('SessionEnd', { session_id: SID });
    const config = loadConfig(testEnv(dir, core.url));
    const t0 = Date.now();
    core.route = () => ({ status: 503, body: { error: { code: 'UNAVAILABLE', message: 'down', retryable: true } } });
    expect(await drainOutbox({ config, paths: paths(dir), fetch, backoffMs: 1, sleep: async () => {}, now: () => t0 })).toMatchObject({ dead: 1 });
    // Too soon: stays dead.
    core.route = ok;
    expect(await drainOutbox({ config, paths: paths(dir), fetch, sleep: async () => {}, now: () => t0 + 60_000 })).toMatchObject({ sent: 0 });
    expect(fs.readdirSync(paths(dir).dead)).toHaveLength(1);
    // After the cool-down it goes out.
    expect(await drainOutbox({ config, paths: paths(dir), fetch, sleep: async () => {}, now: () => t0 + REDRIVE_AFTER_MS + 1 })).toMatchObject({ sent: 1, dead: 0, remaining: 0 });
    expect(fs.readdirSync(paths(dir).dead)).toEqual([]);
  });

  it(`re-drives at most ${MAX_REDRIVES} times, and never a chunk core rejected (4xx)`, async () => {
    await run('SessionEnd', { session_id: SID });
    const config = loadConfig(testEnv(dir, core.url));
    let t = Date.now();
    core.route = () => ({ status: 503, body: { error: { code: 'UNAVAILABLE', message: 'down', retryable: true } } });
    for (let i = 0; i <= MAX_REDRIVES + 1; i++) {
      await drainOutbox({ config, paths: paths(dir), fetch, backoffMs: 1, sleep: async () => {}, now: () => t });
      t += REDRIVE_AFTER_MS + 1;
    }
    expect(core.requests).toHaveLength(10 * (MAX_REDRIVES + 1));
    expect(fs.readdirSync(paths(dir).dead)).toHaveLength(1);

    fs.rmSync(path.join(dir, 'outbox'), { recursive: true, force: true });
    core.requests.length = 0;
    await run('SessionEnd', { session_id: 'sess-bad-2' });
    core.route = () => ({ status: 422, body: { error: { code: 'VALIDATION', message: 'bad', retryable: false } } });
    await drainOutbox({ config, paths: paths(dir), fetch, backoffMs: 1, sleep: async () => {}, now: () => t });
    core.route = ok;
    await drainOutbox({ config, paths: paths(dir), fetch, sleep: async () => {}, now: () => t + REDRIVE_AFTER_MS * 10 });
    expect(core.requests).toHaveLength(10);
    expect(fs.readdirSync(paths(dir).dead)).toHaveLength(1);
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

describe('#64 kill switches without a lost brief update (review)', () => {
  it('the listener records switches in their own file; brief.json (pulse token, policy) is left as SessionStart wrote it', async () => {
    const b = brief([], { pulseToken: { token: 'pt_fresh_session_start_token_0001', expiresAt: new Date(Date.now() + 3600_000).toISOString() } });
    writeBriefCache(b);
    const before = fs.readFileSync(stateFile('brief.json'), 'utf8');
    core.route = () => ({ body: pulseBody({ killSwitches: { ...NO_KS, pushPaths: true } }) });
    await listen(listenCtx(), { runMs: 3_500, sleep: async () => {} });
    expect(fs.readFileSync(stateFile('brief.json'), 'utf8')).toBe(before);
    expect(readBrief(paths(dir))?.killSwitches.pushPaths).toBe(true);
    expect(readBrief(paths(dir))?.pulseToken?.token).toBe('pt_fresh_session_start_token_0001');
    // A brief fetched after that pulse (SessionStart) wins over the older switches.
    const later = JSON.parse(fs.readFileSync(killSwitchesFile(paths(dir)), 'utf8')).at + 1;
    fs.writeFileSync(stateFile('brief.json'), JSON.stringify({ ...b, fetchedAt: later }));
    expect(readBrief(paths(dir))?.killSwitches).toEqual(NO_KS);
  });

  it('with no listener (wake_on_dm=off, headless), the uploader refreshes stale switches from the brief and holds chunks', async () => {
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(stateFile('brief.json'), JSON.stringify({ ...brief([]), fetchedAt: Date.now() - 5 * 60_000 }));
    await run('SessionEnd', { session_id: SID });
    core.route = (req) => (req.url.startsWith('/api/v1/agent/brief') ? { body: brief([], { killSwitches: { ...NO_KS, ingest: true } }) } : { body: { accepted: true, pulse: { unread: 0, cursor: 'c' } } });
    const s = await drainOutbox({ config: loadConfig(testEnv(dir, core.url)), paths: paths(dir), fetch, sleep: async () => {} });
    expect(s).toMatchObject({ sent: 0, remaining: 1 });
    expect(core.requests.map((r) => r.url.split('?')[0])).toEqual(['/api/v1/agent/brief']);
    expect(readBrief(paths(dir))?.killSwitches.ingest).toBe(true);
    // Fresh switches: no second brief fetch.
    await drainOutbox({ config: loadConfig(testEnv(dir, core.url)), paths: paths(dir), fetch, sleep: async () => {} });
    expect(core.requests).toHaveLength(1);
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

describe('#103 a snapshot core rejects (review)', () => {
  it('a 4xx for a chunk carrying a snapshot drops the snapshot from it and later Stops send the hash only', async () => {
    writeBriefCache(brief([]));
    const proj = fs.mkdtempSync(path.join(dir, 'proj-'));
    const transcript = path.join(dir, 't.jsonl');
    const line = (i: number) => `${JSON.stringify({ type: 'user', uuid: `u${i}`, sessionId: SID, version: '2.1.300', timestamp: '2026-10-17T10:00:00.000Z', isSidechain: false, message: { role: 'user', content: `prompt ${i}` } })}\n`;
    fs.writeFileSync(transcript, line(1));
    await run('Stop', { session_id: SID, transcript_path: transcript, cwd: proj });
    core.route = (req) =>
      (req.body as { setup?: { snapshot?: unknown } }).setup?.snapshot
        ? { status: 413, body: { error: { code: 'VALIDATION', message: 'too large', retryable: false } } }
        : { body: { accepted: true, pulse: { unread: 0, cursor: 'cur_1' } } };
    const s = await drainOutbox({ config: loadConfig(testEnv(dir, core.url)), paths: paths(dir), fetch, backoffMs: 1, sleep: async () => {} });
    expect(s).toMatchObject({ sent: 1, dead: 0 });
    expect(core.requests).toHaveLength(2);
    const hash = (core.requests[1]!.body as { setup: { hash: string } }).setup.hash;
    expect((core.requests[1]!.body as { setup: unknown }).setup).toEqual({ hash });
    expect(JSON.parse(fs.readFileSync(stateFile('setup-sent.json'), 'utf8'))).toEqual({ hash, rejected: true });
    fs.appendFileSync(transcript, line(2));
    await run('Stop', { session_id: SID, transcript_path: transcript, cwd: proj });
    expect(IngestChunk.parse(JSON.parse(fs.readFileSync(listChunks(paths(dir))[0]!, 'utf8'))).setup).toEqual({ hash });
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

  it('a short burst of polls that move the cursor is not delayed; a sustained one gets a short floor', async () => {
    let n = 0;
    // Five polls with new events each, then nothing new.
    core.route = () => ({ body: pulseBody({ cursor: `cur_${Math.min(5, ++n)}`, unread: { dm: 0, ownerInstructions: 0, reviews: 0, suggestions: 0 } }) });
    const sleeps: { at: number; ms: number }[] = [];
    await listen(listenCtx(), { runMs: 10_000, sleep: async (ms) => void sleeps.push({ at: core.requests.length, ms }) });
    expect(sleeps[0]).toEqual({ at: BUSY_POLLS_FREE + 1, ms: MIN_BUSY_POLL_MS });
  });

  it('a core that answers instantly with a new cursor every time is paced, not hammered', async () => {
    let n = 0;
    core.route = () => ({ body: pulseBody({ cursor: `cur_${++n}`, unread: { dm: 0, ownerInstructions: 0, reviews: 0, suggestions: 0 } }) });
    let t = Date.now();
    const ctx = makeCtx('Stop', JSON.stringify({ session_id: SID }), { env: testEnv(dir, core.url), now: () => t });
    await listen(ctx, { runMs: 120_000, sleep: async (ms) => void (t += ms) });
    // 2 minutes: a few free polls, a ramp, then one per 5 s at most.
    expect(core.requests.length).toBeGreaterThan(BUSY_POLLS_FREE);
    expect(core.requests.length).toBeLessThan(40);
  });
});

describe('#104 doorbell ring pacing (review)', () => {
  class RingWs {
    static last: RingWs | undefined;
    readyState = 0;
    onopen?: () => void;
    onmessage?: (e: { data: unknown }) => void;
    onclose?: () => void;
    onerror?: () => void;
    constructor(readonly url: string) {
      RingWs.last = this;
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.();
      }, 0);
    }
    send(d: string) {
      const m = JSON.parse(d) as { event: string; topic: string; ref: string };
      if (m.event === 'phx_join') setTimeout(() => this.onmessage?.({ data: JSON.stringify({ topic: m.topic, event: 'phx_reply', payload: { status: 'ok' }, ref: m.ref }) }), 0);
    }
    close() {
      this.readyState = 3;
    }
  }
  const ch = {
    provider: 'supabase',
    url: 'https://abcdefghijklmnop.supabase.co',
    apiKey: 'sb_publishable_abcdefghijklmnopqrstuvwxyz',
    topic: `agent:00000000-0000-4000-8000-000000000001:${'a1'.repeat(32)}`,
    secret: 'a1'.repeat(32),
  };

  it('a flood of rings is spaced: at least MIN_RING_POLL_MS between ring-triggered polls, doubling', async () => {
    writeBriefCache(brief([], { realtime: ch }));
    expect(readBrief(paths(dir))?.realtime).toBeDefined();
    const flood = setInterval(
      () => RingWs.last?.onmessage?.({ data: JSON.stringify({ topic: `realtime:${ch.topic}`, event: 'broadcast', payload: { type: 'broadcast', event: 'message.new', payload: { id: '5' } }, ref: null }) }),
      2,
    );
    core.route = () => ({ body: pulseBody({ unread: { dm: 0, ownerInstructions: 0, reviews: 0, suggestions: 0 } }) });
    const gaps: number[] = [];
    let t = Date.now();
    const ctx = makeCtx('Stop', JSON.stringify({ session_id: SID }), { env: testEnv(dir, core.url), now: () => t });
    try {
      await listen(ctx, {
        runMs: 120_000,
        webSocket: RingWs as never,
        safetyPollMs: 600_000,
        sleep: async (ms) => {
          gaps.push(ms);
          t += ms;
          await new Promise((r) => setTimeout(r, 1));
        },
      });
    } finally {
      clearInterval(flood);
    }
    // Two minutes of rings every 2 ms: a handful of polls, not tens of thousands.
    expect(gaps.length).toBeGreaterThan(1);
    expect(gaps[0]).toBeGreaterThan(MIN_RING_POLL_MS - 100);
    expect(gaps[1]).toBeGreaterThan(gaps[0]!);
    expect(core.requests.length).toBeLessThanOrEqual(gaps.length + 1);
    expect(core.requests.length).toBeLessThan(10);
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

describe('#106 git identity: common words, worktrees, includes, comments (review)', () => {
  it("a name part that is an ordinary word isn't a term on its own; the full name is", () => {
    expect(nameTerms('Will Grant')).toEqual(['Will Grant']);
    expect(nameTerms('Max Okonkwo-Reyes')).toEqual(['Max Okonkwo-Reyes', 'Okonkwo-Reyes']);
    expect(nameTerms('Mark')).toEqual([]);
    const repo = fs.mkdtempSync(path.join(dir, 'repo-'));
    fs.mkdirSync(path.join(repo, '.git'));
    fs.writeFileSync(path.join(repo, '.git', 'config'), '[user]\n\tname = Will Grant\n');
    const r = redactText('the agent will run Math.max and grant access; Will Grant approved', repo);
    expect(r.text).toContain('the agent will run Math.max and grant access');
    expect(r.text).not.toContain('Will Grant');
  });

  it('strips inline comments, reads the XDG config and one level of includes', () => {
    expect(parseGitUser('[user]\n  name = Ines Varga # work laptop\n  email = iv@example.org ; old\n')).toEqual({ name: 'Ines Varga', email: 'iv@example.org' });
    expect(parseGitUser('[user]\n  name = "Ana # Lima"\n')).toEqual({ name: 'Ana # Lima' });
    const home = fs.mkdtempSync(path.join(dir, 'home-'));
    fs.mkdirSync(path.join(home, '.config', 'git'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'git', 'config'), '[user]\n  name = Xavi Dellamonte\n');
    expect(gitIdentity(undefined, home)).toEqual({ name: 'Xavi Dellamonte' });
    fs.writeFileSync(path.join(home, 'personal.inc'), '[user]\n  name = Petra Lindqvist\n');
    fs.writeFileSync(path.join(home, 'work.inc'), '[user]\n  name = Petra Lindqvist-Work\n  email = pl@work.example\n');
    fs.writeFileSync(path.join(home, '.gitconfig'), '[include]\n  path = ~/personal.inc\n[includeIf "gitdir:~/work/"]\n  path = work.inc\n');
    expect(gitIdentity(undefined, home)).toEqual({ name: 'Petra Lindqvist' });
    expect(gitIdentities(undefined, home).names).toEqual(expect.arrayContaining(['Xavi Dellamonte', 'Petra Lindqvist', 'Petra Lindqvist-Work']));
  });

  it('a worktree (.git file) resolves to the main repo config, and the walk stops at the first .git', () => {
    const main = fs.mkdtempSync(path.join(dir, 'main-'));
    fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.writeFileSync(path.join(main, '.git', 'config'), '[user]\n  name = Quentin Abernathy\n[remote "origin"]\n  url = git@github.com:acme-rt/widgets.git\n');
    fs.writeFileSync(path.join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    // The worktree lives inside an unrelated parent repo: its config must not be used.
    const parent = fs.mkdtempSync(path.join(dir, 'parent-'));
    fs.mkdirSync(path.join(parent, '.git'));
    fs.writeFileSync(path.join(parent, '.git', 'config'), '[user]\n  name = Wrong Parentrepo\n');
    const wt = path.join(parent, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
    expect(gitConfigPath(wt)).toBe(path.join(main, '.git', 'config'));
    expect(gitIdentity(wt, dir)).toEqual({ name: 'Quentin Abernathy' });
    expect(gitRemote(wt)).toBe('git@github.com:acme-rt/widgets.git');
  });
});

describe('#107 cleartext api_url', () => {
  it('withholds the token for plain http to another host; loopback and https are unchanged', () => {
    const base = { CLAUDE_PLUGIN_OPTION_AGENT_TOKEN: 'tok_test_install_0000000000', Y_DATA_DIR: dir };
    expect(loadConfig({ ...base, CLAUDE_PLUGIN_OPTION_API_URL: 'http://y.example.com' })).toMatchObject({ token: 'tok_test_install_0000000000', insecureApiUrl: true });
    for (const url of ['https://y.example.com', 'http://localhost:8787', 'http://127.0.0.1:9', 'http://[::1]:8787', 'http://core.localhost']) {
      const c = loadConfig({ ...base, CLAUDE_PLUGIN_OPTION_API_URL: url });
      expect(c.token, url).toBe('tok_test_install_0000000000');
      expect(c.insecureApiUrl, url).toBeUndefined();
    }
    expect(loadConfig({ ...base }).token).toBe('tok_test_install_0000000000'); // default http://localhost:8787
    expect(loadConfig({ ...base, CLAUDE_PLUGIN_OPTION_API_URL: 'http://devbox.lan:8787', Y_ALLOW_INSECURE_URL: '1' }).token).toBe('tok_test_install_0000000000');
    expect(isInsecureUrl('http://10.0.0.5:8787')).toBe(true);
  });

  it('SessionStart warns about a plain-http mcp_url (the MCP client sends the token there itself)', async () => {
    core.route = () => ({ body: brief([]) });
    const r = await run('SessionStart', { session_id: SID }, { CLAUDE_PLUGIN_OPTION_MCP_URL: 'http://y.example.com/mcp' });
    expect(JSON.parse(r.stdout!).systemMessage).toContain('Y: mcp_url is plain http://');
    for (const ok of ['https://y.example.com/mcp', 'http://localhost:3000/mcp']) {
      const r2 = await run('SessionStart', { session_id: SID }, { CLAUDE_PLUGIN_OPTION_MCP_URL: ok });
      expect(r2.stdout ? (JSON.parse(r2.stdout).systemMessage ?? '') : '').not.toContain('mcp_url');
    }
  });

  it('SessionStart sends nothing and tells the human why', async () => {
    const r = await run('SessionStart', { session_id: SID }, { CLAUDE_PLUGIN_OPTION_API_URL: 'http://y.example.com' });
    expect(JSON.parse(r.stdout!).systemMessage).toMatch(/^Y: api_url is plain http:\/\//);
    expect(core.requests).toHaveLength(0);
  });
});

describe('#108 wake budget lock', () => {
  it('a concurrent holder makes takeWake return busy (after a short spin) without recording; a stale lock is broken', () => {
    const p = paths(dir);
    const lock = path.join(p.state, 'wake-budget.lock');
    fs.mkdirSync(lock, { recursive: true });
    const now = 1_800_000_000_000;
    const t0 = Date.now();
    expect(takeWake(p, now)).toEqual({ allow: false, reason: 'busy' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(WAKE_LOCK_SPIN_MS - 20);
    expect(fs.existsSync(path.join(p.state, 'wake-budget.json'))).toBe(false);
    const old = (Date.now() - WAKE_LOCK_STALE_MS - 1_000) / 1000;
    fs.utimesSync(lock, old, old);
    expect(takeWake(p, now)).toEqual({ allow: true });
    expect(fs.existsSync(lock)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(p.state, 'wake-budget.json'), 'utf8')).wakes).toEqual([now]);
  });

  it('busy is not a budget verdict: the listener parks the pointer and keeps listening', async () => {
    fs.mkdirSync(path.join(dir, 'state', 'wake-budget.lock'), { recursive: true });
    core.route = () => ({ body: pulseBody({ wake: dmWake }) });
    const r = await listen(listenCtx(), { runMs: 3_500, sleep: async () => {} });
    expect(r).toEqual({ exitCode: 0 });
    expect(core.requests.length).toBeGreaterThan(1); // it polled again after the busy verdict
    expect(fs.existsSync(stateFile(`pending-wake-${SID}.json`))).toBe(true);
  });
});
