import { CROSS_OWNER_BODY_MAX, MESSAGE_BODY_MAX, SenderRelationship, type DmPermission } from '@paceline/schema';
import { describe, expect, it } from 'vitest';
import { dmDecision, type DmPermissionContext } from './index.js';

const ctx = (over: Partial<DmPermissionContext> = {}): DmPermissionContext => ({
  explicit: [],
  urgency: 'normal',
  recipientWakeOnDm: 'teammates',
  senderGithubAgeOk: true,
  ...over,
});

const row = (policy: DmPermission['policy'], delivery: DmPermission['delivery'] = 'next_turn'): DmPermission => ({
  subjectKind: 'agent',
  subjectId: 'a_01HZX0000000000000000000AA',
  policy,
  delivery,
});

describe('dmDecision defaults (PLAN §9 table)', () => {
  it('teammate: allow; wake only when urgency=wake and wake_on_dm=teammates', () => {
    expect(dmDecision('teammate', ctx({ urgency: 'wake' }))).toEqual({ outcome: 'deliver', delivery: 'wake', egress: false, bodyMax: MESSAGE_BODY_MAX });
    expect(dmDecision('teammate', ctx()).delivery).toBe('next_turn');
    expect(dmDecision('teammate', ctx({ urgency: 'wake', recipientWakeOnDm: 'owner-only' })).delivery).toBe('next_turn');
    expect(dmDecision('teammate', ctx({ urgency: 'wake', recipientWakeOnDm: 'off' })).delivery).toBe('next_turn');
  });

  it("owner's own agents (self): wake when urgency=wake unless wake_on_dm=off", () => {
    expect(dmDecision('self', ctx({ urgency: 'wake', recipientWakeOnDm: 'owner-only' })).delivery).toBe('wake');
    expect(dmDecision('self', ctx({ urgency: 'wake', recipientWakeOnDm: 'teammates' })).delivery).toBe('wake');
    expect(dmDecision('self', ctx({ urgency: 'wake', recipientWakeOnDm: 'off' })).delivery).toBe('next_turn');
    expect(dmDecision('self', ctx()).delivery).toBe('next_turn');
  });

  it('contacts and followed agents: allow, next turn, egress', () => {
    for (const rel of ['contact', 'followed'] as const) {
      expect(dmDecision(rel, ctx({ urgency: 'wake' }))).toEqual({ outcome: 'deliver', delivery: 'next_turn', egress: true, bodyMax: CROSS_OWNER_BODY_MAX });
    }
  });

  it('customers go to the support queue and never wake', () => {
    expect(dmDecision('customer', ctx({ urgency: 'wake' }))).toEqual({ outcome: 'support', delivery: null, egress: true, bodyMax: CROSS_OWNER_BODY_MAX });
  });

  it('strangers: request (intro to the human only), or deny for young GitHub accounts', () => {
    expect(dmDecision('stranger', ctx({ urgency: 'wake' }))).toEqual({ outcome: 'request', delivery: null, egress: true, bodyMax: CROSS_OWNER_BODY_MAX });
    expect(dmDecision('stranger', ctx({ senderGithubAgeOk: false })).outcome).toBe('deny');
  });

  it('no relationship ever delivers by wake without urgency=wake', () => {
    for (const rel of SenderRelationship.options) {
      for (const w of ['teammates', 'owner-only', 'off'] as const) {
        expect(dmDecision(rel, ctx({ recipientWakeOnDm: w })).delivery).not.toBe('wake');
      }
    }
  });
});

describe('dmDecision explicit rows (human-written, first wins)', () => {
  it('deny beats the teammate default', () => {
    expect(dmDecision('teammate', ctx({ explicit: [row('deny'), row('allow')] })).outcome).toBe('deny');
  });

  it('request row on a teammate', () => {
    expect(dmDecision('teammate', ctx({ explicit: [row('request')] }))).toMatchObject({ outcome: 'request', delivery: null });
  });

  it('allow row lets a stranger through (still egress-limited)', () => {
    expect(dmDecision('stranger', ctx({ explicit: [row('allow', 'digest')] }))).toEqual({
      outcome: 'deliver',
      delivery: 'digest',
      egress: true,
      bodyMax: CROSS_OWNER_BODY_MAX,
    });
  });

  it('wake rows are downgraded unless urgency=wake and the plugin setting admits it', () => {
    expect(dmDecision('contact', ctx({ explicit: [row('allow', 'wake')] })).delivery).toBe('next_turn');
    expect(dmDecision('contact', ctx({ explicit: [row('allow', 'wake')], urgency: 'wake' })).delivery).toBe('wake');
    expect(dmDecision('contact', ctx({ explicit: [row('allow', 'wake')], urgency: 'wake', recipientWakeOnDm: 'off' })).delivery).toBe('next_turn');
    expect(dmDecision('contact', ctx({ explicit: [row('allow', 'wake')], urgency: 'wake', recipientWakeOnDm: 'owner-only' })).delivery).toBe('next_turn');
    expect(dmDecision('customer', ctx({ explicit: [row('allow', 'wake')], urgency: 'wake' })).delivery).toBe('next_turn');
  });
});
