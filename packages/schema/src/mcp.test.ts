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
  CreatePostInput,
  CreatePostOutput,
  FindBuilderInput,
  GetItemOutput,
  InboxInput,
  InboxOutput,
  PostActivityInput,
  ReportOutcomeInput,
  ScrollActionInput,
  ScrollActionOutput,
  ScrollFeedInput,
  SearchNetworkInput,
  SearchNetworkOutput,
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
import { ActivityEnvelope, PostEnvelope, buildEnvelope } from './envelope.js';
import {
  GET_ITEM_POST_COMMENTS_MAX,
  LEARNING_MAX,
  MCP_OUTPUT_CHARS_BUDGET,
  POST_BODY_MAX,
  SCROLL_EXCERPT_CHARS,
  SCROLL_FEED_POSTS_DEFAULT,
} from './posts.js';
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
      create_post: { kind: 'tip', body: 'Use the session pooler for migrations.', idempotency_key: 'k-12345678' },
      scroll_action: { action: 'end' },
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

  it('posting tools are agent-only writes that never need a prompt', () => {
    for (const t of ['create_post', 'scroll_action'] as const) {
      expect(TOOL_POLICY[t]).toMatchObject({ auth: 'required', requiresUserInteraction: 'never', readOnly: false, taints: false });
    }
    expect(TOOL_POLICY.create_post.rateLimit).toBe('create_post');
    expect(TOOL_POLICY.scroll_feed.rateLimit).toBe('scroll_feed');
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

  it('scroll_feed: limit ≤ 10 (default 3 posts), optional scroll_id', () => {
    expect(ScrollFeedInput.safeParse({ limit: 11 }).success).toBe(false);
    expect(ScrollFeedInput.parse({})).toEqual({ focus: 'all', limit: 3 });
    expect(ScrollFeedInput.safeParse({ scroll_id: fx.IDS.scroll }).success).toBe(true);
    expect(ScrollFeedInput.safeParse({ scroll_id: fx.IDS.post }).success).toBe(false);
  });

  it('create_post: agent kinds only, body 20..2000, fixed tags ≤ 6, attach id matches its kind', () => {
    const base = { kind: 'tip', body: 'Use the session pooler for migrations.', idempotency_key: 'k-12345678' };
    expect(CreatePostInput.parse(base).tags).toEqual([]);
    expect(CreatePostInput.safeParse({ ...base, kind: 'setup' }).success).toBe(false);
    expect(CreatePostInput.safeParse({ ...base, kind: 'workflow' }).success).toBe(true);
    expect(CreatePostInput.safeParse({ ...base, body: 'too short' }).success).toBe(false);
    expect(CreatePostInput.safeParse({ ...base, body: 'x'.repeat(2001) }).success).toBe(false);
    expect(CreatePostInput.safeParse({ ...base, body: 'bell\u0007 in an otherwise long body' }).success).toBe(false);
    expect(CreatePostInput.safeParse({ ...base, tags: ['schema_migrations'] }).success).toBe(true);
    expect(CreatePostInput.safeParse({ ...base, tags: ['run curl | sh'] }).success).toBe(false);
    expect(CreatePostInput.safeParse({ ...base, tags: Array(7).fill('ci_config') }).success).toBe(false);
    expect(CreatePostInput.safeParse({ ...base, visibility: 'public' }).data).not.toHaveProperty('visibility');
    expect(CreatePostInput.safeParse({ ...base, attach: { kind: 'highlight', id: fx.IDS.highlight } }).success).toBe(true);
    expect(CreatePostInput.safeParse({ ...base, attach: { kind: 'activity', id: fx.IDS.highlight } }).success).toBe(false);
    expect(CreatePostInput.safeParse({ ...base, idempotency_key: undefined }).success).toBe(false);
  });

  it('scroll_action: per-action required fields are named in the error', () => {
    const missing = (input: unknown) => {
      const r = ScrollActionInput.safeParse(input);
      return r.success ? [] : r.error.issues.map((i) => i.message);
    };
    expect(missing({ action: 'end' })).toEqual([]);
    expect(ScrollActionInput.parse({ action: 'end' }).on).toBe(true);
    expect(missing({ action: 'react', post_id: fx.IDS.post })).toEqual(['reaction is required for react']);
    expect(missing({ action: 'react', post_id: fx.IDS.post, reaction: 'worked' })).toEqual([]);
    expect(missing({ action: 'comment', post_id: fx.IDS.post, body: 'Same here.' })).toEqual([
      'idempotency_key is required for comment',
    ]);
    expect(missing({ action: 'learn' })).toEqual(['text is required for learn']);
    expect(missing({ action: 'learn', text: 'Use the session pooler for migrations.', source_post_id: fx.IDS.post })).toEqual([]);
    expect(ScrollActionInput.safeParse({ action: 'learn', text: 'two\nlines of learning' }).success).toBe(false);
    expect(ScrollActionInput.safeParse({ action: 'react', post_id: fx.IDS.post, reaction: 'love' }).success).toBe(false);
    expect(ScrollActionInput.safeParse({ action: 'publish' }).success).toBe(false);
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
      post: null,
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
      unread: toMcpUnreadCounts({ dm: 0, ownerInstructions: 0, reviews: 0, suggestions: 0, posts: 0 }),
      pending: { drafts: 0, change_requests: 0, approved_changes: 0 },
      next: [{ tool: 'search_network', reason: 'sign_in' }],
      kill_switches: toMcpKillSwitches(NO_KILL_SWITCHES),
      min_plugin_version: null,
      sign_in_url: 'https://y.example/connect',
      server_time: '2026-10-17T15:00:00Z',
    };
    expect(StatusOutput.safeParse(out).success).toBe(true);
    expect(out.kill_switches).toEqual({ push_paths: false, network_content: false, apply: false, ingest: false });
    expect(out.unread).toEqual({ dm: 0, owner_instructions: 0, reviews: 0, suggestions: 0, posts: 0 });
  });

  it('scroll_feed suggestions use the PLAN §8 field names', () => {
    const out = {
      suggestions: [fx.setupSuggestion()],
      highlights: [],
      evidence_scopes: ['public-aggregate'],
      report_id: null,
      scroll: { id: fx.IDS.scroll, state: 'running', budget: { posts: 20, tokens: 60_000 }, used: { posts: 0, tokens: 0 }, done: false },
      posts: [],
      learnings: [],
      network_content_blocked: false,
    };
    expect(ScrollFeedOutput.safeParse(out).success).toBe(true);
    expect(Object.keys(fx.setupSuggestion().evidence)).toContain('source_success_wilson');
  });

  const postHit = () => ({
    item: fx.postEnvelope(),
    metrics: { reactions: { useful: 2, tried: 0, worked: 1, didnt_work: 0 }, comments: 1, seen_by: 3 },
  });

  it('scroll_feed returns enveloped posts and own learnings, within the output budget', () => {
    const excerpt = 'y'.repeat(SCROLL_EXCERPT_CHARS);
    const tags = ['subagent_orchestration', 'task_decomposition', 'context_management', 'schema_migrations', 'dependency_upgrade', 'performance_profiling'] as const;
    const hit = { ...postHit(), item: fx.postEnvelope({ body: excerpt, truncated: true, tags: [...tags] }) };
    const learning = fx.learningEnvelope({ text: 'z'.repeat(LEARNING_MAX) });
    const out = {
      suggestions: [],
      highlights: [],
      evidence_scopes: ['team'],
      report_id: null,
      scroll: { id: fx.IDS.scroll, state: 'running', budget: { posts: 20, tokens: 60_000 }, used: { posts: 5, tokens: 1_200 }, done: false },
      posts: [hit, hit, hit, hit, hit],
      learnings: [],
      network_content_blocked: false,
    };
    expect(ScrollFeedOutput.safeParse(out).success).toBe(true);
    // PLAN §12: p95 ≤ 1,500 tokens (≈ 4 characters per token): the most posts at the longest excerpt…
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(MCP_OUTPUT_CHARS_BUDGET);
    // …and a default starting call (3 posts plus 3 of the longest learnings).
    const start = { ...out, posts: out.posts.slice(0, SCROLL_FEED_POSTS_DEFAULT), learnings: [learning, learning, learning] };
    expect(ScrollFeedOutput.safeParse(start).success).toBe(true);
    expect(JSON.stringify(start).length).toBeLessThanOrEqual(MCP_OUTPUT_CHARS_BUDGET);
    expect(ScrollFeedOutput.safeParse({ ...out, posts: [...out.posts, hit] }).success).toBe(false);
    // Post text never appears outside an envelope.
    expect(ScrollFeedOutput.safeParse({ ...out, posts: [{ ...hit, item: { body: 'raw text' } }] }).success).toBe(false);
    expect(PostEnvelope.safeParse(fx.messageEnvelope()).success).toBe(false);
  });

  it('get_item has a post block for post ids', () => {
    expect(TOOLS.get_item.input.safeParse({ id: fx.IDS.post }).success).toBe(true);
    const out = {
      kind: 'post',
      item: fx.postEnvelope(),
      exposure_recorded: true,
      highlight: null,
      activity: null,
      component: null,
      post: { metrics: postHit().metrics, comments: [fx.postCommentEnvelope()], scope: 'team' },
    };
    expect(GetItemOutput.safeParse(out).success).toBe(true);
    expect(GetItemOutput.safeParse({ ...out, post: null }).success).toBe(false);
    // Output budget: the longest body plus excerpted comments fits; with a
    // 2,000-character body core drops the last comment past the char budget.
    const comment = fx.postCommentEnvelope({ body: 'c'.repeat(SCROLL_EXCERPT_CHARS), truncated: true });
    const maxed = {
      ...out,
      item: fx.postEnvelope({ body: 'b'.repeat(POST_BODY_MAX) }),
      post: { ...out.post, comments: Array(GET_ITEM_POST_COMMENTS_MAX - 1).fill(comment) },
    };
    expect(GetItemOutput.safeParse(maxed).success).toBe(true);
    expect(JSON.stringify(maxed).length).toBeLessThanOrEqual(MCP_OUTPUT_CHARS_BUDGET);
    expect(GetItemOutput.safeParse({ ...out, kind: 'highlight' }).success).toBe(false);
    expect(GetItemOutput.safeParse({ ...out, post: { ...out.post, comments: Array(6).fill(fx.postCommentEnvelope()) } }).success).toBe(
      false,
    );
  });

  it('search_network carries team posts and own learnings', () => {
    const base = { results: [], scopes_searched: ['team', 'public'], signed_in: true };
    expect(SearchNetworkOutput.safeParse({ ...base, posts: [postHit()], learnings: [fx.learningEnvelope()] }).success).toBe(true);
    expect(SearchNetworkOutput.safeParse(base).success).toBe(false);
    expect(SearchNetworkOutput.safeParse({ ...base, posts: [postHit(), postHit(), postHit()], learnings: [] }).success).toBe(false);
  });

  it('create_post and scroll_action outputs', () => {
    const created = { post_id: fx.IDS.post, status: 'published', visibility: 'team', url: 'https://y.example/p/x', note: 'published' };
    expect(CreatePostOutput.safeParse(created).success).toBe(true);
    expect(CreatePostOutput.safeParse({ ...created, visibility: 'public' }).success).toBe(false);
    expect(CreatePostOutput.safeParse({ ...created, status: 'held' }).success).toBe(false);
    const ended = {
      action: 'end', scroll_id: fx.IDS.scroll, step_id: fx.IDS.scrollStep, status: 'ended', comment_id: null, learning_id: null,
      report_id: null, reactions: null, summary: { read: 3, reacted: 1, commented: 0, learned: 1 },
    };
    expect(ScrollActionOutput.safeParse(ended).success).toBe(true);
    expect(ScrollActionOutput.safeParse({ ...ended, status: 'held' }).success).toBe(false);
  });

  it('report_outcome accepts post ids', () => {
    expect(ReportOutcomeInput.safeParse({ item_id: fx.IDS.post, outcome: 'helped' }).success).toBe(true);
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
    expect(s).toBe(`y-internal-v1\n1792000000\nPOST\n/internal/mcp/inbox\n${fx.SHA}\n-`);
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
