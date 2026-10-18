/** Process plumbing shared by the entry points: write the result and exit. */
import type { HookResult } from '../context.js';

export function finish(r: HookResult): never {
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exitCode = r.exitCode;
  // Flush stdio, then exit even if a stray handle (timer, socket) is open.
  process.stdout.write('', () => process.stderr.write('', () => process.exit(r.exitCode)));
  return undefined as never;
}
