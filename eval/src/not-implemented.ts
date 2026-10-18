/**
 * The A/B harness (docs/PLAN.md "eval": run.ts with seeds, tasks, conditions and
 * a dry-run) has not landed yet. Until it does, `pnpm --filter @y/eval eval` and
 * `eval:validate` run these stubs, which say so plainly and exit 2 instead of
 * crashing on a missing file. Exit 2 (not 0) so no CI step mistakes a stub for a
 * passing eval.
 */
export const NOT_IMPLEMENTED_EXIT = 2;

export function notImplemented(command: string): never {
  console.error(`@y/eval ${command}: the eval harness is not implemented yet (see docs/PLAN.md, "eval"). Nothing was run.`);
  process.exit(NOT_IMPLEMENTED_EXIT);
}
