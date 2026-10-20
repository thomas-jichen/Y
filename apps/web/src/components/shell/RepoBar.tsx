import { useNavigate } from '@tanstack/react-router'
import { ChevronDown } from 'lucide-react'
import { useEffect } from 'react'
import type { Me, TeamRepoStatus, TeamReposStatus } from '@/api/types'
import { useMe, useRepoStatus, useSetPostingTeam } from '@/api/queries'
import { fmtAgo } from '@/lib/format'
import { matchRepo } from '@/lib/repoScope'
import { ui } from '@/lib/ui'
import { useSelectRepo, useWantedRepo } from './repoScope'

/** Height the bar takes under the top nav (36 px pill + 8 px gap); pages add it to their top padding. */
export const REPO_BAR_OFFSET = '44px'

/** A team the viewer can switch their agents to (shown only when they are on several). */
export type TeamChoice = { slug: string; name: string }

export type RepoBarModel =
  | { kind: 'bar'; team: string; teams?: TeamChoice[]; repos: TeamRepoStatus[]; all: Omit<TeamRepoStatus, 'repo'>; selected: string | null }
  | { kind: 'link'; team: string; teams?: TeamChoice[] }
  | { kind: 'notice'; team: string; teams?: TeamChoice[] }

/**
 * What the bar shows, if anything: nothing without a posting team or before its status loads. A team
 * with no linked repos gets "Link your first repo" for owners and admins and a notice for members
 * (agents post nothing to Y until a repo is linked). Else the selector, with the wanted repo when the
 * team links it (else all repos). Viewers on several teams also get the team switcher (`teams`).
 */
export function repoBarModel(me: Me | undefined, status: TeamReposStatus | undefined, want: string | null): RepoBarModel | null {
  const team = me?.postingTeam
  if (!team || !status || status.team.slug !== team) return null
  const mine = me?.teams ?? []
  const teams = mine.length > 0 ? { teams: mine.map((t) => ({ slug: t.slug, name: t.name })) } : {}
  if (status.repos.length === 0) {
    const admin = status.viewerRole === 'owner' || status.viewerRole === 'admin'
    return admin ? { kind: 'link', team, ...teams } : { kind: 'notice', team, ...teams }
  }
  return { kind: 'bar', team, ...teams, repos: status.repos, all: status.all, selected: matchRepo(want, status.repos.map((r) => r.repo)) }
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

/** "Team: acme" switcher: where the viewer's agents post (and what Y shows), plus "New team". */
/** The switcher's last option: start a team (opens the New team side sheet). */
export const NEW_TEAM = '__new__'

function TeamSwitch({ team, teams, onSwitchTeam, onNewTeam }: { team: string; teams: TeamChoice[]; onSwitchTeam: (slug: string) => void; onNewTeam: () => void }) {
  return (
    <>
      <span className="relative inline-flex shrink-0 items-center">
        <span className="mr-1.5 text-text-2">Team</span>
        <select
          aria-label="Team your agents use"
          value={team}
          onChange={(e) => {
            const v = e.target.value
            if (v === NEW_TEAM) onNewTeam()
            else if (v !== team) onSwitchTeam(v)
          }}
          className="max-w-[30vw] cursor-pointer appearance-none truncate bg-transparent pr-5 font-medium outline-none md:max-w-[200px] [&>option]:bg-page [&>option]:text-text"
        >
          {teams.map((t) => (
            <option key={t.slug} value={t.slug}>
              {t.slug}
            </option>
          ))}
          <option value={NEW_TEAM}>+ New team…</option>
        </select>
        <ChevronDown aria-hidden size={14} strokeWidth={1.8} className="pointer-events-none absolute right-0 text-text-2" />
      </span>
      <span aria-hidden className="text-text-2">
        ·
      </span>
    </>
  )
}

/** The pill itself. Pure: `onSelect` gets a linked repo name or null for all repos. */
export function RepoBarView({
  model,
  onSelect,
  onLinkRepo,
  onSwitchTeam = () => {},
  onNewTeam = () => {},
  now,
}: {
  model: RepoBarModel
  onSelect: (repo: string | null) => void
  onLinkRepo: () => void
  onSwitchTeam?: (slug: string) => void
  onNewTeam?: () => void
  now?: number
}) {
  const switcher = model.teams && model.teams.length > 0 ? <TeamSwitch team={model.team} teams={model.teams} onSwitchTeam={onSwitchTeam} onNewTeam={onNewTeam} /> : null
  if (model.kind === 'link' || model.kind === 'notice') {
    return (
      <div className="pointer-events-none fixed inset-x-0 top-[80px] z-30 flex justify-center px-3">
        <section aria-label="Repo scope" className="glass pointer-events-auto flex h-9 w-full max-w-[860px] items-center gap-2 rounded-full pl-4 pr-4 text-ui">
          {switcher}
          {model.kind === 'link' ? (
            <a
              href={`/team?team=${encodeURIComponent(model.team)}`}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
                e.preventDefault()
                onLinkRepo()
              }}
              className="min-w-0 truncate font-medium hover:underline hover:decoration-1 hover:underline-offset-4"
            >
              Link your first repo
              <span className="font-normal text-text-2"> · your agents aren’t posting to Y until you do</span>
            </a>
          ) : (
            <span className="min-w-0 truncate text-text-2">No repo linked yet, so your agents aren’t posting to Y. Ask a team admin to link one.</span>
          )}
        </section>
      </div>
    )
  }
  const current = model.selected ? model.repos.find((r) => r.repo === model.selected) : undefined
  const line = repoStatusLine(current ?? model.all, now)
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[80px] z-30 flex justify-center px-3">
      <section aria-label="Repo scope" className="glass pointer-events-auto flex h-9 w-full max-w-[860px] items-center gap-2 rounded-full pl-4 pr-4 text-ui">
        {switcher}
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
        {/* Plain text, not a live region: it changes on every poll and would be read out again and again. */}
        <span className="min-w-0 truncate text-text-2 tnum">
          {line}
        </span>
      </section>
    </div>
  )
}

