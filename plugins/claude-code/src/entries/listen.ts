/**
 * `node scripts/dist/listen.mjs listen`: the asyncRewake listener hook
 * (SessionStart, UserPromptSubmit). Exit 2 + stderr (a rendered pointer)
 * wakes the session; everything else exits 0.
 *
 * `node scripts/dist/listen.mjs mark`: the synchronous Stop hook. Records
 * "needs listener" when none is live; never spawns, never re-arms.
 */
import { makeCtx, OK } from '../context.js';
import { listen, markNeedsListener } from '../listener.js';
import { isChild, readStdin } from '../runtime.js';
import { finish } from './io.js';

async function main(): Promise<void> {
  if (isChild(process.env)) return finish(OK);
  const mode = process.argv[2];
  if (mode === 'mark') {
    const ctx = makeCtx('Stop', await readStdin(300));
    return finish(await markNeedsListener(ctx));
  }
  const stdin = await readStdin(500);
  const ctx = makeCtx('Stop', stdin);
  ctx.deadline = Number.MAX_SAFE_INTEGER;
  finish(await listen(ctx));
}

main().catch(() => process.exit(0));
