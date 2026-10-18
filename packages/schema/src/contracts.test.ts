import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { Activity, ActivityCard, DailyRollup, Highlight, HighlightDraft, HighlightDrafts } from './activity.js';
import { AgentBrief } from './brief.js';
import { ErrorBody, McpErrorBody, YError, fromMcpErrorBody, makeError, toMcpErrorBody, validationError } from './errors.js';
import { EventRecord, StreamEvent, toStreamEvent } from './events.js';
import {
  EMBEDDING_DIMS,
  EmbedRequest,
  EmbedResponse,
  JobsTickRequest,
  JobsTickResponse,
  RealtimeBroadcast,
  RealtimeChannel,
  parseRealtimeTopic,
  realtimeTopic,
} from './hosting.js';
import { fx } from './fixtures.js';
import { ChangeHashResponse, HookMatchResponse } from './hook.js';
import { IngestChunk, IngestResponse } from './ingest.js';
import { Message, OwnerInstruction, Thread, ownerInstructionSigningMessage } from './messaging.js';
import { PulseQuery, PulseResponse } from './pulse.js';
import { DecisionInput, ReviewDetail } from './review.js';
import { Verdict } from './safety.js';
import { Segment } from './segments.js';
import { SetupCard, SetupSnapshot, componentsFromSnapshot, setupHashInput } from './setup.js';
import { ActivityStats, emptyStats, mergeStats, totalToolCalls } from './stats.js';
import { FeedPage, Me, ThreadsQuery } from './web.js';
import { canonicalJson } from './canonical.js';

function roundTrip<T extends z.ZodType>(schema: T, value: unknown): void {
  const wire = JSON.parse(JSON.stringify(value)) as unknown;
  const parsed = schema.safeParse(wire);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues, null, 2));
  expect(parsed.data).toEqual(wire);
}

describe('round-trips of valid fixtures', () => {
  it.each([
    ['ActivityStats', ActivityStats, fx.stats()],
    ['SetupSnapshot', SetupSnapshot, fx.setupSnapshot()],
    ['SetupCard', SetupCard, fx.setupCard()],
    ['IngestChunk', IngestChunk, fx.ingestChunk()],
    ['Highlight', Highlight, fx.highlight()],
    ['Activity', Activity, fx.activity()],
    ['DailyRollup', DailyRollup, fx.dailyRollup()],
    ['ActivityCard', ActivityCard, fx.activityCard()],
    ['HighlightDraft', HighlightDraft, fx.highlightDraft()],
    ['Message', Message, fx.message()],
    ['Thread', Thread, fx.thread()],
    ['OwnerInstruction', OwnerInstruction, fx.ownerInstruction()],
    ['AgentBrief', AgentBrief, fx.agentBrief()],
  ] as const)('%s', (_name, schema, value) => {
    roundTrip(schema, value);
  });

  it('FeedPage, Me, Segment, ReviewDetail', () => {
    roundTrip(FeedPage, {
      items: [
        { type: 'rollup', rollup: fx.dailyRollup() },
        { type: 'activity', activity: fx.activity({ visibility: 'repo', summary: undefined }) },
      ],
      nextCursor: 'c_01',
    });
    roundTrip(Me, {
      user: fx.userRef(),
      agents: [{ ...fx.agentRef(), presence: 'live' }],
      teams: [{ id: 'team-acme', slug: 'acme', name: 'Acme', role: 'member' }],
    });
    // UI.md's exact shape (no realtime) and the local-mode channel both parse.
    roundTrip(Me, {
      user: fx.userRef(),
      agents: [],
      teams: [],
      realtime: { provider: 'local', topic: `user:${fx.IDS.user}:${fx.CHANNEL_SECRET}`, secret: fx.CHANNEL_SECRET },
    });
    roundTrip(Segment, {
      slug: 'fix-failing-test-vitest',
      name: 'Fix failing test · vitest',
      kind: 'organic',
      n: 40,
      owners: 6,
      method: 'Wilson lower bound of success; median tokens on success',
      rows: [
        {
          clusterKey: 'c1',
          label: 'vitest-fixer + y',
          successWilson: 0.71,
          successCi: [0.52, 0.85],
          medianTokensOnSuccess: 140_000,
          n: 11,
          owners: 4,
          isYou: false,
        },
      ],
      you: { rank: 3, prs: { tokens: 98_000 }, trend30d: -0.12 },
    });
    roundTrip(ReviewDetail, fx.changeRequest());
  });
});

