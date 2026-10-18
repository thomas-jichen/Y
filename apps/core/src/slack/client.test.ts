import { describe, expect, it } from 'vitest';
import { SlackApiError, createFetchSlackClient } from './client.js';

function fakeFetch(responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses.shift() ?? { body: { ok: true } };
    return new Response(JSON.stringify(r.body ?? { ok: true }), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
  }) as typeof fetch;
  return { impl, calls };
}

describe('createFetchSlackClient', () => {
  it('posts with the bearer token and never unfurls or parses mentions', async () => {
    const f = fakeFetch([{ body: { ok: true, channel: 'D0CHAN001', ts: '1700000000.000100' } }, { body: { ok: true } }, { body: { ok: true } }]);
    const c = createFetchSlackClient('xoxb-test-0000', f.impl);
    const out = await c.postMessage({ channel: 'D0CHAN001', text: 'hi', threadTs: '1700000000.000001' });
    expect(out).toEqual({ channel: 'D0CHAN001', ts: '1700000000.000100' });
    await c.postEphemeral({ channel: 'C0CHAN001', user: 'U0ALICE01', text: 'x' });
    await c.updateMessage({ channel: 'D0CHAN001', ts: '1700000000.000100', text: 'y' });
    expect(f.calls.map((x) => x.url)).toEqual([
      'https://slack.com/api/chat.postMessage', 'https://slack.com/api/chat.postEphemeral', 'https://slack.com/api/chat.update',
    ]);
    for (const call of f.calls) {
      expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer xoxb-test-0000');
      expect(call.init.signal).toBeDefined();
    }
    const b0 = JSON.parse(String(f.calls[0]!.init.body));
    expect(b0).toMatchObject({ unfurl_links: false, unfurl_media: false, parse: 'none', link_names: false, thread_ts: '1700000000.000001' });
    expect(JSON.parse(String(f.calls[1]!.init.body))).toMatchObject({ unfurl_links: false, unfurl_media: false, parse: 'none' });
    expect(JSON.parse(String(f.calls[2]!.init.body))).toMatchObject({ parse: 'none', link_names: false });
  });

  it('maps {ok:false} and HTTP 429 to SlackApiError', async () => {
    const f = fakeFetch([{ body: { ok: false, error: 'not_in_channel' } }, { status: 429, body: { ok: false }, headers: { 'retry-after': '7' } }]);
    const c = createFetchSlackClient('xoxb-test-0000', f.impl);
    await expect(c.postMessage({ channel: 'C0CHAN001', text: 'x' })).rejects.toMatchObject({ code: 'not_in_channel', method: 'chat.postMessage' });
    const e = await c.postMessage({ channel: 'C0CHAN001', text: 'x' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SlackApiError);
    expect(e).toMatchObject({ code: 'ratelimited', retryAfterS: 7 });
  });

  it('caches conversations.open per user', async () => {
    const f = fakeFetch([{ body: { ok: true, channel: { id: 'D0CHAN001' } } }]);
    const c = createFetchSlackClient('xoxb-test-0000', f.impl);
    expect(await c.openIm('U0ALICE01')).toBe('D0CHAN001');
    expect(await c.openIm('U0ALICE01')).toBe('D0CHAN001');
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ users: 'U0ALICE01' });
  });
});
