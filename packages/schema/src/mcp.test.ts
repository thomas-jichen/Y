import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOOL_NAMES } from './common.js';
import { fx } from './fixtures.js';
import {
  INTERNAL_SIGNATURE_MAX_SKEW_S,
  TOOLS,
  formatInternalSignatureHeader,
  internalMcpPath,
  internalMcpRequestSchema,
  internalMcpResponseSchema,
  internalSigningString,
  parseInternalSignatureHeader,
} from './internal.js';
import {
  AskBuilderInput,
  FindBuilderInput,
  GetItemOutput,
  InboxInput,
  InboxOutput,
  PostActivityInput,
  ReportOutcomeInput,
  ScrollFeedInput,
  SearchNetworkInput,
  SendMessageInput,
  StatusOutput,
  TAINTING_TOOLS,
  TOOL_POLICY,
  ThreadAction,
  UpdateThreadInput,
  WhatsHappeningInput,
} from './mcp.js';
import { ActivityEnvelope, buildEnvelope } from './envelope.js';
import { OWNER_INSTRUCTION_NOTE } from './messaging.js';

describe('tool registry', () => {
  it('has input and output schemas and a policy for every tool', () => {
    expect(Object.keys(TOOLS)).toEqual([...TOOL_NAMES]);
    expect(Object.keys(TOOL_POLICY).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('every input accepts its minimal valid form', () => {
    const minimal: Record<string, unknown> = {
      status: {},
      search_network: { query: 'quarry migrate hangs' },
      get_item: { id: fx.IDS.highlight },
      scroll_feed: {},
      compare_setups: {},
      propose_setup_change: { suggestionId: fx.IDS.suggestion, target: 'user' },
      report_outcome: { itemId: fx.IDS.highlight, outcome: 'helped' },
      post_activity: { title: 'Fixed the flaky test', summary: '', taskIntent: 'fix_failing_test', outcome: 'green' },
      send_message: { to: '@maya-codex', body: 'hi', intent: 'fyi', idempotencyKey: 'k-12345678' },
      inbox: {},
      update_thread: { threadId: fx.IDS.thread, action: 'resolve' },
      find_builder: { package: 'acme-pay-sdk' },
      ask_builder: { product: 'acme-pay', question: 'Why does the webhook signature fail?', idempotencyKey: 'k-12345678' },
      review_queue: {},
      whats_happening: {},
    };
    for (const tool of TOOL_NAMES) {
      const r = TOOLS[tool].input.safeParse(minimal[tool]);
      expect(r.success, tool).toBe(true);
    }
  });

  it('marks exactly the PLAN §6 read tools (plus whats_happening) as tainting', () => {
    expect([...TAINTING_TOOLS].sort()).toEqual(
      ['ask_builder', 'compare_setups', 'find_builder', 'get_item', 'inbox', 'scroll_feed', 'search_network', 'whats_happening'].sort(),
    );
  });

  it('every output schema is a JSON object schema (MCP requirement)', () => {
    for (const tool of TOOL_NAMES) {
      const js = z.toJSONSchema(TOOLS[tool].output, { io: 'output', unrepresentable: 'any' }) as { type?: string };
      expect(js.type, tool).toBe('object');
      const ji = z.toJSONSchema(TOOLS[tool].input, { io: 'input', unrepresentable: 'any' }) as { type?: string };
      expect(ji.type, tool).toBe('object');
    }
  });

  it('marks requiresUserInteraction and alwaysLoad per PLAN §12', () => {
    expect(TOOL_POLICY.propose_setup_change.requiresUserInteraction).toBe('always');
    expect(TOOL_POLICY.ask_builder.requiresUserInteraction).toBe('always');
    expect(TOOL_POLICY.send_message.requiresUserInteraction).toBe('cross_owner');
    const always = TOOL_NAMES.filter((t) => TOOL_POLICY[t].alwaysLoad);
    expect(always).toEqual(['status', 'search_network', 'inbox']);
    const noauth = TOOL_NAMES.filter((t) => TOOL_POLICY[t].auth === 'optional');
    expect(noauth).toEqual(['status', 'search_network', 'get_item', 'compare_setups', 'find_builder']);
  });
});

describe('input limits', () => {
  it('search_network: limit ≤ 8, query 3..500, defaults applied', () => {
    expect(SearchNetworkInput.parse({ query: 'abc' })).toEqual({ query: 'abc', scope: 'all', limit: 5 });
    expect(SearchNetworkInput.safeParse({ query: 'abc', limit: 9 }).success).toBe(false);
    expect(SearchNetworkInput.safeParse({ query: 'ab' }).success).toBe(false);
    expect(SearchNetworkInput.safeParse({ query: 'a'.repeat(501) }).success).toBe(false);
    expect(SearchNetworkInput.safeParse({ query: 'abc', error: 'e'.repeat(801) }).success).toBe(false);
  });

  it('scroll_feed: limit ≤ 10', () => {
    expect(ScrollFeedInput.safeParse({ limit: 11 }).success).toBe(false);
  });

  it('inbox: limit ≤ 20, unreadOnly defaults to true', () => {
    expect(InboxInput.parse({})).toEqual({ unreadOnly: true, limit: 10 });
    expect(InboxInput.safeParse({ limit: 21 }).success).toBe(false);
  });

  it('send_message: body ≤ 4000, needs to or anchor, idempotency key, valid claims', () => {
    const base = { to: '@maya-codex', body: 'hi', intent: 'claim', idempotencyKey: 'k-12345678' };
    expect(SendMessageInput.parse(base).urgency).toBe('normal');
    expect(SendMessageInput.safeParse({ ...base, body: 'x'.repeat(4001) }).success).toBe(false);
    expect(SendMessageInput.safeParse({ ...base, body: '' }).success).toBe(false);
    expect(SendMessageInput.safeParse({ ...base, to: undefined }).success).toBe(false);
    expect(SendMessageInput.safeParse({ ...base, to: undefined, anchor: { kind: 'highlight', id: fx.IDS.highlight } }).success).toBe(
      true,
    );
    expect(SendMessageInput.safeParse({ ...base, idempotencyKey: 'short' }).success).toBe(false);
    expect(SendMessageInput.safeParse({ ...base, to: 'maya' }).success).toBe(false);
    expect(
      SendMessageInput.safeParse({ ...base, claims: [{ areaGlob: 'migrations/**', untilMinutes: 60 }] }).success,
    ).toBe(true);
    expect(SendMessageInput.safeParse({ ...base, claims: [{ areaGlob: 'a b; rm', untilMinutes: 60 }] }).success).toBe(false);
  });

  it('ask_builder: question ≤ 1000', () => {
    const base = { product: fx.IDS.product, question: 'q', idempotencyKey: 'k-12345678' };
    expect(AskBuilderInput.safeParse(base).success).toBe(true);
    expect(AskBuilderInput.safeParse({ ...base, question: 'q'.repeat(1001) }).success).toBe(false);
  });

  it('update_thread: no accept/decline; assign needs assignTo', () => {
    expect(ThreadAction.options).not.toContain('accept');
    expect(ThreadAction.options).not.toContain('decline');
    expect(UpdateThreadInput.safeParse({ threadId: fx.IDS.thread, action: 'accept' }).success).toBe(false);
    expect(UpdateThreadInput.safeParse({ threadId: fx.IDS.thread, action: 'decline' }).success).toBe(false);
    expect(UpdateThreadInput.safeParse({ threadId: fx.IDS.thread, action: 'assign' }).success).toBe(false);
    expect(UpdateThreadInput.safeParse({ threadId: fx.IDS.thread, action: 'assign', assignTo: '@maya-codex' }).success).toBe(
      true,
    );
  });

  it('post_activity: visibility at most team', () => {
    const base = { title: 'Fixed the flaky test', summary: 's', taskIntent: 'fix_failing_test', outcome: 'green' };
    expect(PostActivityInput.parse(base).visibility).toBe('private');
    expect(PostActivityInput.safeParse({ ...base, visibility: 'public' }).success).toBe(false);
    expect(PostActivityInput.safeParse({ ...base, taskIntent: 'world_domination' }).success).toBe(false);
  });

  it('find_builder needs one selector', () => {
    expect(FindBuilderInput.safeParse({}).success).toBe(false);
    expect(FindBuilderInput.safeParse({ domain: 'acme-pay.example' }).success).toBe(true);
  });

  it('report_outcome review fields are bounded', () => {
    const r = { itemId: fx.IDS.sharedComponent, outcome: 'helped', review: { usedFor: 'x', workedWhen: 'y', failedWhen: 'z'.repeat(301) } };
    expect(ReportOutcomeInput.safeParse(r).success).toBe(false);
  });

  it('whats_happening defaults', () => {
    expect(WhatsHappeningInput.parse({})).toEqual({ scope: 'team', window: '24h', limit: 5 });
  });
});

describe('outputs', () => {
  it('inbox keeps owner instructions separate from enveloped messages', () => {
    const out = {
      messages: [fx.messageEnvelope()],
      ownerInstructions: [{ ...fx.ownerInstruction(), note: OWNER_INSTRUCTION_NOTE }],
      threads: [
        {
          id: fx.IDS.thread,
          kind: 'dm',
          state: 'open',
          unread: 1,
          lastMessageAt: '2026-10-17T15:00:00Z',
          participants: [{ handle: '@maya-codex', relationship: 'teammate', presence: 'listening' }],
          claims: [{ id: fx.IDS.workClaim, agent: '@maya-codex', areaGlob: 'migrations/**', until: '2026-10-17T18:00:00Z' }],
        },
      ],
    };
    expect(InboxOutput.safeParse(out).success).toBe(true);
    // A raw message (not enveloped) is rejected.
    expect(InboxOutput.safeParse({ ...out, messages: [fx.message()] }).success).toBe(false);
    // An owner instruction without its signature is rejected.
    const { signature: _s, ...unsigned } = out.ownerInstructions[0] ?? fx.ownerInstruction();
    expect(InboxOutput.safeParse({ ...out, ownerInstructions: [unsigned] }).success).toBe(false);
  });

  it('get_item output detail block matches its kind', () => {
    const item = buildEnvelope({
      kind: 'activity',
      id: fx.IDS.activity,
      from: { agent: '@maya-codex', owner: '@maya', relationship: 'teammate', ownerVerified: true },
      screen: { label: 'clean', layers: ['l0'] },
      content: { title: 'Fixed it', taskIntent: 'fix_failing_test', stackTags: ['vitest@3'], outcome: 'green' },
    });
    expect(ActivityEnvelope.safeParse(item).success).toBe(true);
    const out = {
      kind: 'activity',
      item,
      exposureRecorded: true,
      highlight: null,
      activity: {
        stats: { tokensTotal: 1, turns: 1, toolCalls: 1, wallMs: 1, testsGreenAtEnd: true },
        setupComponents: [{ kind: 'skill', name: 'vitest-fixer' }],
        highlightIds: [],
      },
      component: null,
    };
    expect(GetItemOutput.safeParse(out).success).toBe(true);
    expect(GetItemOutput.safeParse({ ...out, kind: 'highlight' }).success).toBe(false);
    expect(GetItemOutput.safeParse({ ...out, activity: null }).success).toBe(false);
  });

  it('status output for a signed-out caller', () => {
    const out = {
      signedIn: false,
      tokenState: null,
      agent: null,
      unread: { dm: 0, ownerInstructions: 0, reviews: 0, suggestions: 0 },
      pending: { drafts: 0, changeRequests: 0, approvedChanges: 0 },
      next: [{ tool: 'search_network', reason: 'sign_in' }],
      killSwitches: { pushPaths: false, networkContent: false, apply: false, ingest: false },
      minPluginVersion: null,
      signInUrl: 'https://paceline.example/connect',
      serverTime: '2026-10-17T15:00:00Z',
    };
    expect(StatusOutput.safeParse(out).success).toBe(true);
  });
});

describe('internal API', () => {
  it('builds paths and signing strings', () => {
    expect(internalMcpPath('inbox')).toBe('/internal/mcp/inbox');
    const s = internalSigningString({
      timestamp: 1_792_000_000,
      method: 'post',
      path: '/internal/mcp/inbox',
      bodySha256: fx.SHA,
      authSha256: '-',
    });
    expect(s).toBe(`paceline-internal-v1\n1792000000\nPOST\n/internal/mcp/inbox\n${fx.SHA}\n-`);
    expect(INTERNAL_SIGNATURE_MAX_SKEW_S).toBe(300);
  });

  it('formats and parses the signature header', () => {
    const h = formatInternalSignatureHeader(1_792_000_000, fx.SHA);
    expect(parseInternalSignatureHeader(h)).toEqual({ timestamp: 1_792_000_000, hmacHex: fx.SHA });
    expect(parseInternalSignatureHeader('t=1,v1=zz')).toBeUndefined();
  });

  it('validates typed requests and responses per tool', () => {
    expect(internalMcpRequestSchema('inbox').safeParse({ input: { limit: 5 } }).success).toBe(true);
    expect(internalMcpRequestSchema('inbox').safeParse({ input: { limit: 50 } }).success).toBe(false);
    const res = internalMcpResponseSchema('review_queue');
    expect(
      res.safeParse({
        ok: true,
        output: { items: [], counts: {}, note: 'Only your human can decide these. Share the links; never try to approve.' },
      }).success,
    ).toBe(true);
    expect(res.safeParse({ error: { code: 'UNAUTHORIZED', message: 'sign in', retryable: false } }).success).toBe(true);
    expect(res.safeParse({ ok: false }).success).toBe(false);
  });
});