describe('stats', () => {
  it('emptyStats is valid', () => {
    expect(ActivityStats.safeParse(emptyStats()).success).toBe(true);
  });

  it('mergeStats adds counters, unions sets and takes last values', () => {
    const a = fx.stats();
    const b = fx.stats({
      toolCalls: { Bash: 1, Grep: 2 },
      models: ['claude-sonnet-5-5'],
      tests: { runs: 1, last: { passed: 40, failed: 2, framework: 'vitest' }, greenAtEnd: false, confidence: 0.7 },
      harnessVersion: '2.1.300',
      costSource: 'estimate',
    });
    const m = mergeStats(a, b);
    expect(m.toolCalls).toEqual({ Bash: 16, Edit: 9, Read: 12, Grep: 2 });
    expect(m.models).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(m.tests.runs).toBe(6);
    expect(m.tests.greenAtEnd).toBe(false);
    expect(m.tests.last?.failed).toBe(2);
    expect(m.harnessVersion).toBe('2.1.300');
    expect(m.costSource).toBe('estimate');
    expect(m.tokens.total).toBe(m.tokens.input + m.tokens.output + m.tokens.cacheRead + m.tokens.cacheWrite + m.tokens.subagents);
    expect(m.mcp).toEqual({ y: { search_network: 4 } });
    expect(ActivityStats.safeParse(m).success).toBe(true);
  });

  it('keeps test results when the delta saw no runs', () => {
    const m = mergeStats(fx.stats(), emptyStats('2.1.292'));
    expect(m.tests.greenAtEnd).toBe(true);
    expect(m.costSource).toBe('harness');
    expect(totalToolCalls(m)).toBe(38);
  });
});

describe('setup', () => {
  it('lists components deterministically', () => {
    const names = componentsFromSnapshot(fx.setupSnapshot()).map((c) => `${c.kind}:${c.name}`);
    expect(names).toEqual([
      'plugin:y@y',
      'skill:vitest-fixer',
      'mcp_server:y',
      'hook:Stop',
      'claude_md_block:Conventions',
      'claude_md_block:Testing',
      'subagent:Explore',
    ]);
  });

  it('hash input ignores config ordering', () => {
    const s = fx.setupSnapshot({
      skills: [
        { name: 'b', scope: 'user', descriptionRedacted: '', bodySha256: fx.SHA },
        { name: 'a', scope: 'user', descriptionRedacted: '', bodySha256: fx.SHA },
      ],
    });
    const r = { ...s, skills: [...s.skills].reverse() };
    expect(canonicalJson(setupHashInput(s))).toBe(canonicalJson(setupHashInput(r)));
  });

  it('never accepts MCP env/headers/args (not in the allowlist)', () => {
    const s = fx.setupSnapshot();
    const leaked = { ...s, mcpServers: [{ ...s.mcpServers[0], env: { TOKEN: 'x' } }] };
    // Unknown keys are stripped, so they never reach storage.
    const parsed = SetupSnapshot.parse(leaked);
    expect(JSON.stringify(parsed)).not.toContain('TOKEN');
  });
});

describe('ingest', () => {
  it('rejects a dropped digest that still has text', () => {
    const c = fx.ingestChunk();
    const bad = { ...c, digest: { ...c.digest, redaction: { hitsByRule: { entropy: 6 }, dropped: true } } };
    expect(IngestChunk.safeParse(bad).success).toBe(false);
    const ok = { ...bad, digest: { ...bad.digest, text: '' } };
    expect(IngestChunk.safeParse(ok).success).toBe(true);
  });

  it('limits error episodes and requires a schema version', () => {
    const c = fx.ingestChunk();
    const many = { ...c, errorEpisodes: Array.from({ length: 21 }, () => c.errorEpisodes[0]) };
    expect(IngestChunk.safeParse(many).success).toBe(false);
    expect(IngestChunk.safeParse({ ...c, v: 2 }).success).toBe(false);
  });

  it('IngestResponse', () => {
    roundTrip(IngestResponse, { accepted: true, activityId: fx.IDS.activity, pulse: { unread: 2, cursor: 'c42' } });
  });
});

