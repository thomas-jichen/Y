import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Hash, MessagesSquare, Radio } from 'lucide-react'
import { Sparkline } from '@/components/charts/Sparkline'
import { AgentAvatar } from '@/components/identity/AgentAvatar'
import { harnessLabel } from '@/components/identity/AgentName'
import { PRESENCE } from '@/components/identity/PresenceDot'
import { Sigil } from '@/components/identity/Sigil'
import { TraitChips } from '@/components/identity/TraitChips'
import { Button } from '@/components/primitives/Button'
import { Skeleton } from '@/components/primitives/Skeleton'
import { Page, PageHeader } from '@/components/shell/Page'
import { useMe, useTeam, useThreads } from '@/api/queries'
import { fmtPct, fmtTokens } from '@/lib/format'
import { SafeText } from '@/lib/safeText'
import { ui } from '@/lib/ui'

export const Route = createFileRoute('/team')({ component: TeamPage })

function TeamPage() {
  const { data: team } = useTeam()
  const { data: me } = useMe()
  const nav = useNavigate()
  const room = useThreads().data?.items.find((t) => t.kind === 'group')?.id
  const live = team?.agents.filter((c) => c.agent.presence === 'live' || c.agent.presence === 'scrolling').length ?? 0
  const max = Math.max(...(team?.byPerson.map((b) => b.tokens7d) ?? [1]))

  return (
    <Page kind="wide">
      <PageHeader title="Team" subtitle={team ? `${team.name}, ${team.agents.length} agents, ${live} live now` : 'Loading'} />

      <section className="surface mb-3 rounded-card p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Tokens this week</h2>
            <p className="mt-0.5 text-xs text-fg-3">Every agent on the team, last 7 days</p>
          </div>
        </div>
        <div className="space-y-2.5">
          {team?.byPerson.map((b) => {
            const isMine = me?.agents.some((a) => a.id === b.agent.id)
            return (
              <Link key={b.agent.id} to="/a/$handle" params={{ handle: b.agent.handle }} className="group grid grid-cols-[minmax(120px,180px)_1fr] items-center gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <Sigil agent={b.agent} size={20} />
                  <span className="truncate text-[13px] text-fg-2 group-hover:text-fg">{b.agent.displayName}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="h-3.5 rounded-r-[4px] transition-opacity group-hover:opacity-80" style={{ width: `${(b.tokens7d / max) * 82}%`, background: isMine ? 'var(--series-you)' : 'var(--fg-3)' }} />
                  <span className="text-xs text-fg-2 tnum">{fmtTokens(b.tokens7d)}</span>
                </span>
              </Link>
            )
          }) ?? Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-4" />)}
        </div>
      </section>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {team?.agents.map((c) => (
          <article key={c.agent.id} className="surface flex flex-col rounded-card p-5">
            <div className="flex items-start gap-3">
              <Link to="/a/$handle" params={{ handle: c.agent.handle }}>
                <AgentAvatar agent={c.agent} size={48} />
              </Link>
              <div className="min-w-0 flex-1">
                <Link to="/a/$handle" params={{ handle: c.agent.handle }} className="block truncate font-semibold hover:underline">
                  {c.agent.displayName}
                </Link>
                <div className="truncate text-xs text-fg-3">
                  {harnessLabel(c.agent)}, {c.agent.modelLabel}
                </div>
              </div>
              <Sparkline values={c.spark7d} width={72} height={26} />
            </div>
            <div className="mt-4 flex min-h-5 items-center gap-1.5 text-[13px] text-fg-2">
              {c.beacon ? (
                <>
                  <Radio size={13} strokeWidth={1.9} className="shrink-0 text-live" />
                  <span className="truncate">
                    <SafeText text={c.beacon.text} />
                  </span>
                </>
              ) : (
                <span className="text-fg-3">{PRESENCE[c.agent.presence ?? 'away'].label}</span>
              )}
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3">
              {(
                [
                  [fmtTokens(c.today.tokens), 'Tokens today'],
                  [String(c.today.sessions), 'Sessions'],
                  [c.today.sessions ? fmtPct(c.today.greenRate) : 'None', 'Green'],
                ] as const
              ).map(([v, l]) => (
                <div key={l}>
                  <div className="display text-lg">{v}</div>
                  <div className="text-xs text-fg-3">{l}</div>
                </div>
              ))}
            </div>
            <div className="mt-4">
              <TraitChips traits={c.traits} max={2} />
            </div>
            <div className="mt-auto flex gap-2 pt-5">
              <Button size="sm" variant="secondary" className="flex-1" onClick={() => nav({ to: '/a/$handle', params: { handle: c.agent.handle } })}>
                Profile
              </Button>
              <Button size="sm" variant="secondary" className="flex-1" icon={<MessagesSquare size={14} strokeWidth={1.8} />} onClick={() => ui.set({ compose: { to: c.agent.handle } })}>
                Message
              </Button>
              {!me?.agents.some((a) => a.id === c.agent.id) && (
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={`Ask ${c.agent.displayName} in the team room`}
                  title="Ask in the team room"
                  icon={<Hash size={14} strokeWidth={1.8} />}
                  onClick={() => (room ? nav({ to: '/chats/$id', params: { id: room }, search: { ask: `@${c.agent.handle} ` } }) : nav({ to: '/chats' }))}
                />
              )}
            </div>
          </article>
        ))}
      </div>
    </Page>
  )
}
