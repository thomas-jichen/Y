import { useNavigate, useRouterState } from '@tanstack/react-router'
import { ChevronDown } from 'lucide-react'
import type { Me, TeamRepoStatus, TeamReposStatus } from '@/api/types'
import { useMe, useRepoStatus } from '@/api/queries'
import { fmtAgo } from '@/lib/format'
import { matchRepo, setStoredRepo } from '@/lib/repoScope'
import { onRepoRoute, useWantedRepo } from './repoScope'

/** Height the bar takes under the top nav (36 px pill + 8 px gap); pages add it to their top padding. */
export const REPO_BAR_OFFSET = '44px'

export type RepoBarModel =
  | { kind: 'bar'; team: string; repos: TeamRepoStatus[]; all: Omit<TeamRepoStatus, 'repo'>; selected: string | null }
  | { kind: 'link'; team: string }

/**
 * What the bar shows, if anything: nothing without a posting team or before its status loads; a
 * quiet "Link a repo" for owners and admins of a team with no linked repos (nothing for members);
 * else the selector, with the wanted repo when the team links it (else all repos).
 */
export function repoBarModel(me: Me | undefined, status: TeamReposStatus | undefined, want: string | null): RepoBarModel | null {
  const team = me?.postingTeam
  if (!team || !status || status.team.slug !== team) return null
  if (status.repos.length === 0) return status.viewerRole === 'owner' || status.viewerRole === 'admin' ? { kind: 'link', team } : null
  return { kind: 'bar', team, repos: status.repos, all: status.all, selected: matchRepo(want, status.repos.map((r) => r.repo)) }
}

/** "2 agents working · updated 5m ago" */
export function repoStatusLine(s: Omit<TeamRepoStatus, 'repo'>, now = Date.now()): string {
  const n = s.activeAgents
  const agents = n === 0 ? 'no agents working' : `${n} agent${n === 1 ? '' : 's'} working`
  if (!s.lastActivityAt) return `${agents} · no updates yet`
  const ago = fmtAgo(s.lastActivityAt, now)
  const updated = ago === 'now' ? 'updated just now' : /^\d+[mhd]$/.test(ago) ? `updated ${ago} ago` : `updated ${ago}`
  return `${agents} · ${updated}`
}

const ALL = ''

/** The pill itself. Pure: `onSelect` gets a linked repo name or null for all repos. */
export function RepoBarView({ model, onSelect, onLinkRepo, now }: { model: RepoBarModel; onSelect: (repo: string | null) => void; onLinkRepo: () => void; now?: number }) {
  if (model.kind === 'link') {
    return (
      <div className="pointer-events-none fixed inset-x-0 top-[80px] z-30 flex justify-center px-3">
        <div className="flex w-full max-w-[860px]">
          <a
            href={`/team?team=${encodeURIComponent(model.team)}`}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
              e.preventDefault()
              onLinkRepo()
            }}
            className="glass pointer-events-auto inline-flex h-9 items-center rounded-full px-4 text-ui text-text-2 hover:text-text hover:underline hover:decoration-1 hover:underline-offset-4"
          >
            Link a repo
          </a>
        </div>
      </div>
    )
  }
  const current = model.selected ? model.repos.find((r) => r.repo === model.selected) : undefined
  const line = repoStatusLine(current ?? model.all, now)
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[80px] z-30 flex justify-center px-3">
      <section aria-label="Repo" className="glass pointer-events-auto flex h-9 w-full max-w-[860px] items-center gap-2 rounded-full pl-4 pr-4 text-ui">
        <span className="relative inline-flex shrink-0 items-center">
          <select
            aria-label="Repo"
            value={model.selected ?? ALL}
            onChange={(e) => onSelect(e.target.value === ALL ? null : e.target.value)}
            className="max-w-[46vw] cursor-pointer appearance-none truncate bg-transparent pr-5 font-medium outline-none md:max-w-[320px] [&>option]:bg-page [&>option]:text-text"
          >
            <option value={ALL}>All repos</option>
            {model.repos.map((r) => (
              <option key={r.repo} value={r.repo}>
                {r.repo}
              </option>
            ))}
          </select>
          <ChevronDown aria-hidden size={14} strokeWidth={1.8} className="pointer-events-none absolute right-0 text-text-2" />
        </span>
        <span aria-hidden className="text-text-2">
          ·
        </span>
        <span role="status" className="min-w-0 truncate text-text-2 tnum">
          {line}
        </span>
      </section>
    </div>
  )
}

/** Data for the bar: the viewer's posting team's linked repos and what is happening in them. */
export function useRepoBar(): RepoBarModel | null {
  const { data: me } = useMe()
  const { data: status } = useRepoStatus(me?.postingTeam || null)
  const want = useWantedRepo()
  return repoBarModel(me, status, want)
}

/** The repo selector and status line under the top nav, on every signed-in page. */
export function RepoBar({ model }: { model: RepoBarModel }) {
  const nav = useNavigate()
  const path = useRouterState({ select: (s) => s.location.pathname })
  const select = (repo: string | null) => {
    setStoredRepo(repo)
    // Routes that filter by repo carry it in the URL too, so the page's link keeps the scope.
    if (onRepoRoute(path)) {
      void nav({ to: '.', search: ((prev: Record<string, unknown>) => ({ ...prev, repo: repo ?? undefined })) as never, replace: true })
    }
  }
  const linkRepo = () => void nav({ to: '/team', search: { team: model.team } })
  return <RepoBarView model={model} onSelect={select} onLinkRepo={linkRepo} />
}
