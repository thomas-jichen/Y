/**
 * DM permission decisions (PLAN §9; default deny, I4).
 */
import { CROSS_OWNER_BODY_MAX, MESSAGE_BODY_MAX } from '@y/schema';
import type { DmDelivery, DmPermission, SenderRelationship, Urgency, WakeOnDm } from '@y/schema';

/** Context for {@link dmDecision}. */
export interface DmPermissionContext {
  /** Human-written `dm_permissions` rows matching the sender, most specific first (agent, user, team, product, relationship). */
  explicit: readonly DmPermission[];
  urgency: Urgency;
  /** Recipient's plugin setting. */
  recipientWakeOnDm: WakeOnDm;
  /** Sender's GitHub account is ≥ 30 days old (required for cross-team DMs). */
  senderGithubAgeOk: boolean;
}

/** Outcome of {@link dmDecision}. */
export interface DmDecision {
  /** `deliver` (after screening), `request` (intro to the human only), `support` (builder approval queue), `deny`. */
  outcome: 'deliver' | 'request' | 'support' | 'deny';
  /** How a delivered message reaches the agent; `null` unless `outcome` is `deliver`. */
  delivery: DmDelivery | null;
  /** Cross-owner egress (contact, followed, customer, stranger): DLP strict, `requiresUserInteraction`. */
  egress: boolean;
  /** Max body length: 1,000 for egress, 4,000 otherwise. */
  bodyMax: number;
}

const EGRESS: ReadonlySet<SenderRelationship> = new Set(['contact', 'followed', 'customer', 'stranger']);

/** Whether a wake is permitted for this relationship by the recipient's `wake_on_dm`. */
function wakeAllowed(rel: SenderRelationship, urgency: Urgency, wakeOnDm: WakeOnDm): boolean {
  if (urgency !== 'wake' || wakeOnDm === 'off') return false;
  if (rel === 'self') return true; // owner-only and teammates both admit the owner's own agents
  if (rel === 'teammate') return wakeOnDm === 'teammates';
  return false; // cross-owner senders never wake
}

/**
 * The DM permission table (PLAN §9; default deny, I4):
 * 1. The first explicit row wins: `deny` → deny; `request` → request;
 *    `allow` → deliver with the row's delivery (`wake` downgraded to
 *    `next_turn` unless `urgency` is `wake` and `wake_on_dm` is `teammates`,
 *    or `owner-only` for `self`; `customer` never wakes).
 * 2. Defaults by relationship:
 *    - `self` (the owner's own agents) → deliver; `wake` if urgency is wake and `recipientWakeOnDm` ≠ `off`, else `next_turn`;
 *    - `teammate` → deliver; `wake` if urgency is wake and `recipientWakeOnDm` is `teammates`, else `next_turn`;
 *    - `contact`, `followed` → deliver, `next_turn`;
 *    - `customer` → support (builder approval queue; never wakes);
 *    - `stranger` → request, or deny when `!senderGithubAgeOk`.
 * Rate limits and wake budget are applied separately.
 */
export function dmDecision(senderRel: SenderRelationship, permissions: DmPermissionContext): DmDecision {
  const egress = EGRESS.has(senderRel);
  const bodyMax = egress ? CROSS_OWNER_BODY_MAX : MESSAGE_BODY_MAX;
  const make = (outcome: DmDecision['outcome'], delivery: DmDelivery | null = null): DmDecision => ({ outcome, delivery, egress, bodyMax });
  const canWake = wakeAllowed(senderRel, permissions.urgency, permissions.recipientWakeOnDm);

  const row = permissions.explicit[0];
  if (row) {
    if (row.policy === 'deny') return make('deny');
    if (row.policy === 'request') return make('request');
    // A human-written wake row extends wakes to its subject, bounded by the plugin setting; customers never wake.
    const rowWake =
      permissions.urgency === 'wake' &&
      senderRel !== 'customer' &&
      (permissions.recipientWakeOnDm === 'teammates' || (permissions.recipientWakeOnDm === 'owner-only' && senderRel === 'self'));
    const delivery: DmDelivery = row.delivery === 'wake' && !rowWake ? 'next_turn' : row.delivery;
    return make('deliver', delivery);
  }

  switch (senderRel) {
    case 'self':
    case 'teammate':
      return make('deliver', canWake ? 'wake' : 'next_turn');
    case 'contact':
    case 'followed':
      return make('deliver', 'next_turn');
    case 'customer':
      return make('support');
    case 'stranger':
      return make(permissions.senderGithubAgeOk ? 'request' : 'deny');
  }
}
