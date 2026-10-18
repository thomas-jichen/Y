/**
 * Every enum in this package that has a database column must list exactly
 * the values of that column's CHECK constraint (or domain) in
 * supabase/migrations. Reads the SQL text (no database needed), so a change
 * on either side without the other fails here.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ActivityKind,
  ActivitySource,
  ActivityStatus,
  AgentSettings,
  AskBuilderOutput,
  ChangeRequestState,
  ChangeTarget,
  ContentClass,
  DecidedVia,
  Decision,
  DeliveryPath,
  DeliveryState,
  DmDelivery,
  DmPermission,
  DmPolicy,
  EventType,
  EvidenceScope,
  Harness,
  HighlightKind,
  HighlightStatus,
  KILL_SWITCH_DB_NAMES,
  KeyringEntry,
  Label,
  ListenerState,
  MessageIntent,
  MessageState,
  NotificationPrefs,
  OutcomeStatus,
  PermissionMode,
  PrMetric,
  Presence,
  ProductClaim,
  ReportReview,
  ReportedOutcome,
  ReviewKind,
  ReviewState,
  ScreenAction,
  ScreenLayer,
  SegmentCloseReason,
  SegmentKind,
  SenderRelationship,
  SetupComponentKind,
  SetupReviewStatus,
  SharedComponentPage,
  SizeBucket,
  StaticOutcome,
  SuggestionKind,
  TASK_INTENTS,
  TeamRole,
  Thread,
  ThreadKind,
  ThreadParticipant,
  ThreadState,
  Trust,
  Urgency,
  Verdict,
  VerifiedVia,
  Visibility,
  WakeOnDm,
} from './index.js';

const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));

/** All migrations, comments stripped (string literals in this schema never contain `--`). */
const SQL = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
  .join('\n')
  .replace(/--[^\n]*/g, '');

function literals(list: string): string[] {
  return [...list.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? '');
}

/** Values of `create domain y_private.<name> as text check (value in (...))`. */
function domainValues(name: string): string[] {
  const m = new RegExp(`create domain y_private\\.${name} as text\\s+check \\(value in \\(([^)]*)\\)\\)`).exec(SQL);
  if (!m?.[1]) throw new Error(`domain y_private.${name} not found`);
  return literals(m[1]);
}

/** Top-level, comma-separated items of `create table public.<table> ( ... );`. */
function tableItems(table: string): string[] {
  const head = `create table public.${table} (`;
  const start = SQL.indexOf(head);
  if (start < 0) throw new Error(`table public.${table} not found`);
  const items: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (let i = start + head.length; i < SQL.length; i++) {
    const ch = SQL[i]!;
    if (quoted) {
      current += ch;
      if (ch === "'") quoted = false;
      continue;
    }
    if (ch === "'") quoted = true;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) {
        items.push(current.trim());
        return items;
      }
      depth--;
    } else if (ch === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  throw new Error(`unterminated table ${table}`);
}

