/**
 * UserPromptSubmit (sync, 150 ms, local only): emit P1/P4 for unread items
 * this session hasn't been pointed at yet, from `state/pulse.json`, plus a
 * wake the listener parked because the local wake budget was spent (that
 * pointer carries the sender/thread, so it replaces the count-only one).
 * The prompt is never read beyond the session id and never leaves the
 * machine. (The asyncRewake listener is armed by a separate hook entry.)
 */
import * as path from 'node:path';
import type { Pointer } from '@y/schema/pointers';
import { contextOutput, failOpen, OK, type HookCtx, type HookResult } from '../context.js';
import { readJson, safeSid, writeJsonAtomic } from '../runtime.js';
import { pushPathsAllowed, readBrief, readPulse, renderBlock } from '../state.js';
import { takePendingWake } from '../wake-budget.js';

interface Pointed {
  dm: number;
  ownerInstructions: number;
  /** Pulse cursor when these counts were seen. */
  cursor?: string;
}

const clamp = (n: number) => Math.min(999, Math.max(1, Math.floor(n)));

export function userPromptSubmit(ctx: HookCtx): Promise<HookResult> {
  return failOpen(ctx, 'UserPromptSubmit', async () => {
    const sid = typeof ctx.input.session_id === 'string' ? ctx.input.session_id : undefined;
    if (!sid) return OK;
    if (!pushPathsAllowed(readBrief(ctx.paths))) return OK;
    const parked = takePendingWake(ctx.paths, sid, ctx.now());
    const pulse = readPulse(ctx.paths);
    if (!pulse.unread) return parked ? contextOutput('UserPromptSubmit', renderBlock([parked], 400)) : OK;
    const file = path.join(ctx.paths.state, `pointed-${safeSid(sid)}.json`);
    const prev = readJson<Pointed>(file) ?? { dm: 0, ownerInstructions: 0 };
    const { dm, ownerInstructions } = pulse.unread;
    const pointers: Pointer[] = [];
    if (parked && ((parked.template_id === 'P1' && dm > 0) || (parked.template_id === 'P4' && ownerInstructions > 0))) {
      pointers.push(parked);
    }
    const has = (t: string) => pointers.some((p) => p.template_id === t);
    // The agent reads its inbox through MCP, which never lowers the local counts, so
    // read-one-then-get-one leaves the count unchanged. A moved cursor means new
    // agent events arrived since the last pointer: point again at whatever is unread.
    const moved = pulse.cursor !== undefined && pulse.cursor !== prev.cursor;
    if (dm > 0 && (dm > (prev.dm || 0) || moved) && !has('P1')) pointers.push({ template_id: 'P1', params: { count: clamp(dm) } });
    if (ownerInstructions > 0 && (ownerInstructions > (prev.ownerInstructions || 0) || moved) && !has('P4')) {
      pointers.push({ template_id: 'P4', params: { count: clamp(ownerInstructions) } });
    }
    // Counts that went down were read: lower the watermark so new items point again.
    writeJsonAtomic(file, { dm, ownerInstructions, ...(pulse.cursor ? { cursor: pulse.cursor } : {}) } satisfies Pointed);
    if (pointers.length === 0) return OK;
    return contextOutput('UserPromptSubmit', renderBlock(pointers, 400));
  });
}
