/**
 * Hook context (dependencies injected so tests can run handlers in-process)
 * and the dispatcher used by `entries/hook.ts`.
 */
import {
  isChild,
  loadConfig,
  makeSpawnDetached,
  parseHookInput,
  paths,
  logLine,
  type Config,
  type FetchLike,
  type HookInput,
  type Paths,
  type SpawnDetached,
} from './runtime.js';

export interface HookCtx {
  env: NodeJS.ProcessEnv;
  config: Config;
  paths: Paths;
  input: HookInput;
  fetch: FetchLike;
  spawnDetached: SpawnDetached;
  now: () => number;
  /** Absolute ms epoch by which the handler must be done. */
  deadline: number;
}

export interface HookResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export const OK: HookResult = { exitCode: 0 };

export type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PostToolUseFailure' | 'Stop' | 'SessionEnd';

/** Internal deadlines per event (ms), measured from process start. */
export const DEADLINES: Record<HookEvent, number> = {
  SessionStart: 1200,
  UserPromptSubmit: 150,
  PostToolUseFailure: 1500,
  Stop: 20_000,
  SessionEnd: 200,
};

export interface CtxOverrides {
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  spawnDetached?: SpawnDetached;
  now?: () => number;
  startedAt?: number;
}

export function makeCtx(event: HookEvent, stdin: string, o: CtxOverrides = {}): HookCtx {
  const env = o.env ?? process.env;
  const config = loadConfig(env);
  const now = o.now ?? Date.now;
  const startedAt = o.startedAt ?? now();
  return {
    env,
    config,
    paths: paths(config.dataDir),
    input: parseHookInput(stdin),
    fetch: o.fetch ?? fetch,
    spawnDetached: o.spawnDetached ?? makeSpawnDetached(env),
    now,
    deadline: startedAt + DEADLINES[event],
  };
}

export function remaining(ctx: HookCtx): number {
  return ctx.deadline - ctx.now();
}

/** Every hook fails open: any throw becomes exit 0 with no output. */
export async function failOpen(ctx: HookCtx, name: string, fn: () => Promise<HookResult>): Promise<HookResult> {
  if (isChild(ctx.env)) return OK;
  try {
    return await fn();
  } catch (e) {
    logLine(ctx.config.dataDir, 'hook', `${name} failed: ${(e as Error)?.message ?? String(e)}`.slice(0, 500));
    return OK;
  }
}

/** JSON hook output with `hookSpecificOutput.additionalContext` (and optional systemMessage). */
export function contextOutput(event: string, additionalContext: string, systemMessage?: string): HookResult {
  const out: Record<string, unknown> = {};
  if (additionalContext) out.hookSpecificOutput = { hookEventName: event, additionalContext };
  if (systemMessage) out.systemMessage = systemMessage;
  if (Object.keys(out).length === 0) return OK;
  return { exitCode: 0, stdout: JSON.stringify(out) };
}
