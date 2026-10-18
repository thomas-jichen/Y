/**
 * UserPromptSubmit (sync, 150 ms, local only): emit P1/P4 for unread items
 * this session hasn't been pointed at yet, from `state/pulse.json`. The
 * prompt is never read beyond the session id and never leaves the machine.
 */
import * as path from 'node:path';
import type { Pointer } from '@paceline/schema/pointers';
import { contextOutput, failOpen, OK, type HookCtx, type HookResult } from '../context.js';
import { readJson, safeSid, writeJsonAtomic } from '../runtime.js';
import { pushPathsAllowed, readBrief, readPulse, renderBlock } from '../state.js';

interface Pointed {
  dm: number;
  ownerInstructions: number;
}

const clamp = (n: number) => Math.min(999, Math.max(1, Math.floor(n)));

export function userPromptSubmit(ctx: HookCtx): Promise<HookResult> {
  return failOpen(ctx, 'UserPromptSubmit', async () => {
    const sid = typeof ctx.input.session_id === 'string' ? ctx.input.session_id : undefined;
    if (!sid) return OK;
    if (!pushPathsAllowed(readBrief(ctx.paths))) return OK;
    const pulse = readPulse(ctx.paths);
    if (!pulse.unread) return OK;
    const file = path.join(ctx.paths.state, `pointed-${safeSid(sid)}.json`);
    const prev = readJson<Pointed>(file) ?? { dm: 0, ownerInstructions: 0 };
    const { dm, ownerInstructions } = pulse.unread;
    const pointers: Pointer[] = [];
    if (dm > (prev.dm || 0)) pointers.push({ template_id: 'P1', params: { count: clamp(dm) } });
    if (ownerInstructions > (prev.ownerInstructions || 0)) {
      pointers.push({ template_id: 'P4', params: { count: clamp(ownerInstructions) } });
    }
    // Counts that went down were read: lower the watermark so new items point again.
    writeJsonAtomic(file, { dm, ownerInstructions } satisfies Pointed);
    if (pointers.length === 0) return OK;
    return contextOutput('UserPromptSubmit', renderBlock(pointers, 400));
  });
}
