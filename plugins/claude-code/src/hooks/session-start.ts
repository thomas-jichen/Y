/**
 * SessionStart (sync, 1.2 s): sweep the outbox and spawn the uploader, fetch
 * the brief (800 ms), cache it, and print ≤800 chars of rendered pointers as
 * additionalContext plus a human-facing systemMessage. Offline → cached
 * pointers (≤6 h old).
 */
import * as fs from 'node:fs';
import { SESSION_START_POINTER_BUDGET_CHARS } from '@y/schema/pointers';
import type { HumanNotice } from '@y/schema/brief';
import { contextOutput, failOpen, remaining, type HookCtx, type HookResult } from '../context.js';
import { httpJson, PLUGIN_VERSION } from '../runtime.js';
import { readBrief, renderBlock, sanitizeBrief, writeBrief, pushPathsAllowed, type CachedBrief } from '../state.js';

const BRIEF_TIMEOUT_MS = 800;
const CACHE_MAX_AGE_MS = 6 * 3600_000;

export function outboxPending(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return false;
  }
}

async function fetchBrief(ctx: HookCtx): Promise<CachedBrief | undefined> {
  if (!ctx.config.token) return undefined;
  const q = new URLSearchParams({ pluginVersion: PLUGIN_VERSION });
  if (ctx.input.session_id) q.set('sessionId', String(ctx.input.session_id).slice(0, 128));
  const timeoutMs = Math.min(BRIEF_TIMEOUT_MS, remaining(ctx) - 100);
  if (timeoutMs < 50) return undefined;
  try {
    const res = await httpJson(ctx.fetch, 'GET', `${ctx.config.apiUrl}/api/v1/agent/brief?${q}`, {
      token: ctx.config.token,
      timeoutMs,
    });
    if (res.status === 401 || res.status === 403) {
      return { fetchedAt: ctx.now(), tokenState: 'revoked', pointers: [], killSwitches: { pushPaths: false, networkContent: false, apply: false, ingest: false }, humanNotices: [] };
    }
    if (res.status < 200 || res.status >= 300) return undefined;
    return sanitizeBrief(res.body, ctx.now());
  } catch {
    return undefined;
  }
}

const NOTICE_TEXT: Record<HumanNotice['kind'], (n?: number) => string> = {
  drafts_pending: (n) => `${n ?? 'Some'} highlight draft(s) are waiting for your review`,
  reviews_pending: (n) => `${n ?? 'Some'} item(s) are waiting for your review`,
  token_revoked: () => "this agent's token was revoked; reconnect the agent",
  token_expired: () => "this agent's token expired; reconnect the agent",
  unknown_install: () => 'this install is not recognized; reconnect the agent',
  upgrade_required: () => 'please update the Y plugin',
  policy_pending: () => "your team's capture policy needs your acceptance",
  doctor_recommended: () => 'run /y:doctor to check your setup',
};

/** Keep only URLs on the configured Y host, reduced to origin + a plain path. */
export function safeNoticeUrl(raw: string, ctx: HookCtx): string | undefined {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    const allowed = new Set<string>([new URL(ctx.config.apiUrl).hostname]);
    if (ctx.env.Y_WEB_URL) allowed.add(new URL(ctx.env.Y_WEB_URL).hostname);
    if (!allowed.has(u.hostname)) return undefined;
    return /^[A-Za-z0-9/_.-]{0,200}$/.test(u.pathname) ? `${u.origin}${u.pathname}` : u.origin;
  } catch {
    return undefined;
  }
}

export function humanMessage(ctx: HookCtx, brief: CachedBrief | undefined): string | undefined {
  const lines: string[] = [];
  if (!ctx.config.token) lines.push('Y: no agent token configured. Set agent_token in the plugin settings.');
  if (brief) {
    for (const n of brief.humanNotices) {
      const url = safeNoticeUrl(n.url, ctx);
      if (!url) continue;
      lines.push(`Y: ${NOTICE_TEXT[n.kind](n.count)}: ${url}`);
    }
    // Unread DMs and owner instructions, for the human too: rendered locally from the same
    // validated pointer params the agent gets (counts and screened handles only, I3).
    if (brief.tokenState === 'ok' && pushPathsAllowed(brief)) {
      for (const p of brief.pointers) {
        if (p.template_id === 'P1' && p.params.count > 0) {
          const from = p.params.handle ? ` from ${p.params.handle}` : '';
          lines.push(`Y: ${p.params.count} unread DM(s)${from}. Claude will read them when you send your first message.`);
        } else if (p.template_id === 'P4' && p.params.count > 0) {
          lines.push(`Y: ${p.params.count} of your instruction(s) are waiting for Claude.`);
        }
      }
    }
    if (brief.tokenState !== 'ok' && lines.length === 0) {
      const kind = brief.tokenState === 'expired' ? 'token_expired' : brief.tokenState === 'unknown_install' ? 'unknown_install' : 'token_revoked';
      lines.push(`Y: ${NOTICE_TEXT[kind]()}.`);
    }
  }
  return lines.length ? lines.join('\n') : undefined;
}

export function sessionStart(ctx: HookCtx): Promise<HookResult> {
  return failOpen(ctx, 'SessionStart', async () => {
    if (outboxPending(ctx.paths.outbox)) ctx.spawnDetached('uploader', []);
    let brief = await fetchBrief(ctx);
    if (brief) {
      try {
        writeBrief(ctx.paths, brief);
      } catch {
        /* cache is best effort */
      }
    } else {
      const cached = readBrief(ctx.paths);
      if (cached && ctx.now() - cached.fetchedAt < CACHE_MAX_AGE_MS) brief = cached;
    }
    const context =
      brief && brief.tokenState === 'ok' && pushPathsAllowed(brief)
        ? renderBlock(brief.pointers, SESSION_START_POINTER_BUDGET_CHARS)
        : '';
    return contextOutput('SessionStart', context, humanMessage(ctx, brief));
  });
}
