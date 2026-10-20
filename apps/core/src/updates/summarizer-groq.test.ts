/**
 * GroqCloud turn summarizer and Y_SUMMARY_LLM selection. No network: every request goes to a mock
 * fetch. Synthetic fixtures only; the key below is a fake that only has to look like one.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { createTestDb, type PgliteDb } from '@y/db';
import { turnSummaryJsonSchema } from '@y/schema';
import type { CoreConfig, CoreDeps, JobHandler } from '../contracts.js';
import { createDeps, loadConfig, PgJobQueue } from '../platform/index.js';
import { retryAfterSeconds } from '../platform/jobs.js';
import {
  createAnthropicTurnSummarizer,
  createGroqTurnSummarizer,
  DEFAULT_GROQ_MODEL,
  GROQ_API_BASE,
  groqRetryAfterSeconds,
  SummaryRetryLaterError,
  SUMMARY_INPUT_MAX_CHARS,
  TURN_SUMMARY_SYSTEM_PROMPT,
  turnSummarizerFor,
} from './summarizer.js';

const FAKE_KEY = 'gsk_TESTONLYnotarealkey0000000000000000000000000000';
const DIGEST = 'USER: make the checkout total include the shipping fee\nTOOL Edit: src/cart.ts (+4/-1)\nTOOL Bash: pnpm test (exit 0)\nFINAL: done';
const GOOD = { changed: 'Added the shipping fee to the checkout total', building: 'Accurate checkout totals' };

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, any>;
}

function completion(content: unknown, extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, ...extra } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** A fetch that records requests and answers from a queue (the last answer repeats). */
function mockFetch(...answers: (Response | (() => Response | Promise<Response>))[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, any> });
    const a = answers.length > 1 ? answers.shift()! : answers[0]!;
    return typeof a === 'function' ? a() : a.clone();
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function baseConfig(env: Record<string, string> = {}): CoreConfig {
  return loadConfig({ NODE_ENV: 'test', Y_INTERNAL_SECRET: 'test-internal-secret', Y_HMAC_KEY: 'test-hmac', ...env });
}

