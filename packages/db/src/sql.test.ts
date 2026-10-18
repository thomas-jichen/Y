import { describe, expect, it } from 'vitest';
import { InvalidClaimsError } from './errors.js';
import {
  MAX_NOTIFY_PAYLOAD_BYTES,
  anonContextStatements,
  assertChannel,
  assertPayload,
  listenSql,
  normalizeClaims,
  notifyIn,
  notifyStatement,
  quoteIdent,
  serializeClaims,
  serviceContextStatements,
  unlistenSql,
  userContextStatements,
} from './sql.js';
import type { AuthClaims, QueryParams } from './types.js';

const USER = '7f0c8a52-6a40-4b8a-9d3f-1f4a2b3c4d5e';

describe('claims', () => {
  it('serializes sub and role first, then optional claims, omitting absent ones', () => {
    expect(serializeClaims({ sub: USER })).toBe(`{"sub":"${USER}","role":"authenticated"}`);
    expect(serializeClaims({ via: 'web', sub: USER, agent_id: 'a_1', install_id: 'i_1' })).toBe(
      `{"sub":"${USER}","role":"authenticated","agent_id":"a_1","install_id":"i_1","via":"web"}`,
    );
  });

  it('accepts role "authenticated" and lowercases the sub', () => {
    expect(normalizeClaims({ sub: USER.toUpperCase(), role: 'authenticated' })).toEqual({
      sub: USER,
      role: 'authenticated',
    });
  });

  it.each([
    ['a non-uuid sub', { sub: 'user-1' }],
    ['an empty sub', { sub: '' }],
    ['a missing sub', {}],
    ['another role', { sub: USER, role: 'service_role' }],
    ['an empty agent_id', { sub: USER, agent_id: '' }],
    ['a non-string install_id', { sub: USER, install_id: 42 }],
    ['an overlong via', { sub: USER, via: 'x'.repeat(257) }],
    ['an unknown claim', { sub: USER, team_id: 't_1' }],
  ])('rejects %s', (_label, claims) => {
    expect(() => normalizeClaims(claims as unknown as AuthClaims)).toThrow(InvalidClaimsError);
  });

  it('rejects non-objects', () => {
    expect(() => normalizeClaims(null as unknown as AuthClaims)).toThrow(InvalidClaimsError);
  });
});

describe('context statements', () => {
  it('asUser sets the role, then transaction-local claims as a bound parameter', () => {
    expect(userContextStatements({ sub: USER, agent_id: 'a_1' })).toEqual([
      { text: 'set local role authenticated' },
      {
        text: "select set_config('request.jwt.claims', $1, true)",
        params: [`{"sub":"${USER}","role":"authenticated","agent_id":"a_1"}`],
      },
    ]);
  });

  it('never interpolates claim values into SQL text', () => {
    const hostile = { sub: USER, via: "'); drop table users; --" };
    for (const stmt of userContextStatements(hostile)) expect(stmt.text).not.toContain('drop table');
  });

  it('validates claims before producing any statement', () => {
    expect(() => userContextStatements({ sub: 'nope' })).toThrow(InvalidClaimsError);
  });

  it('asAnon switches to anon with anon claims', () => {
    expect(anonContextStatements()).toEqual([
      { text: 'set local role anon' },
      { text: "select set_config('request.jwt.claims', $1, true)", params: ['{"role":"anon"}'] },
    ]);
  });

  it('asService switches to service_role with service claims', () => {
    expect(serviceContextStatements()).toEqual([
      { text: 'set local role service_role' },
      { text: "select set_config('request.jwt.claims', $1, true)", params: ['{"role":"service_role"}'] },
    ]);
  });
});

describe('identifiers and channels', () => {
  it('quotes identifiers and doubles embedded quotes', () => {
    expect(quoteIdent('y_events')).toBe('"y_events"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    expect(() => quoteIdent('')).toThrow();
    expect(() => quoteIdent('a\0b')).toThrow();
  });

  it('accepts lowercase identifier channels only', () => {
    expect(assertChannel('y_events')).toBe('y_events');
    expect(assertChannel('_jobs2')).toBe('_jobs2');
    for (const bad of ['', 'Upper', '1abc', 'with space', 'semi;colon', 'quote"', 'x'.repeat(64), 'dash-ed']) {
      expect(() => assertChannel(bad), bad).toThrow();
    }
  });

  it('builds LISTEN/UNLISTEN with a quoted channel', () => {
    expect(listenSql('y_events')).toBe('LISTEN "y_events"');
    expect(unlistenSql('jobs')).toBe('UNLISTEN "jobs"');
    expect(() => listenSql('bad channel')).toThrow();
  });

  it('limits notify payloads to what Postgres accepts', () => {
    expect(assertPayload('x'.repeat(MAX_NOTIFY_PAYLOAD_BYTES))).toHaveLength(MAX_NOTIFY_PAYLOAD_BYTES);
    expect(() => assertPayload('x'.repeat(MAX_NOTIFY_PAYLOAD_BYTES + 1))).toThrow(/at most/);
    // multi-byte characters count by bytes
    expect(() => assertPayload('é'.repeat(4000))).toThrow(/8000 bytes/);
    expect(() => assertPayload(42 as unknown as string)).toThrow();
  });

  it('builds NOTIFY as pg_notify with bound channel and payload', async () => {
    expect(notifyStatement('jobs', '{"id":1}')).toEqual({ text: 'select pg_notify($1, $2)', params: ['jobs', '{"id":1}'] });
    const calls: Array<[string, QueryParams | undefined]> = [];
    await notifyIn(
      {
        async query(sql, params) {
          calls.push([sql, params]);
          return { rows: [], rowCount: 1 };
        },
        async exec() {},
      },
      'jobs',
      'hi',
    );
    expect(calls).toEqual([['select pg_notify($1, $2)', ['jobs', 'hi']]]);
  });
});
