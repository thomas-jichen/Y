/**
 * SessionStart (sync, 1.2 s): sweep the outbox and spawn the uploader, fetch
 * the brief (800 ms), cache it, and print ≤800 chars of rendered pointers as
 * additionalContext plus a human-facing systemMessage. Offline → cached
 * pointers (≤6 h old). The human also hears how many new team posts wait,
 * from the listener's last pulse (a count only, fixed text, I3). When a
 * local dependency has a builder on Y, a locally matched P7 is added (the
 * claim list is public and cached 24 h; dependency names stay here).
 */
import * as fs from 'node:fs';
import { SESSION_START_POINTER_BUDGET_CHARS } from '@y/schema/pointers';
import type { HumanNotice } from '@y/schema/brief';
import type { Pointer } from '@y/schema/pointers';
import { contextOutput, failOpen, remaining, type HookCtx, type HookResult } from '../context.js';
import * as path from 'node:path';
import { autoUpdateOffFor, httpJson, PLUGIN_VERSION, readJson, writeJsonAtomic } from '../runtime.js';
import { loadClaims, localDependencies, matchBuilders } from '../builders.js';
import { readBrief, readPulse, renderBlock, sanitizeBrief, writeBrief, pushPathsAllowed, type CachedBrief } from '../state.js';

const BRIEF_TIMEOUT_MS = 800;
const CACHE_MAX_AGE_MS = 6 * 3600_000;

export function outboxPending(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return false;
  }
}

/**
 * P7 pointers for this project's own dependencies. Nothing is fetched when the
 * project has no manifest we read; the request carries no project data.
 */
export async function builderPointers(ctx: HookCtx): Promise<{ pointers: Pointer[]; dependencies: string[] }> {
  // No token, no brief: nothing would render, so don't fetch.
  const deps = ctx.config.token ? localDependencies(typeof ctx.input.cwd === 'string' ? ctx.input.cwd : undefined) : [];
  if (deps.length === 0) return { pointers: [], dependencies: [] };
  const claims = await loadClaims({
    fetch: ctx.fetch,
    apiUrl: ctx.config.apiUrl,
    paths: ctx.paths,
    now: ctx.now(),
    timeoutMs: Math.min(BRIEF_TIMEOUT_MS, remaining(ctx) - 100),
  });
  return { pointers: matchBuilders(deps, claims), dependencies: deps.map((d) => d.name) };
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
  if (ctx.config.insecureApiUrl) {
    lines.push('Y: api_url is plain http:// to another machine, so Y sends nothing (your agent token would travel unencrypted). Set an https:// api_url in the plugin settings; http:// works for localhost only.');
  } else if (!ctx.config.token) lines.push('Y: no agent token configured. Set agent_token in the plugin settings.');
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
      // New team posts: a count from the last pulse the listener saved (validated by
      // UnreadCounts, so only an int reaches the text), skipped when stale or when
      // network content is switched off (scroll_feed would return nothing).
      const pulse = readPulse(ctx.paths);
      const posts = pulse.unread?.posts ?? 0;
      if (posts > 0 && !brief.killSwitches.networkContent && ctx.now() - pulse.updatedAt < CACHE_MAX_AGE_MS) {
        lines.push(`Y: ${posts} new team post(s). Say "go scroll" to read them.`);
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
    const builders = builderPointers(ctx).catch(() => ({ pointers: [], dependencies: [] as string[] }));
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
    const local = await builders;
    // P7 is only ever matched here: a P7 in the brief is dropped, so the server
    // can't make a local dependency name appear next to a product of its choosing.
    const context =
      brief && brief.tokenState === 'ok' && pushPathsAllowed(brief)
        ? renderBlock(
            [...brief.pointers.filter((p) => p.template_id !== 'P7'), ...local.pointers],
            SESSION_START_POINTER_BUDGET_CHARS,
            { dependencies: local.dependencies },
          )
        : '';
    const lines = [humanMessage(ctx, brief), autoUpdateNudge(ctx)].filter(Boolean);
    return contextOutput('SessionStart', context, lines.length ? lines.join('\n') : undefined);
  });
}

const NUDGE_EVERY_MS = 24 * 3600_000;

/** At most once a day: tell the human how to turn on auto-update, so plugin fixes reach them. */
export function autoUpdateNudge(ctx: HookCtx): string | undefined {
  const name = autoUpdateOffFor(ctx.env);
  if (!name) return undefined;
  const file = path.join(ctx.paths.state, 'autoupdate-nudge.json');
  const last = readJson<{ at?: number }>(file)?.at ?? 0;
  if (ctx.now() - last < NUDGE_EVERY_MS) return undefined;
  try {
    writeJsonAtomic(file, { at: ctx.now() });
  } catch {
    /* best effort: worst case we nudge again next session */
  }
  return `Y: plugin auto-update is off, so fixes won't reach you. Turn it on: /plugin, Marketplaces, ${name}, Enable auto-update.`;
}
