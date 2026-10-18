import { describe, expect, it } from 'vitest';
import { LEASE_STALE_MS, WAKE_LIMITS, inQuietHours, pickLeaseSession, wakeBudget, type LeaseCandidate, type WakeLedgerEntry } from './index.js';

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

const lease = (sessionId: string, over: Partial<LeaseCandidate> = {}): LeaseCandidate => ({
  sessionId,
  listening: true,
  needsApproval: false,
  lastHeartbeatAt: NOW - 10_000,
  lastThreadIds: [],
  permissionMode: 'default',
  headless: false,
  ...over,
});

describe('pickLeaseSession', () => {
  it('fresh-heartbeat threshold is 70 s', () => {
    expect(LEASE_STALE_MS).toBe(70_000);
    expect(pickLeaseSession([lease('s1', { lastHeartbeatAt: NOW - 69_999 })], { now: NOW, kind: 'dm' })).toBe('s1');
    expect(pickLeaseSession([lease('s1', { lastHeartbeatAt: NOW - 70_000 })], { now: NOW, kind: 'dm' })).toBeNull();
  });

  it('only listening, non-headless, non-excluded sessions', () => {
    const sessions = [lease('a', { listening: false }), lease('b', { headless: true }), lease('c'), lease('d')];
    expect(pickLeaseSession(sessions, { now: NOW, kind: 'dm', exclude: ['c'] })).toBe('d');
    expect(pickLeaseSession(sessions.slice(0, 2), { now: NOW, kind: 'dm' })).toBeNull();
    expect(pickLeaseSession([], { now: NOW, kind: 'dm' })).toBeNull();
  });

  it('priority: thread affinity > repo affinity > recency', () => {
    const sessions = [
      lease('recent', { lastHeartbeatAt: NOW - 1_000 }),
      lease('repo', { repoKey: 'gh:acme/web', lastHeartbeatAt: NOW - 30_000 }),
      lease('thread', { lastThreadIds: ['t_1'], lastHeartbeatAt: NOW - 60_000 }),
    ];
    expect(pickLeaseSession(sessions, { now: NOW, kind: 'dm', threadId: 't_1', repoKey: 'gh:acme/web' })).toBe('thread');
    expect(pickLeaseSession(sessions, { now: NOW, kind: 'dm', threadId: 't_2', repoKey: 'gh:acme/web' })).toBe('repo');
    expect(pickLeaseSession(sessions, { now: NOW, kind: 'dm' })).toBe('recent');
  });

  it('prefers sessions that will not stall on approval, then breaks ties by id', () => {
    expect(pickLeaseSession([lease('a', { needsApproval: true, lastHeartbeatAt: NOW }), lease('b')], { now: NOW, kind: 'dm' })).toBe('b');
    expect(pickLeaseSession([lease('z'), lease('y')], { now: NOW, kind: 'dm' })).toBe('y');
  });

  it('owner instructions skip unattended sessions unless confirmed', () => {
    const sessions = [lease('bypass', { permissionMode: 'bypassPermissions', lastHeartbeatAt: NOW }), lease('normal')];
    expect(pickLeaseSession(sessions, { now: NOW, kind: 'owner_instruction' })).toBe('normal');
    expect(pickLeaseSession(sessions.slice(0, 1), { now: NOW, kind: 'owner_instruction' })).toBeNull();
    expect(pickLeaseSession(sessions, { now: NOW, kind: 'owner_instruction', ownerConfirmed: true })).toBe('bypass');
    expect(pickLeaseSession(sessions, { now: NOW, kind: 'dm' })).toBe('bypass');
  });
});

const entry = (minutesAgo: number, over: Partial<WakeLedgerEntry> = {}): WakeLedgerEntry => ({
  at: NOW - minutesAgo * 60_000,
  recipientAgentId: 'a_r',
  senderAgentId: 'a_s',
  ...over,
});