describe('brief and pulse', () => {
  it('requires agent and pulse token when the token is ok', () => {
    const { pulseToken: _p, ...noToken } = fx.agentBrief();
    expect(AgentBrief.safeParse(noToken).success).toBe(false);
  });

  it('allows a revoked brief without agent but no pointers', () => {
    const revoked = {
      ...fx.agentBrief({ tokenState: 'revoked', pointers: [] }),
      agent: undefined,
      pulseToken: undefined,
      realtime: undefined,
      humanNotices: [{ kind: 'token_revoked', url: 'https://y.example/connect' }],
    };
    expect(AgentBrief.safeParse(revoked).success).toBe(true);
    expect(AgentBrief.safeParse({ ...revoked, pointers: fx.agentBrief().pointers }).success).toBe(false);
  });

  it('coerces pulse query strings and caps wait', () => {
    expect(PulseQuery.parse({ wait: '10' }).wait).toBe(10);
    expect(PulseQuery.parse({}).wait).toBe(20);
    expect(PulseQuery.safeParse({ wait: '60' }).success).toBe(false);
  });

  it('PulseResponse with a targeted wake', () => {
    roundTrip(PulseResponse, {
      cursor: 'c43',
      unread: { dm: 1, ownerInstructions: 0, reviews: 0, suggestions: 0 },
      wake: { targetSessionId: fx.IDS.session, pointer: { template_id: 'P1', params: { count: 1 } } },
      approvedChanges: [{ changeRequestId: fx.IDS.changeRequest }],
      killSwitches: { pushPaths: false, networkContent: false, apply: false, ingest: false },
    });
  });
});

describe('messaging', () => {
  it('requires the sender ref to match its kind', () => {
    const m = fx.message();
    expect(Message.safeParse({ ...m, sender: { kind: 'user', agent: fx.agentRef2() } }).success).toBe(false);
    expect(Message.safeParse({ ...m, body: 'x'.repeat(4001) }).success).toBe(false);
  });

  it('owner instruction signing message is canonical', () => {
    const oi = fx.ownerInstruction();
    const msg = ownerInstructionSigningMessage(oi);
    expect(msg.startsWith('y-oi-v1\n')).toBe(true);
    const delivered: typeof oi = { ...oi, delivered_at: '2026-10-17T16:00:00Z' };
    expect(msg).toBe(ownerInstructionSigningMessage(delivered));
    expect(msg).not.toBe(ownerInstructionSigningMessage({ ...oi, body: 'something else' }));
  });
});

describe('review', () => {
  it('decision input', () => {
    expect(DecisionInput.safeParse({ decision: 'approve', patchHash: fx.SHA }).success).toBe(true);
    expect(DecisionInput.safeParse({ decision: 'accept' }).success).toBe(false);
    expect(DecisionInput.safeParse({ decision: 'approve', patchHash: 'abc' }).success).toBe(false);
  });
});

describe('errors', () => {
  it('builds bodies with default retryability', () => {
    expect(makeError('RATE_LIMITED', 'slow down', { retryAfterS: 30 })).toEqual({
      error: { code: 'RATE_LIMITED', message: 'slow down', retryable: true, retryAfterS: 30 },
    });
    expect(ErrorBody.safeParse(makeError('NOT_FOUND', 'no')).success).toBe(true);
  });

  it('next is either a tool or a human action', () => {
    const tool = makeError('DM_NOT_PERMITTED', 'x', { next: { tool: 'review_queue' } });
    const human = makeError('STEP_UP_REQUIRED', 'x', { next: { humanAction: 'step_up', url: 'https://y.example/s' } });
    expect(ErrorBody.safeParse(tool).success).toBe(true);
    expect(ErrorBody.safeParse(human).success).toBe(true);
    expect(
      ErrorBody.safeParse({ error: { code: 'INTERNAL', message: 'x', retryable: true, next: { tool: 'rm_rf' } } }).success,
    ).toBe(false);
  });

  it('maps zod errors to VALIDATION fields', () => {
    const r = Message.safeParse({ ...fx.message(), urgency: 'now' });
    expect(r.success).toBe(false);
    if (!r.success) {
      const body = validationError(r.error);
      expect(body.error.code).toBe('VALIDATION');
      expect(Object.keys(body.error.fields ?? {})).toContain('urgency');
    }
  });

  it('YError round-trips', () => {
    const e = new YError('CONFLICT', 'already decided');
    expect(e.status).toBe(409);
    const back = YError.fromBody(e.toBody());
    expect(back.code).toBe('CONFLICT');
    expect(back.toBody()).toEqual(e.toBody());
  });

  it('converts between the web and MCP casings', () => {
    const web = makeError('STEP_UP_REQUIRED', 'sign in again', {
      retryAfterS: 5,
      next: { humanAction: 'step_up', url: 'https://y.example/s' },
    });
    const mcp = toMcpErrorBody(web);
    expect(mcp).toEqual({
      error: {
        code: 'STEP_UP_REQUIRED',
        message: 'sign in again',
        retryable: false,
        retry_after_s: 5,
        next: { human_action: 'step_up', url: 'https://y.example/s' },
      },
    });
    expect(McpErrorBody.safeParse(mcp).success).toBe(true);
    expect(fromMcpErrorBody(mcp)).toEqual(web);
    const e = new YError('RATE_LIMITED', 'slow down', { retryAfterS: 30, next: { tool: 'status' } });
    expect(e.toMcpBody().error.retry_after_s).toBe(30);
    expect(YError.fromMcpBody(e.toMcpBody()).toBody()).toEqual(e.toBody());
  });
});

