/**
 * Local state: the sanitized brief cache, pulse state, and the only way this
 * plugin turns pointers into text (I3). Server responses are validated field
 * by field so one hostile entry can't take the whole response down, and
 * nothing but rendered templates ever reaches a push path.
 */
import { BriefPolicy, HumanNotice, TokenState, PulseToken } from '@y/schema/brief';
import { KillSwitches } from '@y/schema/common';
import { RealtimeChannel } from '@y/schema/hosting';
import { Pointer } from '@y/schema/pointers';
import { UnreadCounts } from '@y/schema/pulse';
import { FALLBACK_POINTER_TEXT, isRenderedPointer, renderPointer, type PointerLocals } from '@y/pointers';
import { readJson, writeJsonAtomic, type Paths } from './runtime.js';

/** The brief as cached in `state/brief.json` (only validated fields). */
export interface CachedBrief {
  fetchedAt: number;
  tokenState: TokenState;
  pointers: Pointer[];
  killSwitches: KillSwitches;
  policy?: LocalPolicy;
  humanNotices: HumanNotice[];
  pulseToken?: PulseToken;
  /** The agent's broadcast channel (serverless doorbell for the listener). */
  realtime?: RealtimeChannel;
}

/**
 * The policy fields the plugin acts on. Parsed from `BriefPolicy`'s own field
 * schemas so a newer server adding policy fields doesn't turn capture off.
 */
export interface LocalPolicy {
  capture: BriefPolicy['capture'];
  repoKeySalt?: string;
}

function parsePolicy(raw: unknown): LocalPolicy | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const capture = BriefPolicy.shape.capture.safeParse(r.capture);
  if (!capture.success) return undefined;
  const salt = BriefPolicy.shape.repoKeySalt.safeParse(r.repoKeySalt);
  return { capture: capture.data, ...(salt.success && salt.data ? { repoKeySalt: salt.data } : {}) };
}

/** Fail safe: if kill switches can't be read, treat every switch as engaged. */
const ALL_ENGAGED: KillSwitches = { pushPaths: true, networkContent: true, apply: true, ingest: true };

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Validate a raw brief response field by field. Returns undefined if it isn't a v1 brief at all. */
export function sanitizeBrief(raw: unknown, now: number): CachedBrief | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return undefined;
  const tokenState = TokenState.safeParse(r.tokenState);
  if (!tokenState.success) return undefined;
  const ks = KillSwitches.safeParse(r.killSwitches);
  const policy = parsePolicy(r.policy);
  const pulseToken = PulseToken.safeParse(r.pulseToken);
  const realtime = RealtimeChannel.safeParse(r.realtime);
  const pointers =
    tokenState.data === 'ok'
      ? arr(r.pointers)
          .slice(0, 10)
          .flatMap((p) => {
            const v = Pointer.safeParse(p);
            return v.success ? [v.data] : [];
          })
      : [];
  const humanNotices = arr(r.humanNotices)
    .slice(0, 5)
    .flatMap((n) => {
      const v = HumanNotice.safeParse(n);
      return v.success ? [v.data] : [];
    });
  return {
    fetchedAt: now,
    tokenState: tokenState.data,
    pointers,
    killSwitches: ks.success ? ks.data : ALL_ENGAGED,
    ...(policy ? { policy } : {}),
    humanNotices,
    ...(pulseToken.success ? { pulseToken: pulseToken.data } : {}),
    ...(realtime.success && tokenState.data === 'ok' ? { realtime: realtime.data } : {}),
  };
}

export function readBrief(p: Paths): CachedBrief | undefined {
  const b = readJson<CachedBrief>(p.brief);
  // Re-sanitize the cache too: the file is local but may be stale or hand-edited.
  if (!b || typeof b.fetchedAt !== 'number') return undefined;
  const again = sanitizeBrief({ ...b, v: 1 }, b.fetchedAt);
  return again;
}

export function writeBrief(p: Paths, b: CachedBrief): void {
  writeJsonAtomic(p.brief, b);
}

/** Capture is on only when a brief said so (no brief = stats only, nothing else leaves). */
export function captureOn(b: CachedBrief | undefined): boolean {
  return !!b && b.tokenState === 'ok' && b.policy?.capture === 'on' && !b.killSwitches.ingest;
}

export function pushPathsAllowed(b: CachedBrief | undefined): boolean {
  return !b || !b.killSwitches.pushPaths;
}

/* ================================================================ pulse */

/** `state/pulse.json`. */
export interface PulseState {
  cursor?: string;
  unread?: UnreadCounts;
  /** Total unread from the last ingest/heartbeat response (no per-kind split). */
  unreadTotal?: number;
  updatedAt: number;
}

export function readPulse(p: Paths): PulseState {
  const s = readJson<PulseState>(p.pulse);
  if (!s || typeof s !== 'object') return { updatedAt: 0 };
  const unread = UnreadCounts.safeParse(s.unread);
  return {
    ...(typeof s.cursor === 'string' && /^[A-Za-z0-9_\-.~=]{1,512}$/.test(s.cursor) ? { cursor: s.cursor } : {}),
    ...(unread.success ? { unread: unread.data } : {}),
    ...(Number.isInteger(s.unreadTotal) && (s.unreadTotal as number) >= 0 ? { unreadTotal: s.unreadTotal } : {}),
    updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : 0,
  };
}

export function updatePulse(p: Paths, patch: Partial<PulseState>, now: number): void {
  const cur = readPulse(p);
  writeJsonAtomic(p.pulse, { ...cur, ...patch, updatedAt: now });
}

/* ============================================================== render */

/**
 * Render one pointer for a push path. The pointer is re-validated against the
 * strict schema, rendered from the local template, and the result checked
 * against the template grammar. Anything that fails yields null.
 */
export function renderOne(pointer: unknown, locals?: PointerLocals): string | null {
  const v = Pointer.safeParse(pointer);
  if (!v.success) return null;
  try {
    const text = renderPointer(v.data, locals);
    if (typeof text !== 'string' || !isRenderedPointer(text)) return null;
    return text;
  } catch {
    return null;
  }
}

const PRIORITY = ['P4', 'P1', 'P9', 'P2', 'P3', 'P8', 'P5', 'P6', 'P7', 'P0'];

/**
 * Render pointers into one block within `budgetChars`: priority order,
 * de-duplicated, P0 dropped when anything else is present. Each line is
 * rendered and grammar-checked individually (we don't trust a joined block).
 */
export function renderBlock(pointers: readonly unknown[], budgetChars: number, locals?: PointerLocals): string {
  const valid = pointers.flatMap((p) => {
    const v = Pointer.safeParse(p);
    return v.success ? [v.data] : [];
  });
  const hasOther = valid.some((p) => p.template_id !== 'P0');
  const sorted = valid
    .filter((p) => !(hasOther && p.template_id === 'P0'))
    .map((p, i) => ({ p, i }))
    .sort((a, b) => PRIORITY.indexOf(a.p.template_id) - PRIORITY.indexOf(b.p.template_id) || a.i - b.i);
  const lines: string[] = [];
  let used = 0;
  for (const { p } of sorted) {
    const text = renderOne(p, locals);
    if (!text || lines.includes(text)) continue;
    const add = text.length + (lines.length ? 1 : 0);
    if (used + add > budgetChars) continue;
    lines.push(text);
    used += add;
  }
  return lines.join('\n');
}

/** The fixed fallback (local constant, safe on any push path). */
export function fallbackText(): string {
  return FALLBACK_POINTER_TEXT;
}
