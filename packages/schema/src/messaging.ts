/**
 * Threads, messages, deliveries, work claims, owner instructions and DM
 * permissions (PLAN §9, UI.md §4).
 *
 * Owner instructions are a **separate** contract from messages: they are
 * signed by core (Ed25519) and reach agents only in the top-level
 * `owner_instructions[]` field of `inbox`, never inside `untrusted_content`.
 * They are agent-facing only (the web shows them as messages with trust
 * `owner_instruction`), so {@link OwnerInstruction} is snake_case like the
 * rest of the MCP surface. Everything else here is the web (camelCase) view.
 *
 * @module messaging
 */
import { z } from 'zod';
import {
  ActivityId,
  AgentId,
  AgentRef,
  Count,
  EntityId,
  HighlightId,
  IsoTimestamp,
  MessageId,
  OwnerInstructionId,
  Presence,
  ProductId,
  SharedComponentId,
  Slug,
  ThreadId,
  Trust,
  UserRef,
  WorkClaimId,
  multiLine,
  singleLine,
} from './common.js';
import { canonicalJson } from './canonical.js';
import { Screen } from './safety.js';

/** Thread kind. */
export const ThreadKind = z.enum(['dm', 'group', 'comment', 'support']);
export type ThreadKind = z.infer<typeof ThreadKind>;

/** Thread state. `request` = a stranger intro awaiting the recipient's human. */
export const ThreadState = z.enum(['request', 'open', 'paused_by_owner', 'resolved', 'archived']);
export type ThreadState = z.infer<typeof ThreadState>;

/**
 * Full message state machine (PLAN §9):
 * `queued → screening → delivered`; `request_pending` for non-permitted
 * senders; `held_for_sender` on L0 secret/code-shape hits; `quarantined →
 * released → delivered | rejected`; `blocked` on malicious; `expired` when
 * delivered but unseen for 14 days.
 */
export const MessageState = z.enum([
  'queued',
  'request_pending',
  'screening',
  'delivered',
  'quarantined',
  'held_for_sender',
  'blocked',
  'released',
  'rejected',
  'expired',
]);
export type MessageState = z.infer<typeof MessageState>;

/** Terminal message states (no further transitions). */
export const TERMINAL_MESSAGE_STATES = ['blocked', 'rejected', 'expired'] as const satisfies readonly MessageState[];

/** Message intent. */
export const MessageIntent = z.enum([
  'coordinate',
  'question',
  'answer',
  'bug_report',
  'claim',
  'comment',
  'handoff',
  'fyi',
]);
export type MessageIntent = z.infer<typeof MessageIntent>;

/** `wake` asks for an idle-session wake (subject to policy and wake budget). */
export const Urgency = z.enum(['normal', 'wake']);
export type Urgency = z.infer<typeof Urgency>;

/** Per-recipient delivery state. */
export const DeliveryState = z.enum(['pending', 'pointer_sent', 'seen', 'handled', 'expired']);
export type DeliveryState = z.infer<typeof DeliveryState>;

/** Delivery ladder rung that reached the recipient (PLAN §9). */
export const DeliveryPath = z.enum(['inbox', 'hook_pointer', 'stop_nudge', 'wake', 'monitor', 'owner_notification']);
export type DeliveryPath = z.infer<typeof DeliveryPath>;

/** Message body limits: 4,000 chars; cross-owner sends 1,000; intros 280. */
export const MESSAGE_BODY_MAX = 4000;
export const CROSS_OWNER_BODY_MAX = 1000;
export const INTRO_MAX = 280;

/**
 * One recipient's delivery record ("seen 14:02 via inbox"). `path` is the
 * rung that reached the recipient; absent while the delivery is `pending`
 * and nothing has been sent yet (`message_deliveries.path` is null).
 */
export const Delivery = z.object({
  recipient: AgentRef,
  state: DeliveryState,
  path: DeliveryPath.optional(),
  seenAt: IsoTimestamp.optional(),
});
export type Delivery = z.infer<typeof Delivery>;

/** Sender of a message. Exactly one of `agent`/`user` is set unless `kind` is `system`. */
export const MessageSender = z
  .object({
    kind: z.enum(['agent', 'user', 'system']),
    agent: AgentRef.optional(),
    user: UserRef.optional(),
  })
  .refine(
    (s) =>
      (s.kind === 'agent' && !!s.agent && !s.user) ||
      (s.kind === 'user' && !!s.user && !s.agent) ||
      (s.kind === 'system' && !s.agent && !s.user),
    { error: 'sender must carry exactly the ref matching its kind' },
  );
export type MessageSender = z.infer<typeof MessageSender>;

/** A message as the web app sees it. `body` is UNTRUSTED: render as plain text only. */
export const Message = z.object({
  id: MessageId,
  threadId: ThreadId,
  sender: MessageSender,
  trust: Trust,
  intent: MessageIntent,
  urgency: Urgency,
  body: multiLine(MESSAGE_BODY_MAX),
  state: MessageState,
  screen: Screen.optional(),
  createdAt: IsoTimestamp,
  deliveries: z.array(Delivery).max(50),
});
export type Message = z.infer<typeof Message>;

/** Glob describing a claimed work area (`migrations/**`, `src/{api,db}/*.ts`). */
export const AreaGlob = z.string().regex(/^[A-Za-z0-9_.*?/{}[\],!@+-]{1,200}$/, { error: 'invalid area glob' });
export type AreaGlob = z.infer<typeof AreaGlob>;

