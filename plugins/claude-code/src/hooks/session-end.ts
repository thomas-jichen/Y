/**
 * SessionEnd (sync, <200 ms; the harness gives plugins 1.5 s total): write a
 * close-marker chunk and spawn the detached `uploader --final`. No network.
 */
import { PermissionMode } from '@y/schema/common';
import { IngestChunk } from '@y/schema/ingest';
import { emptyStats } from '@y/schema/stats';
import { failOpen, OK, type HookCtx, type HookResult } from '../context.js';
import { writeChunk } from '../outbox.js';
import { allocSeq, PLUGIN_VERSION } from '../runtime.js';

export function sessionEnd(ctx: HookCtx): Promise<HookResult> {
  return failOpen(ctx, 'SessionEnd', async () => {
    const sid = typeof ctx.input.session_id === 'string' ? ctx.input.session_id : undefined;
    if (!sid || ctx.config.shareMode === 'off') return OK;
    const pm = PermissionMode.safeParse(ctx.input.permission_mode);
    const chunk = IngestChunk.safeParse({
      v: 1,
      harness: 'claude_code',
      harnessVersion: '0',
      pluginVersion: PLUGIN_VERSION,
      sessionId: sid,
      seq: allocSeq(ctx.paths, sid),
      segmentIndex: 0,
      statsDelta: emptyStats('0'),
      errorEpisodes: [],
      close: { reason: ctx.input.reason === 'clear' ? 'clear' : 'session_end' },
      headless: ctx.config.headless,
      permissionMode: pm.success ? pm.data : 'unknown',
      sentAt: new Date(ctx.now()).toISOString(),
    });
    if (chunk.success) writeChunk(ctx.paths, chunk.data, ctx.now());
    ctx.spawnDetached('uploader', ['--final']);
    return OK;
  });
}
