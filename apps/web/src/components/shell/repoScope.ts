import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect } from 'react'
import { HttpError } from '@/api/errors'
import type { TeamReposStatus } from '@/api/types'
import { useMe, useRepoStatus } from '@/api/queries'
import { matchRepo, parseRepo, REPO_ROUTES, setStoredRepo, useStoredRepo } from '@/lib/repoScope'

const onRepoRoute = (path: string) => (REPO_ROUTES as readonly string[]).includes(path)

const usePath = () => useRouterState({ select: (s) => s.location.pathname })
const useUrlRepo = () => useRouterState({ select: (s) => parseRepo((s.location.search as Record<string, unknown> | undefined)?.repo) })

/** The repo the viewer asked for: ?repo= on routes that take it, else the one remembered in this browser. */
export function useWantedRepo(): string | null {
  const path = usePath()
  const fromUrl = useUrlRepo()
  const stored = useStoredRepo()
  return (onRepoRoute(path) ? fromUrl : undefined) ?? stored
}

/**
 * The repo a page filters by: the wanted one when it is linked to the viewer's posting team, else
 * null (all repos). `ready` is false while that is still being checked, so a page never fetches the
 * unfiltered list first and then swaps it out.
 */
export function useRepoScope(): { repo: string | null; ready: boolean } {
  const want = useWantedRepo()
  const { data: me, isPending: mePending } = useMe()
  const slug = me?.postingTeam || null
  const status = useRepoStatus(slug)
  if (!want) return { repo: null, ready: true }
  if (mePending) return { repo: null, ready: false }
  if (!slug) return { repo: null, ready: true }
  if (status.isPending) return { repo: null, ready: false }
  return { repo: matchRepo(want, status.data?.repos.map((r) => r.repo) ?? []), ready: true }
}

/** Choose a repo (null = all): remembered in this browser and, on routes that filter by it, put in the URL. */
export function useSelectRepo(): (repo: string | null) => void {
  const nav = useNavigate()
  const path = usePath()
  return useCallback(
    (repo: string | null) => {
      if (!onRepoRoute(path)) return setStoredRepo(repo)
      // URL first, then storage: useRepoSync lets a linked ?repo= win, so in between it stores the
      // new choice too. The other order would let it see the old ?repo= and put that back.
      void nav({ to: '.', search: ((prev: Record<string, unknown>) => ({ ...prev, repo: repo ?? undefined })) as never, replace: true }).then(() =>
        setStoredRepo(repo),
      )
    },
    [nav, path],
  )
}

/**
 * Keeps the remembered choice and ?repo= in step once the linked repos are known, so the scope
 * follows the viewer across pages and a copied link keeps it:
 * - on Updates or Feed, a linked ?repo= becomes the remembered choice (the URL wins);
 * - a repo route opened without ?repo= gets the remembered one written in (replace, no history entry);
 * - a repo the team no longer links (or never did) is dropped from both: all repos.
 * Mounted once, in the signed-in shell.
 */
export function useRepoSync() {
  const nav = useNavigate()
  const path = usePath()
  const fromUrl = useUrlRepo()
  const stored = useStoredRepo()
  const { data: me } = useMe()
  const slug = me?.postingTeam || null
  const { data: status } = useRepoStatus(slug)
  // A stable value for the effect: the linked names, or null until this team's list is in.
  const linked = slug && status && status.team.slug === slug ? status.repos.map((r) => r.repo).join('\n') : null
  useEffect(() => {
    if (linked === null) return
    const plan = repoSyncPlan({ route: onRepoRoute(path), fromUrl, stored, linked: linked ? linked.split('\n') : [] })
    if (plan.store !== undefined) setStoredRepo(plan.store)
    if (plan.url !== undefined) {
      const repo = plan.url ?? undefined
      void nav({ to: '.', search: ((prev: Record<string, unknown>) => ({ ...prev, repo })) as never, replace: true })
    }
  }, [linked, path, fromUrl, stored, nav])
}

/**
 * What useRepoSync changes, given where the viewer is and the team's linked repos: the remembered
 * choice (`store`) and ?repo= (`url`, repo routes only); null clears, undefined leaves it alone.
 */
export function repoSyncPlan(o: { route: boolean; fromUrl: string | undefined; stored: string | null; linked: readonly string[] }): {
  store?: string | null
  url?: string | null
} {
  const match = matchRepo((o.route ? o.fromUrl : undefined) ?? o.stored, o.linked)
  return {
    ...(match !== o.stored ? { store: match } : {}),
    ...(o.route && o.fromUrl !== (match ?? undefined) ? { url: match } : {}),
  }
}

/** True when core answered a repo-scoped request with 404: the repo is no longer linked to the team. */
export const isRepoGone = (repo: string | null, error: unknown) => !!repo && error instanceof HttpError && error.status === 404

/**
 * A page's repo-scoped list came back 404 (the repo was unlinked, here or by another admin): fall back
 * to all repos and refresh the bar's list, instead of showing an error. Returns whether that is
 * happening, so the page can keep its skeleton up for the moment it takes.
 */
export function useRepoGone(repo: string | null, error: unknown): boolean {
  const gone = isRepoGone(repo, error)
  const qc = useQueryClient()
  useEffect(() => {
    if (!gone || !repo) return
    // Take it out of the cached list at once (useRepoSync then drops it from storage and ?repo=,
    // and the page refetches unfiltered), and fetch the real list behind it.
    qc.setQueriesData<TeamReposStatus>({ queryKey: ['repo-status'] }, (s) => (s ? withoutRepo(s, repo) : s))
    void qc.invalidateQueries({ queryKey: ['repo-status'] })
  }, [gone, repo, qc])
  return gone
}

/** The status without `repo` (GitHub names compare case-insensitively). */
export function withoutRepo(s: TeamReposStatus, repo: string): TeamReposStatus {
  const r = repo.toLowerCase()
  return { ...s, repos: s.repos.filter((x) => x.repo.toLowerCase() !== r) }
}

export { onRepoRoute }