describe('wakeBudget', () => {
  const req = { at: NOW, recipientAgentId: 'a_r', senderAgentId: 'a_s2' };

  it('allows the first wake', () => {
    expect(wakeBudget([], req)).toEqual({ allow: true, reason: 'ok' });
  });

  it('coalesces within 20 s of a wake to the same recipient', () => {
    const e = { ...entry(0), at: NOW - 19_000 };
    expect(wakeBudget([e], req)).toEqual({ allow: false, reason: 'coalesced', coalesceWith: e });
    expect(wakeBudget([{ ...e, at: NOW - WAKE_LIMITS.coalesceMs }], req).allow).toBe(true);
    expect(wakeBudget([{ ...e, recipientAgentId: 'a_other' }], req).allow).toBe(true);
  });

  it('caps the recipient at 6 per hour and 30 per day', () => {
    const hour = Array.from({ length: 6 }, (_, i) => entry(5 + i * 5, { senderAgentId: `a_s${i + 10}` }));
    expect(wakeBudget(hour, req).reason).toBe('recipient_hour');
    expect(wakeBudget(hour.slice(1), req).allow).toBe(true);
    const day = Array.from({ length: 30 }, (_, i) => entry(61 + i * 40, { senderAgentId: `a_s${i + 10}` }));
    expect(wakeBudget(day, req).reason).toBe('recipient_day');
    expect(wakeBudget(day.slice(1), req).allow).toBe(true);
  });

  it('caps the sender at 3 per hour to anyone', () => {
    const ledger = [1, 2, 3].map((i) => entry(i * 10, { senderAgentId: 'a_s2', recipientAgentId: `a_r${i}` }));
    expect(wakeBudget(ledger, req).reason).toBe('sender_hour');
    expect(wakeBudget(ledger.slice(1), req).allow).toBe(true);
  });

  it('ignores ledger entries in the future', () => {
    expect(wakeBudget([{ ...entry(0), at: NOW + 1_000 }], req).allow).toBe(true);
  });

  it('applies quiet hours in the recipient time zone, across midnight', () => {
    // 12:00 UTC = 08:00 in New York (EDT, UTC-4) on Sat 2026-10-17.
    const qh = { start: '22:00', end: '09:00', timezone: 'America/New_York' };
    expect(wakeBudget([], { ...req, quietHours: qh })).toEqual({ allow: false, reason: 'quiet_hours' });
    expect(wakeBudget([], { ...req, quietHours: { ...qh, end: '08:00' } }).allow).toBe(true);
    expect(wakeBudget([], { ...req, quietHours: null }).allow).toBe(true);
  });

  it('coalescing takes precedence over quiet hours', () => {
    const qh = { start: '00:00', end: '23:59', timezone: 'UTC' };
    expect(wakeBudget([{ ...entry(0), at: NOW - 1_000 }], { ...req, quietHours: qh }).reason).toBe('coalesced');
  });
});

describe('inQuietHours', () => {
  const at = (iso: string) => Date.parse(iso);
  it('same-day window', () => {
    const qh = { start: '09:00', end: '17:00', timezone: 'UTC' };
    expect(inQuietHours(at('2026-10-17T09:00:00Z'), qh)).toBe(true);
    expect(inQuietHours(at('2026-10-17T16:59:00Z'), qh)).toBe(true);
    expect(inQuietHours(at('2026-10-17T17:00:00Z'), qh)).toBe(false);
  });

  it('cross-midnight window with days refers to the start day', () => {
    // Friday-night window (day 5) covers Saturday 03:00 but not Saturday 23:00.
    const qh = { start: '22:00', end: '07:00', timezone: 'UTC', days: [5] };
    expect(inQuietHours(at('2026-10-16T23:00:00Z'), qh)).toBe(true); // Fri 23:00
    expect(inQuietHours(at('2026-10-17T03:00:00Z'), qh)).toBe(true); // Sat 03:00
    expect(inQuietHours(at('2026-10-17T23:00:00Z'), qh)).toBe(false); // Sat 23:00
    expect(inQuietHours(at('2026-10-17T12:00:00Z'), qh)).toBe(false);
  });

  it('start === end means none; invalid zones fail closed', () => {
    expect(inQuietHours(NOW, { start: '10:00', end: '10:00', timezone: 'UTC' })).toBe(false);
    expect(inQuietHours(NOW, { start: '10:00', end: '11:00', timezone: 'Not/AZone' })).toBe(true);
  });
});
