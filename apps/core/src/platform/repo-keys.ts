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
