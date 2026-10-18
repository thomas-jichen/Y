import { MessageState, ScreenAction, TERMINAL_MESSAGE_STATES, ThreadState } from '@paceline/schema';
import { describe, expect, it } from 'vitest';
import {
  IllegalTransitionError,
  deliveryTransition,
  isTerminalMessageState,
  mustDeliveryTransition,
  mustTransition,
  sendPrecheck,
  transition,
  type MessageEvent,
} from './index.js';

const ALL_EVENTS: MessageEvent[] = [
  { type: 'submit', permitted: true },
  { type: 'submit', permitted: false },
  { type: 'l0_hold' },
  ...ScreenAction.options.map((action) => ({ type: 'verdict' as const, action })),
  { type: 'request_accepted' },
  { type: 'request_declined' },
  { type: 'resubmit' },
  { type: 'release' },
  { type: 'deliver' },
  { type: 'reject' },
  { type: 'expire' },
];

const verdict = (action: ScreenAction): MessageEvent => ({ type: 'verdict', action });

describe('message state machine', () => {
  it('teammate happy path: queued → screening → delivered → expired', () => {
    let s: MessageState = 'queued';
    s = mustTransition(s, { type: 'submit', permitted: true });
    expect(s).toBe('screening');
    s = mustTransition(s, verdict('allow'));
    expect(s).toBe('delivered');
    expect(mustTransition(s, { type: 'expire' })).toBe('expired');
  });

  it('label also delivers', () => {
    expect(transition('screening', verdict('label'))).toEqual({ ok: true, state: 'delivered' });
  });

  it('stranger path: request_pending → (human accept) → screening; decline → rejected; expire → expired', () => {
    expect(mustTransition('queued', { type: 'submit', permitted: false })).toBe('request_pending');
    expect(mustTransition('request_pending', { type: 'request_accepted' })).toBe('screening');
    expect(mustTransition('request_pending', { type: 'request_declined' })).toBe('rejected');
    expect(mustTransition('request_pending', { type: 'expire' })).toBe('expired');
  });

  it('screening request_flow verdict sends to request_pending', () => {
    expect(mustTransition('screening', verdict('request_flow'))).toBe('request_pending');
  });

  it('intro screen on request_pending: clean stays pending, bad verdicts leave', () => {
    for (const a of ['allow', 'label', 'request_flow'] as const) expect(mustTransition('request_pending', verdict(a))).toBe('request_pending');
    expect(mustTransition('request_pending', verdict('quarantine'))).toBe('quarantined');
    expect(mustTransition('request_pending', verdict('hold_for_sender'))).toBe('held_for_sender');
    expect(mustTransition('request_pending', verdict('block'))).toBe('blocked');
  });

  it('quarantine family → quarantined; release → released → delivered; reject → rejected', () => {
    for (const a of ['quarantine', 'moderator', 'back_to_author', 'back_to_draft'] as const) {
      expect(mustTransition('screening', verdict(a))).toBe('quarantined');
    }
    expect(mustTransition('quarantined', { type: 'release' })).toBe('released');
    expect(mustTransition('released', { type: 'deliver' })).toBe('delivered');
    expect(mustTransition('quarantined', { type: 'reject' })).toBe('rejected');
  });

  it('L0 hits hold for the sender; resubmit re-screens', () => {
    expect(mustTransition('queued', { type: 'l0_hold' })).toBe('held_for_sender');
    expect(mustTransition('screening', { type: 'l0_hold' })).toBe('held_for_sender');
    expect(mustTransition('screening', verdict('hold_for_sender'))).toBe('held_for_sender');
    expect(mustTransition('held_for_sender', { type: 'resubmit' })).toBe('screening');
    expect(mustTransition('held_for_sender', { type: 'reject' })).toBe('rejected');
  });

  it('block is terminal', () => {
    expect(mustTransition('screening', verdict('block'))).toBe('blocked');
  });

  it('terminal states reject every event', () => {
    for (const s of TERMINAL_MESSAGE_STATES) {
      expect(isTerminalMessageState(s)).toBe(true);
      for (const e of ALL_EVENTS) expect(transition(s, e).ok).toBe(false);
    }
  });

  it('illegal transitions are values from transition() and throw from mustTransition()', () => {
    const r = transition('delivered', verdict('allow'));
    expect(r).toEqual({ ok: false, error: 'invalid_transition', from: 'delivered', event: 'verdict:allow' });
    expect(() => mustTransition('delivered', { type: 'release' })).toThrow(IllegalTransitionError);
    expect(() => mustTransition('queued', { type: 'deliver' })).toThrow(/queued \+ deliver/);
    // Skipping screening is never possible.
    expect(transition('queued', verdict('allow')).ok).toBe(false);
    // An agent can't release its own quarantine by "accepting".
    expect(transition('quarantined', { type: 'request_accepted' }).ok).toBe(false);
    // Released can't be released again or expire directly.
    expect(transition('released', { type: 'release' }).ok).toBe(false);
  });

  it('every reachable result is a valid MessageState (exhaustive table)', () => {
    let okCount = 0;
    for (const s of MessageState.options) {
      for (const e of ALL_EVENTS) {
        const r = transition(s, e);
        if (r.ok) {
          okCount++;
          expect(MessageState.options).toContain(r.state);
        }
      }
    }
    // 2 (queued submit) + 1 (queued l0) + 1 (screening l0) + 9 verdicts on screening
    // + 9 verdicts on request_pending + 3 request events + 2 held + 2 quarantined + 1 released + 1 delivered
    expect(okCount).toBe(31);
  });
});

