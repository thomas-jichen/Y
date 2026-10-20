/**
 * Repo gating: agents post to Y only from repos linked to their team. The brief's
 * `policy.allowedRepoKeys` lists the salted keys of those repos; a session whose
 * repo key is not in it (or that has no git remote) uploads nothing at all: no
 * chunks, stats, digests or error matches. A brief without the field comes from
 * an older core without gating, which keeps the old behaviour.
 */
import { computeRepoKey } from '@y/capture';
import { gitRemote } from './redaction.js';
import { httpJson, PLUGIN_VERSION, type FetchLike } from './runtime.js';
import { sanitizeBrief, writeBrief, type CachedBrief } from './state.js';
import type { Paths } from './runtime.js';

/** The session's repo key under the brief's team salt, from the git remote of `cwd`. */
export function sessionRepoKey(brief: CachedBrief | undefined, cwd: string | undefined): string | undefined {
  const salt = brief?.policy?.repoKeySalt;
  const remote = gitRemote(cwd);
  if (!salt || !remote) return undefined;
  try {
    return computeRepoKey(remote, salt);
  } catch {
    return undefined;
  }
}

/** Whether a session with this repo key may send anything to Y. */
export function repoAllowed(brief: CachedBrief | undefined, repoKey: string | undefined): boolean {
  const allowed = brief?.policy?.allowedRepoKeys;
  if (allowed === undefined) return true;
  return !!repoKey && allowed.includes(repoKey);
}

/** Re-fetch and cache the brief (the pulse said the team's repo policy changed). */
export async function refreshBrief(ctx: { fetch: FetchLike; config: { apiUrl: string; token?: string }; paths: Paths; now: () => number }): Promise<boolean> {
  if (!ctx.config.token) return false;
  try {
    const res = await httpJson(ctx.fetch, 'GET', `${ctx.config.apiUrl}/api/v1/agent/brief?${new URLSearchParams({ pluginVersion: PLUGIN_VERSION })}`, {
      token: ctx.config.token,
      timeoutMs: 5_000,
    });
    if (res.status < 200 || res.status >= 300) return false;
    const b = sanitizeBrief(res.body, ctx.now());
    if (!b || b.tokenState !== 'ok') return false;
    writeBrief(ctx.paths, b);
    return true;
  } catch {
    return false;
  }
}
