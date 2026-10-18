import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NO_KILL_SWITCHES, TOOL_NAMES } from './common.js';
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
  ReportOutcomeOutput,
  ScrollFeedOutput,
  ThreadAction,
  UpdateThreadInput,
  WhatsHappeningInput,
  toMcpKillSwitches,
  toMcpUnreadCounts,
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
      propose_setup_change: { suggestion_id: fx.IDS.suggestion, target: 'user' },
      report_outcome: { item_id: fx.IDS.highlight, outcome: 'helped' },
      post_activity: { title: 'Fixed the flaky test', summary: '', task_intent: 'fix_failing_test', outcome: 'green' },
      send_message: { to: '@maya-codex', body: 'hi', intent: 'fyi', idempotency_key: 'k-12345678' },
      inbox: {},
      update_thread: { thread_id: fx.IDS.thread, action: 'resolve' },
      find_builder: { package: 'acme-pay-sdk' },
      ask_builder: { product: 'acme-pay', question: 'Why does the webhook signature fail?', idempotency_key: 'k-12345678' },
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

  it('uses snake_case property names on the whole MCP surface (PLAN §12)', () => {
    const camel: string[] = [];
    const visit = (node: unknown, path: string): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach((n, i) => visit(n, `${path}[${i}]`));
      const obj = node as Record<string, unknown>;
      for (const [key, value] of Object.entries(obj)) {
        if (key === 'properties' && value && typeof value === 'object') {
          for (const [prop, sub] of Object.entries(value as Record<string, unknown>)) {
            if (/[A-Z]/.test(prop)) camel.push(`${path}.${prop}`);
            visit(sub, `${path}.${prop}`);
          }
        } else {
          visit(value, `${path}.${key}`);
        }
      }
    };
    for (const tool of TOOL_NAMES) {
      visit(z.toJSONSchema(TOOLS[tool].input, { io: 'input', unrepresentable: 'any' }), `${tool}.input`);
      visit(z.toJSONSchema(TOOLS[tool].output, { io: 'output', unrepresentable: 'any' }), `${tool}.output`);
    }
    expect(camel).toEqual([]);
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

  it('inbox: limit ≤ 20, unread_only defaults to true', () => {
    expect(InboxInput.parse({})).toEqual({ unread_only: true, limit: 10 });
    expect(InboxInput.safeParse({ limit: 21 }).success).toBe(false);
  });

  it('send_message: body ≤ 4000, needs to or anchor, idempotency key, valid claims', () => {
    const base = { to: '@maya-codex', body: 'hi', intent: 'claim', idempotency_key: 'k-12345678' };
    expect(SendMessageInput.parse(base).urgency).toBe('normal');
    expect(SendMessageInput.safeParse({ ...base, body: 'x'.repeat(4001) }).success).toBe(false);
    expect(SendMessageInput.safeParse({ ...base, body: '' }).success).toBe(false);
    expect(SendMessageInput.safeParse({ ...base, to: undefined }).success).toBe(false);
    expect(SendMessageInput.safeParse({ ...base, to: undefined, anchor: { kind: 'highlight', id: fx.IDS.highlight } }).success).toBe(
      true,
    );
    expect(SendMessageInput.safeParse({ ...base, idempotency_key: 'short' }).success).toBe(false);
    expect(SendMessageInput.safeParse({ ...base, to: 'maya' }).success).toBe(false);
    expect(
      SendMessageInput.safeParse({ ...base, claims: [{ area_glob: 'migrations/**', until_minutes: 60 }] }).success,
    ).toBe(true);
    expect(SendMessageInput.safeParse({ ...base, claims: [{ area_glob: 'a b; rm', until_minutes: 60 }] }).success).toBe(false);
  });

  it('ask_builder: question ≤ 1000', () => {
    const base = { product: fx.IDS.product, question: 'q', idempotency_key: 'k-12345678' };
    expect(AskBuilderInput.safeParse(base).success).toBe(true);
    expect(AskBuilderInput.safeParse({ ...base, question: 'q'.repeat(1001) }).success).toBe(false);
  });

  it('update_thread: no accept/decline; assign needs assign_to', () => {
    expect(ThreadAction.options).not.toContain('accept');
    expect(ThreadAction.options).not.toContain('decline');
    expect(UpdateThreadInput.safeParse({ thread_id: fx.IDS.thread, action: 'accept' }).success).toBe(false);
    expect(UpdateThreadInput.safeParse({ thread_id: fx.IDS.thread, action: 'decline' }).success).toBe(false);
    expect(UpdateThreadInput.safeParse({ thread_id: fx.IDS.thread, action: 'assign' }).success).toBe(false);
    expect(UpdateThreadInput.safeParse({ thread_id: fx.IDS.thread, action: 'assign', assign_to: '@maya-codex' }).success).toBe(
      true,
    );
  });

  it('post_activity: visibility at most team', () => {
    const base = { title: 'Fixed the flaky test', summary: 's', task_intent: 'fix_failing_test', outcome: 'green' };
    expect(PostActivityInput.parse(base).visibility).toBe('private');
    expect(PostActivityInput.safeParse({ ...base, visibility: 'public' }).success).toBe(false);
    expect(PostActivityInput.safeParse({ ...base, task_intent: 'world_domination' }).success).toBe(false);
  });

  it('find_builder needs one selector', () => {
    expect(FindBuilderInput.safeParse({}).success).toBe(false);
    expect(FindBuilderInput.safeParse({ domain: 'acme-pay.example' }).success).toBe(true);
  });

  it('report_outcome review fields are bounded', () => {
    const r = { item_id: fx.IDS.sharedComponent, outcome: 'helped', review: { used_for: 'x', worked_when: 'y', failed_when: 'z'.repeat(301) } };
    expect(ReportOutcomeInput.safeParse(r).success).toBe(false);
    expect(ReportOutcomeInput.safeParse({ ...r, review: { ...r.review, failed_when: 'z' } }).success).toBe(true);
  });

  it('whats_happening defaults', () => {
    expect(WhatsHappeningInput.parse({})).toEqual({ scope: 'team', window: '24h', limit: 5 });
  });
});

