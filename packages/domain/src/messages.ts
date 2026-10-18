/**
 * Message and delivery state machines (PLAN §9).
 */
import type { DeliveryState, MessageState, ScreenAction, ThreadState } from '@y/schema';

/**
 * Events of the message state machine (PLAN §9). `verdict` carries the
 * screen action from `@y/safety` `actionFor`.
 */
export type MessageEvent =
  | { type: 'submit'; permitted: boolean }
  | { type: 'l0_hold' }
  | { type: 'verdict'; action: ScreenAction }
  | { type: 'request_accepted' }
  | { type: 'request_declined' }
  | { type: 'resubmit' }
  | { type: 'release' }
  | { type: 'deliver' }
  | { type: 'reject' }
  | { type: 'expire' };

/** Result of a transition. Invalid transitions are values, not exceptions (see {@link mustTransition}). */
export type TransitionResult<S extends string> =
  | { ok: true; state: S }
  | { ok: false; error: 'invalid_transition'; from: S; event: string };

/** Thrown by {@link mustTransition} / {@link mustDeliveryTransition}. */
export class IllegalTransitionError extends Error {
  readonly code = 'INVALID_TRANSITION' as const;
  constructor(
    readonly from: string,
    readonly event: string,
  ) {
    super(`illegal transition: ${from} + ${event}`);
    this.name = 'IllegalTransitionError';
  }
}

/** Delivered-but-unseen messages and unanswered requests expire after 14 days. */
export const MESSAGE_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

const QUARANTINE_ACTIONS: ReadonlySet<ScreenAction> = new Set(['quarantine', 'moderator', 'back_to_author', 'back_to_draft']);

function eventName(event: MessageEvent): string {
  if (event.type === 'verdict') return `verdict:${event.action}`;
  if (event.type === 'submit') return `submit:${event.permitted ? 'permitted' : 'not_permitted'}`;
  return event.type;
}

/** Shared mapping for the "bad" verdicts (quarantine family, hold, block). */
function badVerdict(action: ScreenAction): MessageState | null {
  if (QUARANTINE_ACTIONS.has(action)) return 'quarantined';
  if (action === 'hold_for_sender') return 'held_for_sender';
  if (action === 'block') return 'blocked';
  return null;
}

function next(state: MessageState, event: MessageEvent): MessageState | null {
  switch (state) {
    case 'queued':
      if (event.type === 'submit') return event.permitted ? 'screening' : 'request_pending';
      if (event.type === 'l0_hold') return 'held_for_sender';
      return null;
    case 'screening':
      if (event.type === 'l0_hold') return 'held_for_sender';
      if (event.type === 'verdict') {
        if (event.action === 'allow' || event.action === 'label') return 'delivered';
        if (event.action === 'request_flow') return 'request_pending';
        return badVerdict(event.action);
      }
      return null;
    case 'request_pending':
      if (event.type === 'verdict') {
        if (event.action === 'allow' || event.action === 'label' || event.action === 'request_flow') return 'request_pending';
        return badVerdict(event.action);
      }
      if (event.type === 'request_accepted') return 'screening';
      if (event.type === 'request_declined') return 'rejected';
      if (event.type === 'expire') return 'expired';
      return null;
    case 'held_for_sender':
      if (event.type === 'resubmit') return 'screening';
      if (event.type === 'reject') return 'rejected';
      return null;
    case 'quarantined':
      if (event.type === 'release') return 'released';
      if (event.type === 'reject') return 'rejected';
      return null;
    case 'released':
      if (event.type === 'deliver') return 'delivered';
      return null;
    case 'delivered':
      if (event.type === 'expire') return 'expired';
      return null;
    case 'blocked':
    case 'rejected':
    case 'expired':
      return null;
  }
}

