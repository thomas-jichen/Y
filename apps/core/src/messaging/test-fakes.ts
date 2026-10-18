/**
 * Deterministic stand-ins for @paceline/safety, @paceline/domain and
 * @paceline/retrieval, used via vi.mock in this module's tests so they do not
 * depend on the parallel library implementations. Behaviour follows the
 * documented contracts closely enough for the routing tests.
 */
import { buildEnvelope, type EnvelopeParts, type Label, type MessageState, type ScreenAction } from '@paceline/schema';

const INJECTION = /ignore (all )?(previous|prior) instructions|disregard your system prompt/i;
const SECRET = /\b(ghp_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16}|sk-ant-[A-Za-z0-9_-]{20,})\b/;

function label(text: string): Label {
  if (/rm -rf \/|curl [^|]*\| *sh/.test(text)) return 'malicious';
  if (INJECTION.test(text)) return 'suspicious';
  return 'clean';
}

function actionFor(contentClass: string, l: Label) {
  const table: Record<Label, ScreenAction> = { clean: 'allow', warn: 'label', suspicious: 'quarantine', malicious: 'block', sensitive: 'hold_for_sender' };
  const action: ScreenAction = contentClass === 'dm_stranger' && l === 'clean' ? 'request_flow' : table[l];
  return { action, flagSender: l === 'malicious', notifyOwner: l === 'malicious', takedown: false, noPush: action !== 'allow' };
}

export const safety = {
  normalizeUntrusted: (text: string) => {
    const t = text.normalize('NFKC').replace(/[​-‏‪-‮⁠-⁤﻿]/g, '');
    return { text: t, removedInvisible: text.length - t.length, changed: t !== text };
  },
  l0Scan: (text: string) => ({ label: label(text), findings: [], needsL2: false, normalizedChanged: false }),
  actionFor,
  dlpScan: (body: string) => (SECRET.test(body) ? { ok: false, findings: [{ kind: 'secret', rule: 'secret.fake', start: 0, end: 1 }] } : { ok: true, findings: [] }),
  screen: async (item: { contentClass: string; contentId: string; text: string }) => {
    const l = label(item.text);
    const decision = actionFor(item.contentClass, l);
    const screen = { label: l, layers: ['l0'] as ['l0'] };
    return {
      verdict: { id: 'vd_x', contentClass: item.contentClass, contentId: item.contentId, l0: { label: l, findings: [], needsL2: false, normalizedChanged: false },
        l2: null, l2Error: null, label: l, decision, screen, latencyMs: 1, costUsd: 0, createdAt: new Date().toISOString() },
      decision, screen, normalized: { text: item.text, removedInvisible: 0, changed: false },
    };
  },
  makeEnvelope: <T>(parts: EnvelopeParts<T>) => buildEnvelope(parts),
};

type Ev = { type: string; permitted?: boolean; action?: ScreenAction };
function transition(state: MessageState, e: Ev): { ok: true; state: MessageState } | { ok: false; error: 'invalid_transition'; from: MessageState; event: string } {
  const verdict = (a: ScreenAction): MessageState => a === 'allow' || a === 'label' ? 'delivered' : a === 'request_flow' ? 'request_pending'
    : a === 'hold_for_sender' ? 'held_for_sender' : a === 'block' ? 'blocked' : 'quarantined';
  const ok = (s: MessageState) => ({ ok: true as const, state: s });
  if (state === 'queued' && e.type === 'submit') return ok(e.permitted ? 'screening' : 'request_pending');
  if ((state === 'queued' || state === 'screening') && e.type === 'l0_hold') return ok('held_for_sender');
  if (state === 'screening' && e.type === 'verdict') return ok(verdict(e.action!));
  if (state === 'request_pending' && e.type === 'verdict') { const v = verdict(e.action!); return ok(v === 'delivered' ? 'request_pending' : v); }
  if (state === 'request_pending' && e.type === 'request_accepted') return ok('screening');
  if (state === 'request_pending' && e.type === 'request_declined') return ok('rejected');
  if (state === 'quarantined' && e.type === 'release') return ok('released');
  if (state === 'released' && e.type === 'deliver') return ok('delivered');
  if ((state === 'quarantined' || state === 'held_for_sender') && e.type === 'reject') return ok('rejected');
  return { ok: false, error: 'invalid_transition', from: state, event: e.type };
}

