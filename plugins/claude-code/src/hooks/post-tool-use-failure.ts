/**
 * PostToolUseFailure (`Bash|mcp__.*`, sync, 1.5 s): when capture is on,
 * normalize + redact the error, `POST /api/v1/hook/match`, print a rendered
 * P2 when the match passes the score and trust gate, and append the episode
 * (redacted) for the next Stop chunk.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeErrorSignature } from '@paceline/capture';
import { HookMatchResponse } from '@paceline/schema/hook';
import type { ErrorEpisode } from '@paceline/schema/ingest';
import { contextOutput, failOpen, OK, remaining, type HookCtx, type HookResult } from '../context.js';
import { redactText } from '../redaction.js';
import { ensureDir, httpJson, safeSid } from '../runtime.js';
import { captureOn, pushPathsAllowed, readBrief, renderOne } from '../state.js';

/** Minimum score to push (THRESHOLDS.push in retrieval). */
const PUSH_SCORE = 0.6;

/** Local trust gate: teammates/contacts/self at ≥0.6; public authors need ≥0.8. */
export function trustGate(m: NonNullable<HookMatchResponse['match']>): boolean {
  if (m.score < PUSH_SCORE) return false;
  if (m.authorTrust === 'public') return m.score >= 0.8;
  return true;
}

export function errorText(input: HookCtx['input']): string {
  const pick = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const k of ['error', 'stderr', 'message', 'output', 'stdout', 'content']) {
        if (typeof o[k] === 'string' && o[k]) return o[k] as string;
      }
      try {
        return JSON.stringify(v);
      } catch {
        return '';
      }
    }
    return '';
  };
  return (pick(input.error) || pick(input.tool_response)).slice(0, 20_000);
}

/** Tool name as a StatKey. */
export function toolKey(name: unknown): string {
  const s = typeof name === 'string' ? name.replace(/[^A-Za-z0-9_.:@/+#-]/g, '_').slice(0, 128) : '';
  return s || 'unknown';
}

export function episodesFile(ctx: HookCtx, sid: string): string {
  return path.join(ctx.paths.episodes, `${safeSid(sid)}.jsonl`);
}

export function postToolUseFailure(ctx: HookCtx): Promise<HookResult> {
  return failOpen(ctx, 'PostToolUseFailure', async () => {
    const sid = typeof ctx.input.session_id === 'string' ? ctx.input.session_id : undefined;
    if (!sid) return OK;
    const brief = readBrief(ctx.paths);
    if (ctx.config.shareMode === 'off' || !captureOn(brief)) return OK;
    const raw = errorText(ctx.input);
    if (!raw) return OK;
    const cwd = typeof ctx.input.cwd === 'string' ? ctx.input.cwd : undefined;
    // Redact the raw text first: normalizing first would mangle secrets
    // (digits → <n>) so the secret rules no longer match. Then normalize and
    // redact again (redaction is idempotent; this catches identity terms).
    const pre = redactText(raw, cwd);
    if (pre.dropped) return OK;
    const sig = redactText(normalizeErrorSignature(pre.text), cwd);
    if (sig.dropped || !sig.text.trim()) return OK;
    const signature = sig.text.slice(0, 300);
    const tool = toolKey(ctx.input.tool_name);

    // Record the episode first (local) so it survives a slow or failed match.
    const ep: ErrorEpisode = { signature, tool, excerpt: pre.text.slice(0, 800) };
    ensureDir(ctx.paths.episodes);
    fs.appendFileSync(episodesFile(ctx, sid), `${JSON.stringify(ep)}\n`);

    if (!ctx.config.token || !pushPathsAllowed(brief)) return OK;
    const timeoutMs = remaining(ctx) - 100;
    if (timeoutMs < 50) return OK;
    const res = await httpJson(ctx.fetch, 'POST', `${ctx.config.apiUrl}/api/v1/hook/match`, {
      token: ctx.config.token,
      timeoutMs,
      body: { v: 1, harness: 'claude_code', sessionId: sid, signature, tool },
    });
    if (res.status < 200 || res.status >= 300) return OK;
    const parsed = HookMatchResponse.safeParse(res.body);
    const m = parsed.success ? parsed.data.match : null;
    if (!m || !trustGate(m)) return OK;
    const text = renderOne({
      template_id: 'P2',
      params: { highlight_id: m.highlightId, score: Math.round(m.score * 100), scope: m.scope },
    });
    return text ? contextOutput('PostToolUseFailure', text) : OK;
  });
}