/**
 * Message state machine. Valid transitions (everything else is
 * `invalid_transition`):
 * - `queued` + `submit{permitted:true}` → `screening`; `submit{permitted:false}` → `request_pending`
 * - `queued`|`screening` + `l0_hold` → `held_for_sender` (L0 secret or code-shape hit)
 * - `screening` + `verdict`: `allow`|`label` → `delivered`; `request_flow` → `request_pending`;
 *   `quarantine`|`moderator`|`back_to_author`|`back_to_draft` → `quarantined`;
 *   `hold_for_sender` → `held_for_sender`; `block` → `blocked`
 * - `request_pending` + `verdict` (the intro's screen): `allow`|`label`|`request_flow` → `request_pending`;
 *   `quarantine`|… → `quarantined`; `hold_for_sender` → `held_for_sender`; `block` → `blocked`
 * - `request_pending` + `request_accepted` → `screening` (human-only accept; I4);
 *   `request_declined` → `rejected`; `expire` → `expired`
 * - `held_for_sender` + `resubmit` → `screening`; `reject` → `rejected`
 * - `quarantined` + `release` → `released`; `reject` → `rejected`
 * - `released` + `deliver` → `delivered`
 * - `delivered` + `expire` → `expired` (unseen for {@link MESSAGE_EXPIRY_MS})
 * `blocked`, `rejected` and `expired` are terminal.
 */
export function transition(state: MessageState, event: MessageEvent): TransitionResult<MessageState> {
  const to = next(state, event);
  return to === null ? { ok: false, error: 'invalid_transition', from: state, event: eventName(event) } : { ok: true, state: to };
}

/** {@link transition}, but illegal transitions throw {@link IllegalTransitionError}. */
export function mustTransition(state: MessageState, event: MessageEvent): MessageState {
  const r = transition(state, event);
  if (!r.ok) throw new IllegalTransitionError(r.from, r.event);
  return r.state;
}

/** Whether a message state is terminal. */
export function isTerminalMessageState(state: MessageState): boolean {
  return state === 'blocked' || state === 'rejected' || state === 'expired';
}

/** Per-recipient delivery events. */
export type DeliveryEvent = 'pointer_sent' | 'seen' | 'handled' | 'expire';

const DELIVERY_ORDER: Record<Exclude<DeliveryState, 'expired'>, number> = { pending: 0, pointer_sent: 1, seen: 2, handled: 3 };

/**
 * Delivery state machine (monotonic): `pending` → `pointer_sent` → `seen` →
 * `handled`; `seen` and `handled` may skip earlier states; `expire` only from
 * `pending`|`pointer_sent`. Re-applying the current state's event is a no-op
 * success (`seen` on `seen`). `handled`/`expired` are terminal.
 */
export function deliveryTransition(state: DeliveryState, event: DeliveryEvent): TransitionResult<DeliveryState> {
  const fail = { ok: false as const, error: 'invalid_transition' as const, from: state, event };
  if (state === 'expired') return fail;
  if (state === 'handled') return event === 'handled' ? { ok: true, state } : fail;
  if (event === 'expire') return state === 'pending' || state === 'pointer_sent' ? { ok: true, state: 'expired' } : fail;
  const target: DeliveryState = event;
  if (target === state) return { ok: true, state };
  // pointer_sent cannot skip forward from nothing but can come only from pending.
  if (event === 'pointer_sent') return state === 'pending' ? { ok: true, state: 'pointer_sent' } : fail;
  return DELIVERY_ORDER[target as keyof typeof DELIVERY_ORDER] > DELIVERY_ORDER[state] ? { ok: true, state: target } : fail;
}

/** {@link deliveryTransition}, but illegal transitions throw {@link IllegalTransitionError}. */
export function mustDeliveryTransition(state: DeliveryState, event: DeliveryEvent): DeliveryState {
  const r = deliveryTransition(state, event);
  if (!r.ok) throw new IllegalTransitionError(r.from, r.event);
  return r.state;
}

/**
 * Pre-check before creating a message in a thread: `paused_by_owner` →
 * `'PAUSED_BY_OWNER'`; `resolved`/`archived` → `'reopen'` (sending reopens the
 * thread); `request` → `'request_pending'` for **everyone** (fail closed, I4:
 * a requester's follow-ups wait with the intro, and the recipient's agent
 * can't implicitly accept; only the human accept moves the thread to `open`);
 * `open` → `'ok'`. `senderIsRequester` is kept for callers that log it.
 */
export function sendPrecheck(threadState: ThreadState, _senderIsRequester: boolean): 'ok' | 'reopen' | 'request_pending' | 'PAUSED_BY_OWNER' {
  switch (threadState) {
    case 'paused_by_owner':
      return 'PAUSED_BY_OWNER';
    case 'resolved':
    case 'archived':
      return 'reopen';
    case 'request':
      return 'request_pending';
    case 'open':
      return 'ok';
  }
}
