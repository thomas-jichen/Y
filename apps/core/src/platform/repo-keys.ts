/**
 * Linked repo names → the salted repo keys the plugin sends (packages/capture
 * segments.ts). The plugin computes `computeRepoKey(git remote, team salt)`
 * and uploads only the key; core computes the same key for each repo a team
 * linked (team_repos, `owner/repo`) from its canonical GitHub remote, so
 * `https://github.com/o/r(.git)`, `git@github.com:o/r.git` and
 * `ssh://git@github.com/o/r.git` remotes all match (normalizeGitRemote maps
 * them to `github.com/o/r`, lowercased). Keys and salts stay in core: routes
 * return repo names only.
 */
import { createHash } from 'node:crypto';
import { computeRepoKey } from '@y/capture';
import type { Tx } from '@y/db';
import { postingTeamId } from '../messaging/util.js';

/** The remote a linked GitHub repo is keyed from. */
export function canonicalGithubRemote(repo: string): string {
  return `https://github.com/${repo}.git`;
}

/** The repo key the plugin sends for a clone of `owner/repo` on GitHub under this team salt. */
export function teamRepoKey(repo: string, salt: string): string | undefined {
  return computeRepoKey(canonicalGithubRemote(repo), salt);
}

export interface KeyedRepo {
  repo: string;
  key: string;
}

/** A team's linked repos (name order) with their keys. Under the caller's RLS: members read both tables. */
export async function keyedTeamRepos(tx: Tx, teamId: string, limit: number): Promise<KeyedRepo[]> {
  const r = await tx.query<{ repo: string; salt: string | null }>(
    `select r.repo, s.repo_key_salt as salt
       from public.team_repos r left join public.team_secrets s on s.team_id = r.team_id
      where r.team_id = $1
      order by lower(r.repo) limit ${Math.max(1, Math.floor(limit))}`,
    [teamId],
  );
  const out: KeyedRepo[] = [];
  for (const row of r.rows) {
    const key = row.salt ? teamRepoKey(row.repo, row.salt) : undefined;
    if (key) out.push({ repo: row.repo, key });
  }
  return out;
}

/**
 * The key for `repo` in the caller's posting team, or null when they post to no
 * team or the team has not linked it (compared case-insensitively, as GitHub does).
 */
export async function postingTeamRepoKey(tx: Tx, userId: string, repo: string): Promise<{ teamId: string; key: string } | null> {
  const teamId = await postingTeamId(tx, userId);
  if (!teamId) return null;
  const r = await tx.query<{ repo: string; salt: string | null }>(
    `select r.repo, s.repo_key_salt as salt
       from public.team_repos r left join public.team_secrets s on s.team_id = r.team_id
      where r.team_id = $1 and lower(r.repo) = lower($2)
      limit 1`,
    [teamId, repo],
  );
  const row = r.rows[0];
  const key = row?.salt ? teamRepoKey(row.repo, row.salt) : undefined;
  return key ? { teamId, key } : null;
}

/** The repo-gating policy for one human's agents: their posting team's linked repo keys. */
export interface RepoPolicy {
  teamId: string | null;
  /** Salted keys of the repos linked to the posting team (empty: the agents post nothing). */
  keys: string[];
  /** Changes when the posting team or its linked repos change (brief/pulse `policyVersion`). */
  version: string;
}

/**
 * Agents post to Y only from repos linked to their posting team (repo gating). Computed as the
 * service role: keys and salts never leave core except as the agent's own allowed-key list.
 */
export async function repoPolicy(deps: { db: { asService<T>(fn: (tx: Tx) => Promise<T>): Promise<T> } }, userId: string): Promise<RepoPolicy> {
  return deps.db.asService(async (tx) => {
    const teamId = await postingTeamId(tx, userId);
    const keys = teamId ? (await keyedTeamRepos(tx, teamId, 100)).map((k) => k.key).sort() : [];
    const version = createHash('sha256').update(`${teamId ?? 'none'}|${keys.join(',')}`).digest('hex').slice(0, 16);
    return { teamId, keys, version };
  });
}

/** Whether repo gating is on for this core (Y_REPO_GATING=off turns it off; hand-built test configs leave it off). */
export function repoGatingOn(config: { repoGating?: boolean }): boolean {
  return config.repoGating === true;
}

/**
 * Whether the agent is working in a linked repo right now: an open session of its own, active in the
 * last 12 h, whose repo key is linked to the posting team. Sessions from unlinked repos never reach
 * core under gating, so any such session is one the plugin uploaded from a linked repo.
 */
export async function agentInLinkedRepo(deps: { db: { asService<T>(fn: (tx: Tx) => Promise<T>): Promise<T> } }, userId: string, agentId: string): Promise<boolean> {
  const policy = await repoPolicy(deps, userId);
  if (policy.keys.length === 0) return false;
  return deps.db.asService(async (tx) => (await tx.query(
    `select 1 from public.sessions
      where agent_id = $1 and status = 'open' and last_event_at > now() - interval '12 hours'
        and repo_key::text = any($2::text[])
      limit 1`,
    [agentId, policy.keys],
  )).rowCount > 0);
}

export const REPO_NOT_LINKED_MESSAGE =
  'this repo is not linked to your team, so your agent does not post to Y from it; a team admin can link it on the Team page in the Y web app';
