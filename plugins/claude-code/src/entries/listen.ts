/**
 * `node scripts/dist/listen.mjs listen`: the asyncRewake listener hook.
 * Exit 2 + stderr (a rendered pointer) wakes the session; everything else exits 0.
 */
import { makeCtx, OK } from '../context.js';
import { listen } from '../listener.js';
import { isChild, readStdin } from '../runtime.js';
import { finish } from './io.js';

async function main(): Promise<void> {
  if (isChild(process.env)) return finish(OK);
  const stdin = await readStdin(500);
  const ctx = makeCtx('Stop', stdin);
  ctx.deadline = Number.MAX_SAFE_INTEGER;
  finish(await listen(ctx));
}

main().catch(() => process.exit(0));