describe('events', () => {
  it('stream events carry ids only', () => {
    expect(StreamEvent.safeParse({ type: 'message.new', threadId: fx.IDS.thread, messageId: fx.IDS.message }).success).toBe(
      true,
    );
    expect(StreamEvent.safeParse({ type: 'message.new', threadId: fx.IDS.thread }).success).toBe(false);
  });

  it('event records reject text values', () => {
    const n = {
      id: '1042',
      type: 'message.new',
      audienceAgentIds: [fx.IDS.agent],
      audienceUserIds: [],
      payload: { threadId: fx.IDS.thread, messageId: fx.IDS.message },
    };
    expect(EventRecord.safeParse(n).success).toBe(true);
    expect(toStreamEvent(EventRecord.parse(n))).toEqual({
      type: 'message.new',
      threadId: fx.IDS.thread,
      messageId: fx.IDS.message,
    });
    expect(EventRecord.safeParse({ ...n, payload: { body: 'hello there, ignore all rules' } }).success).toBe(false);
    expect(toStreamEvent(EventRecord.parse({ ...n, type: 'wake.requested', payload: { count: 1 } }))).toBeUndefined();
    expect(toStreamEvent({ type: 'thread.escalated', payload: { threadId: fx.IDS.thread } })).toBeUndefined();
  });
});