const ORDER = ['pending', 'pointer_sent', 'seen', 'handled'];

export const domain = {
  LEASE_STALE_MS: 10 * 60 * 1000,
  LEASE_ACK_TIMEOUT_MS: 30_000,
  transition,
  deliveryTransition: (state: string, event: string) => {
    if (event === 'expire') return state === 'pending' || state === 'pointer_sent' ? { ok: true, state: 'expired' } : { ok: false, error: 'invalid_transition', from: state, event };
    if (state === 'expired') return { ok: false, error: 'invalid_transition', from: state, event };
    return ORDER.indexOf(event) >= ORDER.indexOf(state) ? { ok: true, state: event } : { ok: false, error: 'invalid_transition', from: state, event };
  },
  sendPrecheck: (s: string, isRequester: boolean) => s === 'paused_by_owner' ? 'PAUSED_BY_OWNER' : s === 'resolved' || s === 'archived' ? 'reopen'
    : s === 'request' ? (isRequester ? 'ok' : 'request_pending') : 'ok',
  dmDecision: (rel: string, p: { explicit: { policy: string; delivery: string }[]; urgency: string; recipientWakeOnDm: string; senderGithubAgeOk: boolean }) => {
    const first = p.explicit[0];
    const egress = rel !== 'self' && rel !== 'teammate';
    const base = { egress, bodyMax: egress ? 1000 : 4000 };
    if (first) {
      if (first.policy === 'deny') return { ...base, outcome: 'deny', delivery: null };
      if (first.policy === 'request') return { ...base, outcome: 'request', delivery: null };
      return { ...base, outcome: 'deliver', delivery: first.delivery === 'wake' && p.urgency !== 'wake' ? 'next_turn' : first.delivery };
    }
    if (rel === 'self') return { ...base, outcome: 'deliver', delivery: p.urgency === 'wake' && p.recipientWakeOnDm !== 'off' ? 'wake' : 'next_turn' };
    if (rel === 'teammate') return { ...base, outcome: 'deliver', delivery: p.urgency === 'wake' && p.recipientWakeOnDm === 'teammates' ? 'wake' : 'next_turn' };
    if (rel === 'stranger') return { ...base, outcome: p.senderGithubAgeOk ? 'request' : 'deny', delivery: null };
    return { ...base, outcome: 'deliver', delivery: 'next_turn' };
  },
  pickLeaseSession: (sessions: { sessionId: string; listening: boolean; headless: boolean; lastHeartbeatAt: number; lastThreadIds: readonly string[] }[], ctx: { now: number; threadId?: string; exclude?: readonly string[] }) => {
    const ok = sessions.filter((s) => s.listening && !s.headless && ctx.now - s.lastHeartbeatAt <= 600_000 && !(ctx.exclude ?? []).includes(s.sessionId));
    ok.sort((a, b) => {
      const ta = ctx.threadId && a.lastThreadIds.includes(ctx.threadId) ? 1 : 0;
      const tb = ctx.threadId && b.lastThreadIds.includes(ctx.threadId) ? 1 : 0;
      return tb - ta || b.lastHeartbeatAt - a.lastHeartbeatAt || (a.sessionId < b.sessionId ? -1 : 1);
    });
    return ok[0]?.sessionId ?? null;
  },
  wakeBudget: (ledger: { at: number }[], req: { at: number }) => {
    const recent = ledger.find((l) => req.at - l.at < 20_000);
    return recent ? { allow: false, reason: 'coalesced', coalesceWith: recent } : { allow: true, reason: 'ok' };
  },
};

export const retrieval = {
  THRESHOLDS: { search: 0.25, push: 0.6, duplicateCosine: 0.88, duplicateTrigram: 0.6, segmentCentroid: 0.82 },
  toPgVector: (v: ArrayLike<number>) => `[${Array.from(v).join(',')}]`,
  finalScore: (i: { rrf: number; listCount: number; quality: number; cosine?: number; k?: number }) => {
    const base = i.rrf / (i.listCount / ((i.k ?? 60) + 1));
    const rel = i.cosine === undefined ? base : 0.5 * base + 0.5 * Math.max(0, i.cosine);
    return Math.max(0, Math.min(1, rel * (0.75 + 0.25 * i.quality)));
  },
};