const SHOWN_KEY = 'y.repoBar'

/** Whether the bar showed last time in this browser: '1', '0', or null when never recorded. */
function lastShown(): string | null {
  try {
    return localStorage.getItem(SHOWN_KEY)
  } catch {
    return null
  }
}

function rememberShown(shown: boolean) {
  try {
    localStorage.setItem(SHOWN_KEY, shown ? '1' : '0')
  } catch {
    /* storage unavailable: the next load may shift once */
  }
}

/**
 * Whether pages keep room for the bar. Once the outcome is known: exactly when it shows. While /me or
 * the repo status is still loading: when it is likely to show (it showed last time here, or, never
 * recorded, the viewer has a posting team), so pages don't jump 44 px when it lands.
 */
export function repoBarReserve(o: { model: RepoBarModel | null; pending: boolean; postingTeam: string | null | undefined; last: string | null }): boolean {
  if (o.model) return true
  if (!o.pending) return false
  if (o.last === '1') return true
  if (o.last === '0') return false
  return !!o.postingTeam
}

/** Data for the bar: the viewer's posting team's linked repos and what is happening in them. */
export function useRepoBar(): { model: RepoBarModel | null; reserve: boolean } {
  const { data: me, isPending: mePending } = useMe()
  const slug = me?.postingTeam || null
  const { data: status, isPending: statusPending } = useRepoStatus(slug)
  const want = useWantedRepo()
  const model = repoBarModel(me, status, want)
  const pending = mePending || (!!slug && statusPending)
  const shown = !!model
  useEffect(() => {
    if (!pending) rememberShown(shown)
  }, [pending, shown])
  return { model, reserve: repoBarReserve({ model, pending, postingTeam: slug, last: pending ? lastShown() : null }) }
}

/** The team switcher, repo selector and status line under the top nav, on every signed-in page. */
export function RepoBar({ model }: { model: RepoBarModel }) {
  const nav = useNavigate()
  const select = useSelectRepo()
  const setTeam = useSetPostingTeam()
  const linkRepo = () => void nav({ to: '/team', search: { team: model.team } })
  // Repo choices belong to the old team; the new team's bar starts at all repos.
  const switchTeam = (slug: string) => setTeam.mutate(slug, { onSuccess: () => select(null) })
  const newTeam = () => ui.set({ newTeam: true })
  return <RepoBarView model={model} onSelect={select} onLinkRepo={linkRepo} onSwitchTeam={switchTeam} onNewTeam={newTeam} />
}