describe('GroqCloud summarizer', () => {
  it('posts the same prompt and digest tail as Anthropic, with strict json_schema and low reasoning for gpt-oss', async () => {
    const { fetch, calls } = mockFetch(completion(JSON.stringify(GOOD)));
    const s = createGroqTurnSummarizer({ apiKey: FAKE_KEY, fetch });
    expect(s.name).toBe(`groq:${DEFAULT_GROQ_MODEL}`);
    expect(DEFAULT_GROQ_MODEL).toBe('openai/gpt-oss-20b');
    const long = `${'TOOL Read: x\n'.repeat(3000)}${DIGEST}`;
    expect(long.length).toBeGreaterThan(SUMMARY_INPUT_MAX_CHARS);
    expect(await s.summarize(long)).toEqual(GOOD);

    expect(calls).toHaveLength(1);
    const { url, init, body } = calls[0]!;
    expect(url).toBe(`${GROQ_API_BASE}/chat/completions`);
    expect(GROQ_API_BASE).toBe('https://api.groq.com/openai/v1');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(body.model).toBe('openai/gpt-oss-20b');
    expect(body.reasoning_effort).toBe('low');
    expect(body.temperature).toBeLessThanOrEqual(0.3);
    expect(body.max_completion_tokens).toBeGreaterThan(0);
    expect(body.max_completion_tokens).toBeLessThanOrEqual(1024);
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'turn_summary', schema: turnSummaryJsonSchema, strict: true } });
    // No tools and no viewer data (I9): only the model, prompt and output controls.
    for (const k of ['tools', 'tool_choice', 'functions', 'user', 'metadata']) expect(body).not.toHaveProperty(k);

    // Same system prompt and same user message as the Anthropic summarizer.
    const anthropicRequests: Record<string, any>[] = [];
    const client = {
      messages: {
        create: async (b: Record<string, any>) => {
          anthropicRequests.push(b);
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(GOOD), citations: null }] };
        },
      },
    } as unknown as Anthropic;
    await createAnthropicTurnSummarizer({ client }).summarize(long);
    expect(body.messages).toEqual([
      { role: 'system', content: TURN_SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: anthropicRequests[0]!.messages[0].content },
    ]);
    expect(anthropicRequests[0]!.system).toBe(TURN_SUMMARY_SYSTEM_PROMPT);
    // The tail: the newest work survives, the oldest is cut.
    const sent = body.messages[1].content as string;
    const decoded = JSON.parse(sent.slice(sent.indexOf('\n') + 1)) as string;
    expect(decoded).toBe(long.slice(-SUMMARY_INPUT_MAX_CHARS));
    expect(decoded.endsWith('FINAL: done')).toBe(true);
  });

  it('falls back to json_object (no reasoning_effort) for models without strict json_schema', async () => {
    const { fetch, calls } = mockFetch(completion(JSON.stringify(GOOD)));
    const s = createGroqTurnSummarizer({ apiKey: FAKE_KEY, fetch, model: 'llama-3.3-70b-versatile' });
    expect(s.name).toBe('groq:llama-3.3-70b-versatile');
    expect(await s.summarize(DIGEST)).toEqual(GOOD);
    expect(calls[0]!.body.response_format).toEqual({ type: 'json_object' });
    expect(calls[0]!.body).not.toHaveProperty('reasoning_effort');
    expect(calls[0]!.body.model).toBe('llama-3.3-70b-versatile');
    // json_object mode needs the word JSON in the prompt.
    expect(TURN_SUMMARY_SYSTEM_PROMPT).toMatch(/JSON/);
  });

  it('unusable output is null: not JSON, wrong shape, too long, empty, refusal', async () => {
    const cases: Response[] = [
      completion('not json'),
      completion('{"changed": "only one field"}'),
      completion(JSON.stringify({ changed: 'x'.repeat(1001), building: 'y' })),
      completion(JSON.stringify(['changed', 'building'])),
      completion(null),
      completion(JSON.stringify(GOOD), { refusal: 'I cannot help with that.' }),
      new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      new Response('<html>oops</html>', { status: 200 }),
    ];
    for (const r of cases) {
      const { fetch } = mockFetch(r);
      expect(await createGroqTurnSummarizer({ apiKey: FAKE_KEY, fetch }).summarize(DIGEST)).toBeNull();
    }
  });

  it('a short 429 reschedules the job after retry-after and stops calling Groq until then (no hot retry)', async () => {
    let t = 1_000_000;
    const { fetch, calls } = mockFetch(
      new Response('{"error":{"message":"Rate limit reached"}}', { status: 429, headers: { 'retry-after': '42' } }),
      completion(JSON.stringify(GOOD)),
    );
    const s = createGroqTurnSummarizer({ apiKey: FAKE_KEY, fetch, now: () => t });
    const err = await s.summarize(DIGEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SummaryRetryLaterError);
    const e1 = err as SummaryRetryLaterError;
    expect(e1.retryable).toBe(true);
    expect(e1.retryAfterS).toBeGreaterThanOrEqual(42);
    expect(e1.retryAfterS).toBeLessThanOrEqual(42 + 30);
    expect(retryAfterSeconds(e1)).toBe(e1.retryAfterS);
    expect(e1.message).not.toContain(FAKE_KEY);
    expect(calls).toHaveLength(1);

    // Another turn inside the window: rescheduled for the rest of the window, without a request.
    t += 10_000;
    const e2 = (await s.summarize(DIGEST).catch((e: unknown) => e)) as SummaryRetryLaterError;
    expect(e2).toBeInstanceOf(SummaryRetryLaterError);
    expect(e2.retryAfterS).toBeGreaterThanOrEqual(32);
    expect(calls).toHaveLength(1);

    // After the reset, Groq is called again.
    t += 40_000;
    expect(await s.summarize(DIGEST)).toEqual(GOOD);
    expect(calls).toHaveLength(2);
  });

  it('a 429 whose reset is far away (free-tier daily cap) skips turns until the reset, warning once', async () => {
    let t = 5_000_000;
    const logs: unknown[][] = [];
    const { fetch, calls } = mockFetch(
      new Response('{}', { status: 429, headers: { 'retry-after': '7200' } }),
      completion(JSON.stringify(GOOD)),
    );
    const s = createGroqTurnSummarizer({ apiKey: FAKE_KEY, fetch, now: () => t, log: (...a) => logs.push(a) });
    expect(await s.summarize(DIGEST)).toBeNull();
    t += 60_000;
    expect(await s.summarize(DIGEST)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]![0]).toBe('warn');
    expect(JSON.stringify(logs)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(logs)).not.toContain('checkout');
    t += 7200_000;
    expect(await s.summarize(DIGEST)).toEqual(GOOD);
    expect(calls).toHaveLength(2);
  });

  it('a 429 without retry-after uses the reset headers, else a non-hot default', async () => {
    const now = Date.parse('2026-10-19T12:00:00Z');
    expect(groqRetryAfterSeconds(new Headers({ 'retry-after': '3' }), now)).toBe(3);
    expect(groqRetryAfterSeconds(new Headers({ 'retry-after': 'Mon, 19 Oct 2026 12:02:00 GMT' }), now)).toBe(120);
    expect(groqRetryAfterSeconds(new Headers({ 'x-ratelimit-reset-tokens': '2m59.5s', 'x-ratelimit-reset-requests': '7.66s' }), now)).toBeCloseTo(179.5);
    expect(groqRetryAfterSeconds(new Headers({ 'x-ratelimit-reset-requests': '1h2m3s' }), now)).toBe(3723);
    expect(groqRetryAfterSeconds(new Headers({ 'x-ratelimit-reset-requests': '350ms' }), now)).toBeCloseTo(0.35);
    expect(groqRetryAfterSeconds(new Headers({ 'x-ratelimit-reset-requests': 'soon' }), now)).toBeNull();
    expect(groqRetryAfterSeconds(new Headers(), now)).toBeNull();

    const { fetch } = mockFetch(new Response('{}', { status: 429 }));
    const e = (await createGroqTurnSummarizer({ apiKey: FAKE_KEY, fetch }).summarize(DIGEST).catch((x: unknown) => x)) as SummaryRetryLaterError;
    expect(e).toBeInstanceOf(SummaryRetryLaterError);
    expect(e.retryAfterS).toBeGreaterThanOrEqual(60);
  });

  it('5xx, 408, 498, timeouts and network errors are retryable job errors without key or body', async () => {
    for (const status of [500, 502, 503, 408, 498]) {
      const { fetch } = mockFetch(new Response(`{"error":{"message":"${FAKE_KEY} ${DIGEST}"}}`, { status }));
      const e = (await createGroqTurnSummarizer({ apiKey: FAKE_KEY, fetch }).summarize(DIGEST).catch((x: unknown) => x)) as SummaryRetryLaterError;
      expect(e).toBeInstanceOf(SummaryRetryLaterError);
      expect(e.retryAfterS).toBeUndefined();
      expect(e.message).toBe(`groq http ${status}`);
    }
    const timeout = (async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as unknown as typeof fetch;
    const t = (await createGroqTurnSummarizer({ apiKey: FAKE_KEY, fetch: timeout }).summarize(DIGEST).catch((x: unknown) => x)) as Error;
    expect(t).toBeInstanceOf(SummaryRetryLaterError);
    expect(t.message).toBe('groq request timed out');
    const down = (async () => {
      throw new TypeError(`fetch failed for Bearer ${FAKE_KEY}`);
    }) as unknown as typeof fetch;
    const d = (await createGroqTurnSummarizer({ apiKey: FAKE_KEY, fetch: down }).summarize(DIGEST).catch((x: unknown) => x)) as Error;
    expect(d).toBeInstanceOf(SummaryRetryLaterError);
    expect(d.message).toBe('groq request failed');
  });

  it('the request carries a ~20 s timeout signal by default', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    try {
      const { fetch } = mockFetch(completion(JSON.stringify(GOOD)));
      await createGroqTurnSummarizer({ apiKey: FAKE_KEY, fetch }).summarize(DIGEST);
      expect(spy).toHaveBeenCalledWith(20_000);
    } finally {
      spy.mockRestore();
    }
  });

  it('other 4xx skip the turn; auth / model errors warn once with the status only', async () => {
    const logs: unknown[][] = [];
    const { fetch, calls } = mockFetch(
      new Response('{"error":{"code":"json_validate_failed"}}', { status: 400 }),
      new Response('{}', { status: 413 }),
      new Response('{"error":{"message":"Invalid API Key"}}', { status: 401 }),
      new Response('{}', { status: 401 }),
    );
    const s = createGroqTurnSummarizer({ apiKey: FAKE_KEY, fetch, log: (...a) => logs.push(a) });
    for (let i = 0; i < 4; i++) expect(await s.summarize(DIGEST)).toBeNull();
    expect(calls).toHaveLength(4);
    expect(logs).toEqual([['warn', expect.stringContaining('GROQ_API_KEY'), { status: 401 }]]);
  });
});