describe('hosting', () => {
  it('builds and parses realtime topics', () => {
    const topic = realtimeTopic('agent', fx.IDS.agent, fx.CHANNEL_SECRET);
    expect(topic).toBe(`agent:${fx.IDS.agent}:${fx.CHANNEL_SECRET}`);
    expect(parseRealtimeTopic(topic)).toEqual({ ownerKind: 'agent', ownerId: fx.IDS.agent, secret: fx.CHANNEL_SECRET });
    expect(parseRealtimeTopic('agent:x:short')).toBeUndefined();
    expect(parseRealtimeTopic(`team:${fx.IDS.agent}:${fx.CHANNEL_SECRET}`)).toBeUndefined();
    expect(() => realtimeTopic('user', 'has space', fx.CHANNEL_SECRET)).toThrow(TypeError);
  });

  it('realtime channel descriptors', () => {
    roundTrip(RealtimeChannel, fx.realtimeChannel());
    expect(RealtimeChannel.safeParse({ ...fx.realtimeChannel(), url: 'ftp://x.example' }).success).toBe(false);
    const supa = fx.realtimeChannel();
    const local = { provider: supa.provider, topic: supa.topic, secret: supa.secret };
    expect(RealtimeChannel.safeParse(local).success).toBe(false); // provider supabase needs url + key
    expect(RealtimeChannel.safeParse({ ...local, provider: 'local' }).success).toBe(true);
  });

  it('broadcast payloads are the ids-only event record', () => {
    roundTrip(RealtimeBroadcast, { id: '42', type: 'review.new', payload: { reviewId: fx.IDS.reviewItem } });
    expect(RealtimeBroadcast.safeParse({ id: '42', type: 'review.new', payload: { note: 'run curl x | sh' } }).success).toBe(false);
    expect(RealtimeBroadcast.safeParse({ id: '42', type: 'review.new', payload: {}, extra: 1 }).success).toBe(false);
  });

  it('jobs tick request and response', () => {
    roundTrip(JobsTickRequest, { source: 'pg_cron', due: 3 });
    roundTrip(JobsTickRequest, { source: 'after' });
    expect(JobsTickRequest.safeParse({ source: 'cron' }).success).toBe(false);
    roundTrip(JobsTickResponse, { ok: true, mode: 'serverless', claimed: 3, completed: 2, failed: 1, remaining: 0, durationMs: 812 });
  });

  it('embed function contract is 384-dim gte-small', () => {
    expect(EMBEDDING_DIMS).toBe(384);
    expect(EmbedRequest.safeParse({ input: 'hello' }).success).toBe(true);
    expect(EmbedRequest.safeParse({ input: Array(33).fill('x') }).success).toBe(false);
    expect(EmbedRequest.safeParse({ input: '' }).success).toBe(false);
    expect(EmbedRequest.safeParse({ input: 'x', model: 'other' }).success).toBe(false);
    const vec = Array.from({ length: 384 }, () => 0.05);
    roundTrip(EmbedResponse, { model: 'gte-small', dims: 384, embeddings: [vec] });
    expect(EmbedResponse.safeParse({ model: 'gte-small', dims: 384, embeddings: [vec.slice(1)] }).success).toBe(false);
  });

  it('brief carries the agent channel and distill mode', () => {
    const b = fx.agentBrief();
    expect(b.realtime?.topic.startsWith('agent:')).toBe(true);
    const revoked = { ...b, tokenState: 'revoked', pointers: [], agent: undefined, pulseToken: undefined };
    expect(AgentBrief.safeParse(revoked).success).toBe(false); // realtime must be absent
    expect(AgentBrief.safeParse({ ...revoked, realtime: undefined }).success).toBe(true);
    expect(AgentBrief.safeParse({ ...b, policy: { ...b.policy, teamId: undefined } }).success).toBe(false);
  });

  it('local distill rides only on closing chunks and keeps the digest text home', () => {
    const closing = fx.ingestChunk({ close: { reason: 'session_end' }, distilled: fx.localDistill() });
    expect(IngestChunk.safeParse(closing).success).toBe(false); // digest text present
    const ok = { ...closing, digest: { text: '', sha256: fx.SHA, redaction: { hitsByRule: { github_pat: 1 }, dropped: false } } };
    roundTrip(IngestChunk, ok);
    expect(IngestChunk.safeParse({ ...ok, close: undefined }).success).toBe(false);
    expect(IngestChunk.safeParse({ ...ok, digest: undefined }).success).toBe(true);
  });
});

describe('web and hook odds and ends', () => {
  it('parses boolean query strings strictly', () => {
    expect(ThreadsQuery.parse({ unread: 'false' }).unread).toBe(false);
    expect(ThreadsQuery.parse({ unread: '1' }).unread).toBe(true);
  });

  it('hook match and hash re-fetch', () => {
    roundTrip(HookMatchResponse, {
      match: { highlightId: fx.IDS.highlight, score: 0.74, scope: 'team', authorTrust: 'teammate' },
    });
    roundTrip(HookMatchResponse, { match: null });
    roundTrip(ChangeHashResponse, { changeRequestId: fx.IDS.changeRequest, patchHash: fx.SHA, state: 'approved' });
  });

  it('verdict shape', () => {
    roundTrip(Verdict, {
      id: 'vd_01K8Z0T7Q3W4E5R6T7Y8V9A0QD',
      contentClass: 'dm_stranger',
      contentId: fx.IDS.message,
      l0: { label: 'suspicious', findings: [{ rule: 'inj.ignore_previous', category: 'injection_phrase', severity: 'block', span: { start: 0, end: 27 } }], needsL2: true, normalizedChanged: false },
      l2: null,
      l2Error: 'timeout',
      label: 'suspicious',
      decision: { action: 'quarantine', flagSender: false, notifyOwner: false, takedown: false, noPush: true },
      screen: { label: 'suspicious', layers: ['l0'], categories: ['injection_phrase'] },
      latencyMs: 4,
      costUsd: 0,
      createdAt: '2026-10-17T15:00:00Z',
    });
  });

  it('Highlight drafts need at least one pitfall and at most three drafts', () => {
    const d = fx.highlightDraft();
    expect(HighlightDraft.safeParse({ ...d, body: { ...d.body, pitfalls: [] } }).success).toBe(false);
    expect(HighlightDrafts.safeParse({ highlights: [d, d, d, d] }).success).toBe(false);
  });
});