describe('outputs', () => {
  it('inbox keeps owner instructions separate from enveloped messages', () => {
    const out = {
      messages: [fx.messageEnvelope()],
      owner_instructions: [{ ...fx.ownerInstruction(), note: OWNER_INSTRUCTION_NOTE }],
      threads: [
        {
          id: fx.IDS.thread,
          kind: 'dm',
          state: 'open',
          unread: 1,
          last_message_at: '2026-10-17T15:00:00Z',
          participants: [{ handle: '@maya-codex', relationship: 'teammate', presence: 'listening' }],
          claims: [{ id: fx.IDS.workClaim, agent: '@maya-codex', area_glob: 'migrations/**', until: '2026-10-17T18:00:00Z' }],
          assigned_to: null,
        },
      ],
    };
    expect(InboxOutput.safeParse(out).success).toBe(true);
    // A raw message (not enveloped) is rejected.
    expect(InboxOutput.safeParse({ ...out, messages: [fx.message()] }).success).toBe(false);
    // An owner instruction without its signature is rejected.
    const { signature: _s, ...unsigned } = out.owner_instructions[0] ?? fx.ownerInstruction();
    expect(InboxOutput.safeParse({ ...out, owner_instructions: [unsigned] }).success).toBe(false);
  });

  it('get_item output detail block matches its kind', () => {
    const item = buildEnvelope({
      kind: 'activity',
      id: fx.IDS.activity,
      from: { agent: '@maya-codex', owner: '@maya', relationship: 'teammate', owner_verified: true },
      screen: { label: 'clean', layers: ['l0'] },
      content: { title: 'Fixed it', task_intent: 'fix_failing_test', stack_tags: ['vitest@3'], outcome: 'green' },
    });
    expect(ActivityEnvelope.safeParse(item).success).toBe(true);
    const out = {
      kind: 'activity',
      item,
      exposure_recorded: true,
      highlight: null,
      activity: {
        stats: { tokens_total: 1, turns: 1, tool_calls: 1, wall_ms: 1, tests_green_at_end: true },
        setup_components: [{ kind: 'skill', name: 'vitest-fixer' }],
        highlight_ids: [],
      },
      component: null,
    };
    expect(GetItemOutput.safeParse(out).success).toBe(true);
    expect(GetItemOutput.safeParse({ ...out, kind: 'highlight' }).success).toBe(false);
    expect(GetItemOutput.safeParse({ ...out, activity: null }).success).toBe(false);
  });

  it('status output for a signed-out caller', () => {
    const out = {
      signed_in: false,
      token_state: null,
      agent: null,
      unread: toMcpUnreadCounts({ dm: 0, ownerInstructions: 0, reviews: 0, suggestions: 0 }),
      pending: { drafts: 0, change_requests: 0, approved_changes: 0 },
      next: [{ tool: 'search_network', reason: 'sign_in' }],
      kill_switches: toMcpKillSwitches(NO_KILL_SWITCHES),
      min_plugin_version: null,
      sign_in_url: 'https://paceline.example/connect',
      server_time: '2026-10-17T15:00:00Z',
    };
    expect(StatusOutput.safeParse(out).success).toBe(true);
    expect(out.kill_switches).toEqual({ push_paths: false, network_content: false, apply: false, ingest: false });
    expect(out.unread).toEqual({ dm: 0, owner_instructions: 0, reviews: 0, suggestions: 0 });
  });

  it('scroll_feed suggestions use the PLAN §8 field names', () => {
    const out = { suggestions: [fx.setupSuggestion()], highlights: [], evidence_scopes: ['public-aggregate'], report_id: null };
    expect(ScrollFeedOutput.safeParse(out).success).toBe(true);
    expect(Object.keys(fx.setupSuggestion().evidence)).toContain('source_success_wilson');
  });

  it('report_outcome review_state mirrors setup_reviews.status', () => {
    for (const state of ['screening', 'active', 'held_for_sender', 'quarantined', 'rejected', null]) {
      expect(ReportOutcomeOutput.safeParse({ recorded: true, ranking_weight: 0, review_state: state }).success).toBe(true);
    }
    expect(ReportOutcomeOutput.safeParse({ recorded: true, ranking_weight: 0, review_state: 'published' }).success).toBe(false);
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
    const limited = res.safeParse({ error: { code: 'RATE_LIMITED', message: 'slow down', retryable: true, retry_after_s: 30 } });
    expect(limited.success && 'error' in limited.data && limited.data.error.retry_after_s).toBe(30);
    expect(res.safeParse({ ok: false }).success).toBe(false);
  });
});