describe('delivery state machine', () => {
  it('walks forward and allows skipping to seen/handled', () => {
    expect(mustDeliveryTransition('pending', 'pointer_sent')).toBe('pointer_sent');
    expect(mustDeliveryTransition('pointer_sent', 'seen')).toBe('seen');
    expect(mustDeliveryTransition('seen', 'handled')).toBe('handled');
    expect(mustDeliveryTransition('pending', 'seen')).toBe('seen');
    expect(mustDeliveryTransition('pending', 'handled')).toBe('handled');
  });

  it('re-applying the current event is a no-op success', () => {
    expect(deliveryTransition('seen', 'seen')).toEqual({ ok: true, state: 'seen' });
    expect(deliveryTransition('pointer_sent', 'pointer_sent')).toEqual({ ok: true, state: 'pointer_sent' });
    expect(deliveryTransition('handled', 'handled')).toEqual({ ok: true, state: 'handled' });
  });

  it('is monotonic and expiry only applies before seen', () => {
    expect(deliveryTransition('seen', 'pointer_sent').ok).toBe(false);
    expect(deliveryTransition('handled', 'seen').ok).toBe(false);
    expect(deliveryTransition('pending', 'expire')).toEqual({ ok: true, state: 'expired' });
    expect(deliveryTransition('pointer_sent', 'expire')).toEqual({ ok: true, state: 'expired' });
    expect(deliveryTransition('seen', 'expire').ok).toBe(false);
    for (const e of ['pointer_sent', 'seen', 'handled', 'expire'] as const) expect(deliveryTransition('expired', e).ok).toBe(false);
    expect(() => mustDeliveryTransition('handled', 'expire')).toThrow(IllegalTransitionError);
  });
});

describe('sendPrecheck', () => {
  it('maps every thread state', () => {
    const expected: Record<ThreadState, string> = {
      open: 'ok',
      paused_by_owner: 'PAUSED_BY_OWNER',
      resolved: 'reopen',
      archived: 'reopen',
      request: 'request_pending',
    };
    for (const s of ThreadState.options) expect(sendPrecheck(s, false)).toBe(expected[s]);
  });

  it('a request thread stays pending even for the requester (fail closed, I4)', () => {
    expect(sendPrecheck('request', true)).toBe('request_pending');
  });
});