describe('Y_SUMMARY_LLM selection', () => {
  it('unset follows Y_LLM exactly as before (mock / anthropic, key rules, production)', () => {
    const mock = baseConfig({ Y_LLM: 'mock' });
    expect(mock.summaryLlm).toBeUndefined();
    expect(turnSummarizerFor({ config: { ...mock } })?.name).toBe('mock');
    expect(turnSummarizerFor({ config: { ...mock, production: true } })).toBeNull();
    const anth = baseConfig({ Y_LLM: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test-not-a-key', GROQ_API_KEY: FAKE_KEY });
    expect(turnSummarizerFor({ config: anth })?.name).toMatch(/^anthropic:/);
    expect(turnSummarizerFor({ config: baseConfig({ Y_LLM: 'anthropic', GROQ_API_KEY: FAKE_KEY }) })).toBeNull();
    expect(turnSummarizerFor({ config: baseConfig({ GROQ_API_KEY: FAKE_KEY }) })?.name).toBe('mock');
  });

  it('groq with GROQ_API_KEY wins over Y_LLM; without the key no summarizer', () => {
    const g = baseConfig({ Y_SUMMARY_LLM: 'groq', Y_LLM: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test-not-a-key', GROQ_API_KEY: FAKE_KEY });
    expect(g.summaryLlm).toBe('groq');
    expect(turnSummarizerFor({ config: g })?.name).toBe('groq:openai/gpt-oss-20b');
    expect(turnSummarizerFor({ config: { ...g, production: true } })?.name).toBe('groq:openai/gpt-oss-20b');
    expect(turnSummarizerFor({ config: baseConfig({ Y_SUMMARY_LLM: 'groq', Y_GROQ_MODEL: 'openai/gpt-oss-120b', GROQ_API_KEY: FAKE_KEY }) })?.name).toBe(
      'groq:openai/gpt-oss-120b',
    );
    expect(turnSummarizerFor({ config: baseConfig({ Y_SUMMARY_LLM: 'groq', Y_LLM: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test-not-a-key' }) })).toBeNull();
    expect(turnSummarizerFor({ config: baseConfig({ Y_SUMMARY_LLM: ' GROQ ', GROQ_API_KEY: FAKE_KEY }) })?.name).toMatch(/^groq:/);
  });

  it('anthropic and mock can be chosen independently of Y_LLM; unknown values follow Y_LLM', () => {
    expect(turnSummarizerFor({ config: baseConfig({ Y_SUMMARY_LLM: 'anthropic', Y_LLM: 'mock', ANTHROPIC_API_KEY: 'sk-ant-test-not-a-key' }) })?.name).toMatch(/^anthropic:/);
    expect(turnSummarizerFor({ config: baseConfig({ Y_SUMMARY_LLM: 'anthropic', Y_LLM: 'mock' }) })).toBeNull();
    const m = baseConfig({ Y_SUMMARY_LLM: 'mock', Y_LLM: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test-not-a-key' });
    expect(turnSummarizerFor({ config: m })?.name).toBe('mock');
    expect(turnSummarizerFor({ config: { ...m, production: true } })).toBeNull();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const u = baseConfig({ Y_SUMMARY_LLM: 'grok', Y_LLM: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test-not-a-key', GROQ_API_KEY: FAKE_KEY });
      expect(u.summaryLlm).toBeUndefined();
      expect(turnSummarizerFor({ config: u })?.name).toMatch(/^anthropic:/);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Y_SUMMARY_LLM'));
    } finally {
      warn.mockRestore();
    }
    expect(() => baseConfig({ Y_GROQ_MODEL: 'bad model; rm -rf' })).toThrow(/Y_GROQ_MODEL/);
  });
});

describe('job retry-after (platform/jobs.ts)', () => {
  let db: PgliteDb;
  let deps: CoreDeps;
  beforeAll(async () => {
    db = await createTestDb();
    deps = await createDeps(baseConfig({ Y_LLM: 'mock', Y_EMBEDDINGS: 'mock' }), db, {}, { scheduleRecurring: false, migrateCore: true, log: () => undefined });
  }, 180_000);
  afterAll(async () => {
    await db?.close();
  });

  it('startup warns when groq is selected without a key', async () => {
    const logs: unknown[][] = [];
    await createDeps(baseConfig({ Y_SUMMARY_LLM: 'groq', Y_LLM: 'mock', Y_EMBEDDINGS: 'mock' }), db, {}, {
      scheduleRecurring: false,
      migrateCore: false,
      log: (...a) => logs.push(a),
    });
    expect(logs).toContainEqual(['warn', expect.stringContaining('without GROQ_API_KEY')]);
  }, 60_000);

  it('retryAfterSeconds reads retryAfterS from errors, clamped; others use the default backoff', () => {
    expect(retryAfterSeconds(new Error('x'))).toBeNull();
    expect(retryAfterSeconds(new SummaryRetryLaterError('x'))).toBeNull();
    expect(retryAfterSeconds(new SummaryRetryLaterError('x', 42.2))).toBe(43);
    expect(retryAfterSeconds(new SummaryRetryLaterError('x', 0))).toBe(1);
    expect(retryAfterSeconds(new SummaryRetryLaterError('x', 99_999))).toBe(3600);
    expect(retryAfterSeconds({ retryAfterS: Number.NaN })).toBeNull();
    expect(retryAfterSeconds('nope')).toBeNull();
  });

  it('a retry-later error reschedules the job at retry-after; a plain error keeps the default backoff', async () => {
    const handlers: Record<string, JobHandler> = {
      groq_later: async () => {
        throw new SummaryRetryLaterError('groq rate limited', 600);
      },
      groq_boom: async () => {
        throw new Error('boom');
      },
    };
    const q = new PgJobQueue(db, handlers);
    q.bind(deps);
    await q.enqueue('groq_later', {}, { dedupeKey: 'groq-later' });
    await q.enqueue('groq_boom', {}, { dedupeKey: 'groq-boom' });
    expect(await q.drainDetailed(10)).toEqual({ claimed: 2, completed: 0, failed: 2 });
    const rows = await db.query<{ topic: string; state: string; wait_s: number; last_error: string }>(
      `select topic, state, extract(epoch from (run_after - now()))::float8 as wait_s, last_error from public.jobs where topic in ('groq_later', 'groq_boom') order by topic`,
    );
    const boom = rows.rows.find((r) => r.topic === 'groq_boom')!;
    const later = rows.rows.find((r) => r.topic === 'groq_later')!;
    expect(later.state).toBe('queued');
    expect(later.wait_s).toBeGreaterThan(590);
    expect(later.wait_s).toBeLessThanOrEqual(600);
    expect(later.last_error).toBe('SummaryRetryLaterError: groq rate limited');
    expect(boom.state).toBe('queued');
    expect(boom.wait_s).toBeLessThanOrEqual(10);
  }, 60_000);
});
