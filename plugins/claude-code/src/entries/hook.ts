/**
 * `node scripts/dist/hook.mjs <Event>`: the sync/async hook entry point.
 * Exits 0 immediately for Y_CHILD=1; fails open on every error.
 */
import { DEADLINES, makeCtx, OK } from '../context.js';
import { HANDLERS, isHookEvent } from '../hooks/index.js';
import { isChild, readStdin } from '../runtime.js';
import { finish } from './io.js';

async function main(): Promise<void> {
  const startedAt = Date.now();
  const event = process.argv[2];
  if (isChild(process.env) || !isHookEvent(event)) return finish(OK);
  // Hard stop: never hold the harness past the internal deadline (+ slack).
  setTimeout(() => process.exit(0), DEADLINES[event] + 300).unref();
  const stdin = await readStdin(Math.min(300, DEADLINES[event] / 2));
  const ctx = makeCtx(event, stdin, { startedAt });
  finish(await HANDLERS[event](ctx));
}

main().catch(() => process.exit(0));