/** Allowed values of `<table>.<column>`: its own `<column> in (...)` check, or its domain's. */
function columnValues(table: string, column: string): string[] {
  const def = tableItems(table).find((item) => item.startsWith(`${column} `));
  if (!def) throw new Error(`column ${table}.${column} not found`);
  const own = new RegExp(`\\b${column} in \\(([^)]*)\\)`).exec(def);
  if (own?.[1]) return literals(own[1]);
  const domain = /y_private\.([a-z_]+)/.exec(def);
  if (domain?.[1]) return domainValues(domain[1]);
  throw new Error(`column ${table}.${column} has no enum check`);
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

describe('zod enums match the SQL CHECK constraints', () => {
  const cases: [string, readonly string[], () => string[]][] = [
    ['Harness ↔ domain harness', Harness.options, () => domainValues('harness')],
    ['Visibility ↔ domain visibility', Visibility.options, () => domainValues('visibility')],
    ['Label ↔ domain label', Label.options, () => domainValues('label')],
    ['ScreenAction ↔ domain screen_action', ScreenAction.options, () => domainValues('screen_action')],
    ['TASK_INTENTS ↔ domain task_intent', TASK_INTENTS, () => domainValues('task_intent')],
    ['SizeBucket ↔ domain size_bucket', SizeBucket.options, () => domainValues('size_bucket')],
    ['OutcomeStatus ↔ domain outcome_status', OutcomeStatus.options, () => domainValues('outcome_status')],
    ['TeamRole ↔ domain member_role', TeamRole.options, () => domainValues('member_role')],
    ['Presence ↔ domain presence', Presence.options, () => domainValues('presence')],
    ['ListenerState ↔ domain listener_state', ListenerState.options, () => domainValues('listener_state')],
    ['PermissionMode ↔ domain permission_mode', PermissionMode.options, () => domainValues('permission_mode')],
    ['WakeOnDm ↔ agent_settings.wake_on_dm', WakeOnDm.options, () => columnValues('agent_settings', 'wake_on_dm')],
    ['AgentSettings.status ↔ agents.status', AgentSettings.shape.status.options, () => columnValues('agents', 'status')],
    ['ContentClass ↔ verdicts.content_class', ContentClass.options, () => columnValues('verdicts', 'content_class')],
    ['Verdict.l2Error ↔ verdicts.l2_error', Verdict.shape.l2Error.unwrap().options, () => columnValues('verdicts', 'l2_error')],
    ['KILL_SWITCH_DB_NAMES ↔ kill_switches.name', Object.values(KILL_SWITCH_DB_NAMES), () => columnValues('kill_switches', 'name')],
    ['KeyringEntry.status ↔ signing_keys.status', KeyringEntry.shape.status.options, () => columnValues('signing_keys', 'status')],
    ['SegmentKind ↔ segments.kind', SegmentKind.options, () => columnValues('segments', 'kind')],
    ['SegmentCloseReason ↔ sessions.close_reason', SegmentCloseReason.options, () => columnValues('sessions', 'close_reason')],
    ['SetupComponentKind ↔ setup_components.kind', SetupComponentKind.options, () => columnValues('setup_components', 'kind')],
    ['SharedComponentPage.kind ↔ shared_components.kind', SharedComponentPage.shape.kind.options, () => columnValues('shared_components', 'kind')],
    ['StaticOutcome ↔ shared_components.static_outcome', StaticOutcome.options, () => columnValues('shared_components', 'static_outcome')],
    ['StaticOutcome ↔ setup_suggestions.static_outcome', StaticOutcome.options, () => columnValues('setup_suggestions', 'static_outcome')],
    ['ActivityKind ↔ activities.kind', ActivityKind.options, () => columnValues('activities', 'kind')],
    ['ActivitySource ↔ activities.source', ActivitySource.options, () => columnValues('activities', 'source')],
    ['ActivitySource ↔ segment_efforts.source', ActivitySource.options, () => columnValues('segment_efforts', 'source')],
    ['ActivityStatus ↔ activities.status', ActivityStatus.options, () => columnValues('activities', 'status')],
    ['HighlightKind ↔ highlights.kind', HighlightKind.options, () => columnValues('highlights', 'kind')],
    ['HighlightStatus ↔ highlights.status', HighlightStatus.options, () => columnValues('highlights', 'status')],
    ['SetupReviewStatus ↔ setup_reviews.status', SetupReviewStatus.options, () => columnValues('setup_reviews', 'status')],
    ['PrMetric ↔ personal_records.metric', PrMetric.options, () => columnValues('personal_records', 'metric')],
    ['ProductClaim.kind ↔ product_claims.kind', ProductClaim.shape.kind.options, () => columnValues('product_claims', 'kind')],
    ['AskBuilderOutput.reply_policy ↔ products.reply_policy', AskBuilderOutput.shape.reply_policy.options, () => columnValues('products', 'reply_policy')],
    ['ThreadKind ↔ threads.kind', ThreadKind.options, () => columnValues('threads', 'kind')],
    ['ThreadState ↔ threads.state', ThreadState.options, () => columnValues('threads', 'state')],
    ['Thread.anchor.kind ↔ threads.anchor_kind', Thread.shape.anchor.unwrap().shape.kind.options, () => columnValues('threads', 'anchor_kind')],
    ['ThreadParticipant.role ↔ thread_participants.role', ThreadParticipant.shape.role.options, () => columnValues('thread_participants', 'role')],
    ['Trust (minus owner_instruction) ↔ messages.trust', Trust.options.filter((t) => t !== 'owner_instruction'), () => columnValues('messages', 'trust')],
    ['MessageIntent ↔ messages.intent', MessageIntent.options, () => columnValues('messages', 'intent')],
    ['Urgency ↔ messages.urgency', Urgency.options, () => columnValues('messages', 'urgency')],
    ['MessageState ↔ messages.state', MessageState.options, () => columnValues('messages', 'state')],
    ['DeliveryState ↔ message_deliveries.state', DeliveryState.options, () => columnValues('message_deliveries', 'state')],
    ['DeliveryPath ↔ message_deliveries.path', DeliveryPath.options, () => columnValues('message_deliveries', 'path')],
    ['VerifiedVia ↔ owner_instructions.verified_via', VerifiedVia.options, () => columnValues('owner_instructions', 'verified_via')],
    ['VerifiedVia ↔ owner_instructions.confirmed_via', VerifiedVia.options, () => columnValues('owner_instructions', 'confirmed_via')],
    ['DmPermission.subjectKind ↔ dm_permissions.subject_kind', DmPermission.shape.subjectKind.options, () => columnValues('dm_permissions', 'subject_kind')],
    ['DmPolicy ↔ dm_permissions.policy', DmPolicy.options, () => columnValues('dm_permissions', 'policy')],
    ['DmDelivery ↔ dm_permissions.delivery', DmDelivery.options, () => columnValues('dm_permissions', 'delivery')],
    ['EventType ↔ events.type', EventType.options, () => columnValues('events', 'type')],
    ['ReviewKind ↔ review_items.kind', ReviewKind.options, () => columnValues('review_items', 'kind')],
    ['ReviewState ↔ review_items.state', ReviewState.options, () => columnValues('review_items', 'state')],
    ['Decision ↔ review_items.decision', Decision.options, () => columnValues('review_items', 'decision')],
    ['DecidedVia ↔ review_items.decided_via', DecidedVia.options, () => columnValues('review_items', 'decided_via')],
    ['ReportReview.reason ↔ reports.reason', ReportReview.shape.reason.options, () => columnValues('reports', 'reason')],
    ['ReportReview.targetKind ↔ reports.target_kind', ReportReview.shape.targetKind.options, () => columnValues('reports', 'target_kind')],
    ['SuggestionKind ↔ setup_suggestions.kind', SuggestionKind.options, () => columnValues('setup_suggestions', 'kind')],
    ['EvidenceScope ↔ setup_suggestions.scope', EvidenceScope.options, () => columnValues('setup_suggestions', 'scope')],
    ['ChangeTarget ↔ change_requests.target', ChangeTarget.options, () => columnValues('change_requests', 'target')],
    ['ChangeRequestState ↔ change_requests.state', ChangeRequestState.options, () => columnValues('change_requests', 'state')],
    ['NotificationPrefs.batching ↔ notification_prefs.batching', NotificationPrefs.shape.batching.options, () => columnValues('notification_prefs', 'batching')],
  ];

  it.each(cases)('%s', (_name, schemaValues, sqlValues) => {
    expect(sorted(sqlValues())).toEqual(sorted(schemaValues));
  });

  it('ScreenLayer ↔ domain screen_layers (l0 required)', () => {
    const m = /create domain y_private\.screen_layers as text\[\]\s+check \(value @> array\['l0'\]::text\[\] and value <@ array\[([^\]]*)\]/.exec(SQL);
    expect(sorted(literals(m?.[1] ?? ''))).toEqual(sorted(ScreenLayer.options));
  });

  it('SenderRelationship ↔ dm_permissions relationship subjects', () => {
    const check = tableItems('dm_permissions').find((item) => item.includes('subject_id in ('));
    const m = /subject_id in \(([^)]*)\)/.exec(check ?? '');
    expect(sorted(literals(m?.[1] ?? ''))).toEqual(sorted(SenderRelationship.options));
  });

  it('ReportedOutcome ⊂ outcome_events.outcome (plus measured-only outcomes)', () => {
    const values = columnValues('outcome_events', 'outcome');
    for (const v of ReportedOutcome.options) expect(values).toContain(v);
    expect(sorted(values.filter((v) => !(ReportedOutcome.options as readonly string[]).includes(v)))).toEqual(
      ['kept_7d', 'rediscovered', 'rolled_back'],
    );
  });

  it('embedding columns are vector(384)', () => {
    const dims = [...SQL.matchAll(/vector\((\d+)\)/g)].map((m) => Number(m[1]));
    expect(dims.length).toBeGreaterThan(0);
    expect(new Set(dims)).toEqual(new Set([384]));
  });
});
