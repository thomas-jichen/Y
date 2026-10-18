/**
 * Session leases and the wake budget (PLAN §9).
 */
import { isUnattendedPermissionMode } from '@paceline/schema';
import type { PermissionMode, QuietHours } from '@paceline/schema';

/* ================================================================ leases */

/** A wake that isn't acked within 30 s moves to the next candidate. */
export const LEASE_ACK_TIMEOUT_MS = 30_000;
/**
 * Sessions without a heartbeat for 70 s are not wake candidates. The idle
 * listener long-polls `/api/v1/pulse` (≤ 25 s per poll) and each poll
 * refreshes the lease, so 70 s tolerates two missed polls.
 */
export const LEASE_STALE_MS = 70_000;

/** A listening session (from `session_leases`). */
export interface LeaseCandidate {
  sessionId: string;
  listening: boolean;
  /** Listener armed but doctor allow rules missing (a woken session would stall). */
  needsApproval: boolean;
  lastHeartbeatAt: number;
  repoKey?: string;
  lastThreadIds: readonly string[];
  permissionMode: PermissionMode;
  headless: boolean;
}

/** Context for {@link pickLeaseSession}. */
export interface LeaseContext {
  now: number;
  threadId?: string;
  repoKey?: string;
  /** Sessions already tried for this wake. */
  exclude?: readonly string[];
  /** Owner instructions never wake unattended sessions without a confirm click. */
  kind: 'dm' | 'owner_instruction';
  ownerConfirmed?: boolean;
  /** Override {@link LEASE_STALE_MS}. */
  staleMs?: number;
}

/**
 * Pick the **one** session to wake. Eligible: `listening`, not `headless`,
 * heartbeat within {@link LEASE_STALE_MS} (strictly younger), not excluded,
 * and for `owner_instruction` not in an unattended permission mode unless
 * `ownerConfirmed`. Order: thread affinity (`threadId` in `lastThreadIds`),
 * then repo affinity, then sessions without `needsApproval`, then most
 * recent heartbeat, then `sessionId` ascending. `null` when none.
 */
export function pickLeaseSession(sessions: readonly LeaseCandidate[], ctx: LeaseContext): string | null {
  const staleMs = ctx.staleMs ?? LEASE_STALE_MS;
  const exclude = new Set(ctx.exclude ?? []);
  const eligible = sessions.filter(
    (s) =>
      s.listening &&
      !s.headless &&
      ctx.now - s.lastHeartbeatAt < staleMs &&
      !exclude.has(s.sessionId) &&
      !(ctx.kind === 'owner_instruction' && isUnattendedPermissionMode(s.permissionMode) && !ctx.ownerConfirmed),
  );
  if (eligible.length === 0) return null;
  const threadHit = (s: LeaseCandidate) => (ctx.threadId !== undefined && s.lastThreadIds.includes(ctx.threadId) ? 1 : 0);
  const repoHit = (s: LeaseCandidate) => (ctx.repoKey !== undefined && s.repoKey === ctx.repoKey ? 1 : 0);
  const sorted = [...eligible].sort(
    (a, b) =>
      threadHit(b) - threadHit(a) ||
      repoHit(b) - repoHit(a) ||
      Number(a.needsApproval) - Number(b.needsApproval) ||
      b.lastHeartbeatAt - a.lastHeartbeatAt ||
      (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0),
  );
  return sorted[0]?.sessionId ?? null;
}

/* ========================================================== wake budget */

/** Wake budget limits (PLAN §9). */
export const WAKE_LIMITS = {
  recipientPerHour: 6,
  recipientPerDay: 30,
  senderPerHour: 3,
  coalesceMs: 20_000,
} as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A past wake (`wake_ledger`). */
export interface WakeLedgerEntry {
  at: number;
  recipientAgentId: string;
  senderAgentId: string;
  threadId?: string;
}

/** A requested wake. */
export interface WakeRequest {
  at: number;
  recipientAgentId: string;
  senderAgentId: string;
  threadId?: string;
  quietHours?: QuietHours | null;
}

/** Decision of {@link wakeBudget}. Anything not allowed becomes next-turn delivery. */
export interface WakeBudgetDecision {
  allow: boolean;
  reason: 'ok' | 'coalesced' | 'quiet_hours' | 'recipient_hour' | 'recipient_day' | 'sender_hour';
  /** For `coalesced`: the earlier wake that covers this one. */
  coalesceWith?: WakeLedgerEntry;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/** Local weekday (0 = Sunday) and minutes since local midnight of `at` in `timezone`. */
function localTime(at: number, timezone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
}

/**
 * Whether `at` falls inside quiet hours. Windows are `[start, end)` in local
 * time and may cross midnight; for a crossing window, `days` refers to the
 * day the window **started** (Fri 22:00–07:00 covers Saturday 03:00).
 * `start === end` means no quiet hours. An invalid time zone fails closed
 * (treated as quiet: the wake becomes next-turn).
 */
export function inQuietHours(at: number, qh: QuietHours): boolean {
  const start = minutesOf(qh.start);
  const end = minutesOf(qh.end);
  if (start === end) return false;
  let local: { day: number; minutes: number };
  try {
    local = localTime(at, qh.timezone);
  } catch {
    return true;
  }
  const dayOk = (d: number) => !qh.days || qh.days.length === 0 || qh.days.includes(d);
  if (start < end) return local.minutes >= start && local.minutes < end && dayOk(local.day);
  if (local.minutes >= start) return dayOk(local.day);
  if (local.minutes < end) return dayOk((local.day + 6) % 7);
  return false;
}

/**
 * Check a wake against the ledger, in this order: coalesce with a wake to
 * the same recipient within `coalesceMs` → `coalesced`; inside quiet hours
 * (evaluated in `quietHours.timezone`, windows may cross midnight, optional
 * `days` 0 = Sunday) → `quiet_hours`; recipient ≥ 6 in the last hour →
 * `recipient_hour`; ≥ 30 in the last 24 h → `recipient_day`; sender ≥ 3 to
 * anyone in the last hour → `sender_hour`; else `ok`. Ledger entries in the
 * future of `request.at` are ignored.
 */
export function wakeBudget(ledger: readonly WakeLedgerEntry[], request: WakeRequest): WakeBudgetDecision {
  const past = ledger.filter((e) => e.at <= request.at);
  const toRecipient = past.filter((e) => e.recipientAgentId === request.recipientAgentId);
  const recent = toRecipient
    .filter((e) => request.at - e.at < WAKE_LIMITS.coalesceMs)
    .sort((a, b) => b.at - a.at)[0];
  if (recent) return { allow: false, reason: 'coalesced', coalesceWith: recent };
  if (request.quietHours && inQuietHours(request.at, request.quietHours)) return { allow: false, reason: 'quiet_hours' };
  if (toRecipient.filter((e) => request.at - e.at < HOUR_MS).length >= WAKE_LIMITS.recipientPerHour) return { allow: false, reason: 'recipient_hour' };
  if (toRecipient.filter((e) => request.at - e.at < DAY_MS).length >= WAKE_LIMITS.recipientPerDay) return { allow: false, reason: 'recipient_day' };
  const fromSender = past.filter((e) => e.senderAgentId === request.senderAgentId && request.at - e.at < HOUR_MS);
  if (fromSender.length >= WAKE_LIMITS.senderPerHour) return { allow: false, reason: 'sender_hour' };
  return { allow: true, reason: 'ok' };
}