/** A work claim in a group thread, shown in presence. */
export const WorkClaim = z.object({
  id: WorkClaimId,
  agent: AgentRef,
  areaGlob: AreaGlob,
  note: singleLine(200).optional(),
  until: IsoTimestamp,
});
export type WorkClaim = z.infer<typeof WorkClaim>;

/** Thread participant. */
export const ThreadParticipant = z.object({
  agent: AgentRef.optional(),
  user: UserRef.optional(),
  role: z.enum(['member', 'owner', 'builder', 'customer', 'observer']),
  presence: Presence.optional(),
});
export type ThreadParticipant = z.infer<typeof ThreadParticipant>;

/** A thread as the web app sees it. */
export const Thread = z.object({
  id: ThreadId,
  kind: ThreadKind,
  subject: singleLine(120),
  state: ThreadState,
  participants: z.array(ThreadParticipant).max(50),
  anchor: z
    .object({
      kind: z.enum(['activity', 'highlight', 'component']),
      id: z.union([ActivityId, HighlightId, SharedComponentId]),
      title: singleLine(120),
    })
    .optional(),
  product: z.object({ id: ProductId.optional(), slug: Slug, name: singleLine(64, 1) }).optional(),
  claims: z.array(WorkClaim).max(50),
  lastMessageAt: IsoTimestamp,
  unread: Count,
  viewer: z.object({
    canInstruct: z.boolean(),
    remoteInstructionsOn: z.boolean(),
    needsStepUp: z.boolean(),
  }),
});
export type Thread = z.infer<typeof Thread>;

/* ==================================================== owner instructions */

/** How the human's authority was verified. */
export const VerifiedVia = z.enum(['web', 'slack']);
export type VerifiedVia = z.infer<typeof VerifiedVia>;

/** Ed25519 signature by core over {@link ownerInstructionSigningMessage}. */
export const CoreSignature = z.object({
  alg: z.literal('Ed25519'),
  kid: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
  /** 64-byte Ed25519 signature, unpadded base64url (86 chars). */
  sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/, { error: 'expected a base64url Ed25519 signature' }),
});
export type CoreSignature = z.infer<typeof CoreSignature>;

/**
 * An instruction from the agent's own owner (web "Instruct my agent" with
 * step-up, or a Confirm-gated Slack reply), as `inbox` returns it in
 * `owner_instructions[]`. Cannot authorize setup changes or credential
 * operations. Source: `owner_instructions` (`kid` + `sig` → `signature`).
 */
export const OwnerInstruction = z.object({
  id: OwnerInstructionId,
  agent_id: AgentId,
  thread_id: ThreadId.optional(),
  body: multiLine(MESSAGE_BODY_MAX, 1),
  verified_via: VerifiedVia,
  created_at: IsoTimestamp,
  delivered_at: IsoTimestamp.optional(),
  signature: CoreSignature,
});
export type OwnerInstruction = z.infer<typeof OwnerInstruction>;

/** Fixed note attached to owner instructions in `inbox` output. */
export const OWNER_INSTRUCTION_NOTE =
  'From your owner, verified by Paceline. It cannot authorize setup changes or credential operations.' as const;

/**
 * The exact string core signs for an owner instruction:
 * `"paceline-oi-v1\n" + canonicalJson({id, agent_id, thread_id?, body, verified_via, created_at})`
 * (the signed fields exactly as `inbox` returns them, so a verifier needs
 * nothing else). Clients verify with the keyring public key for
 * `signature.kid`. `created_at` must be the exact string that was signed
 * (core formats it once, ISO with `Z`, and stores that instant).
 */
export function ownerInstructionSigningMessage(
  oi: Pick<OwnerInstruction, 'id' | 'agent_id' | 'thread_id' | 'body' | 'verified_via' | 'created_at'>,
): string {
  return `paceline-oi-v1\n${canonicalJson({
    id: oi.id,
    agent_id: oi.agent_id,
    thread_id: oi.thread_id,
    body: oi.body,
    verified_via: oi.verified_via,
    created_at: oi.created_at,
  })}`;
}

/* ======================================================= DM permissions */

/** DM policy value. Default is deny (I4). */
export const DmPolicy = z.enum(['allow', 'request', 'deny']);
export type DmPolicy = z.infer<typeof DmPolicy>;

/** How permitted DMs are delivered. */
export const DmDelivery = z.enum(['wake', 'next_turn', 'digest']);
export type DmDelivery = z.infer<typeof DmDelivery>;

/** Relationship of a sender to the recipient's owner (input to `dmDecision`). */
export const SenderRelationship = z.enum(['self', 'teammate', 'contact', 'followed', 'customer', 'stranger']);
export type SenderRelationship = z.infer<typeof SenderRelationship>;

/**
 * One `dm_permissions` row. **Writable only by humans** (web or Slack); no
 * MCP tool writes these (I4).
 */
export const DmPermission = z.object({
  subjectKind: z.enum(['agent', 'user', 'team', 'product', 'relationship']),
  /** Agent/user/team/product id, or a {@link SenderRelationship} when `subjectKind` is `relationship`. */
  subjectId: EntityId,
  policy: DmPolicy,
  delivery: DmDelivery,
});
export type DmPermission = z.infer<typeof DmPermission>;
