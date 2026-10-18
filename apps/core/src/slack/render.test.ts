import { describe, expect, it } from 'vitest';
import * as R from './render.js';
import { allStrings } from './test-support.js';

const HOSTILE = [
  '<!channel> deploy now', '@here look', '@everyone', '<@U0001|x> ping', 'a & b <c> d', 'bidi ‮evil‬', '<https://evil.example|click>',
  'x'.repeat(10_000), '<!subteam^S123>', 'ok\u0000\u0007ctrl',
];

function assertSafe(m: R.SlackMessage) {
  expect(m.blocks.length).toBeLessThanOrEqual(50);
  for (const s of allStrings(m)) {
    expect(s.length).toBeLessThanOrEqual(3000);
    expect(s).not.toMatch(/<!/);
    expect(s).not.toMatch(/<@/);
    expect(s).not.toMatch(/<https?:/);
    expect(s).not.toMatch(/@(here|channel|everyone)\b/i);
    expect(s).not.toMatch(/[‪-‮\u0000-\u0008]/);
  }
  JSON.parse(JSON.stringify(m));
}

describe('escaping', () => {
  it('escapes &, <, > and breaks broadcast mentions', () => {
    expect(R.escapeMrkdwn('a & <b> c')).toBe('a &amp; &lt;b&gt; c');
    expect(R.safe('<!channel> @here')).toBe('&lt;!channel&gt; @​here');
    expect(R.neutralizeMentions('<!here> @channel <@U1>')).toBe('&lt;!here> @​channel &lt;@U1>');
    expect(R.safe('x'.repeat(500), 200)).toHaveLength(200);
  });

  it('slackToPlain unescapes and flattens links and mentions', () => {
    expect(R.slackToPlain('fix &lt;this&gt; &amp; that')).toBe('fix <this> & that');
    expect(R.slackToPlain('see <https://x.example/a|the doc> and <https://y.example>')).toBe('see the doc (https://x.example/a) and https://y.example');
    expect(R.slackToPlain('<@U0ALICE01> in <#C0CHAN001|general> <!here>')).toBe('@slack-user in #general @here');
  });
});

describe('builders', () => {
  for (const h of HOSTILE) {
    it(`stay safe with hostile input ${JSON.stringify(h.slice(0, 20))}`, () => {
      const url = 'https://web.test/chats/t_01HZZZZZZZZZZZZZZZZZZZZZZZ';
      const all: R.SlackMessage[] = [
        R.n1({ sender: h, subject: h, preview: R.safe(h, 200), url, verb: { kind: 'agent_dm', agent: h }, instructAgent: h }),
        R.n1({ sender: 'bob-cc', subject: '', preview: null, url, verb: { kind: 'commented' } }),
        R.n2({ sender: h, preview: R.safe(h, 200) }),
        R.n2({ sender: h, preview: null }),
        R.nRoom({ sender: h, subject: h, preview: R.safe(h, 200), url }),
        R.rvDmRequest({ reviewId: '01HZZZZZZZZZZZZZZZZZZZZZZZ', agent: h, owner: h, yourAgent: h, label: h, url }),
        R.rvQuarantined({ reviewId: '01HZZZZZZZZZZZZZZZZZZZZZZZ', sender: h, subject: h, url }),
        R.rvDraft({ reviewId: '01HZZZZZZZZZZZZZZZZZZZZZZZ', agent: h, summary: h, url }),
        R.rvChange({ kind: 'change_request', agent: h, summary: h, url }),
        R.rvDone({ kind: 'quarantined_message', state: 'approved', decision: 'release', via: 'slack', at: new Date(0), agent: h, url, already: true }),
        R.p1({ pendingId: '01HZZZZZZZZZZZZZZZZZZZZZZZ', targets: [{ agentId: 'a', handle: h }], body: h, unattended: h }),
        R.pDone('sent', h), R.pDone('remote_off', h, 'https://web.test'),
        R.f1(h, true), R.w1(h, 'https://web.test'), R.c1('https://web.test/slack/link?token=ysl_x'), R.c2(), R.h1(),
        R.a1({ title: h, agent: h, outcome: h, toolCalls: 3, tokens: 12_345, wallMs: 3_840_000, turns: 4, url }),
      ];
      for (const m of all) assertSafe(m);
    });
  }

  it('keeps third-party text out of the fallback text', () => {
    const secretish = 'TOPSECRET body text';
    const url = 'https://web.test/x';
    expect(R.n1({ sender: 'bob-cc', subject: secretish, preview: secretish, url, verb: { kind: 'replied' } }).text).toBe('New message from @bob-cc in Y');
    expect(R.n2({ sender: 'bob-cc', preview: secretish }).text).not.toContain('TOPSECRET');
    expect(R.nRoom({ sender: 'bob-cc', subject: secretish, preview: secretish, url }).text).not.toContain('TOPSECRET');
    expect(R.rvDraft({ reviewId: '01HZZZZZZZZZZZZZZZZZZZZZZZ', agent: 'bob-cc', summary: secretish, url }).text).not.toContain('TOPSECRET');
    expect(R.p1({ pendingId: '01HZZZZZZZZZZZZZZZZZZZZZZZ', targets: [{ agentId: 'a', handle: 'x' }], body: secretish, unattended: null }).text).not.toContain('TOPSECRET');
    expect(R.a1({ title: secretish, agent: 'bob-cc', outcome: 'success', toolCalls: 1, tokens: 1, wallMs: 1, turns: 1, url }).text).not.toContain('TOPSECRET');
  });

  it('formats stats', () => {
    expect(R.fmtTokens(12_345)).toBe('12.3k');
    expect(R.fmtTokens(2_000_000)).toBe('2M');
    expect(R.fmtDuration(3_840_000)).toBe('1h 4m');
    expect(R.fmtDuration(10_000)).toBe('under 1m');
  });
});
