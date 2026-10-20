import { useRouterState } from '@tanstack/react-router'
import { useMe, useRepoStatus } from '@/api/queries'
import { matchRepo, parseRepo, REPO_ROUTES, useStoredRepo } from '@/lib/repoScope'

const onRepoRoute = (path: string) => (REPO_ROUTES as readonly string[]).includes(path)

/** The repo the viewer asked for: ?repo= on routes that take it, else the one remembered in this browser. */
export function useWantedRepo(): string | null {
  const path = useRouterState({ select: (s) => s.location.pathname })
  const fromUrl = useRouterState({ select: (s) => parseRepo((s.location.search as Record<string, unknown> | undefined)?.repo) })
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

export { onRepoRoute }
