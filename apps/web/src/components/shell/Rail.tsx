import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowUpRight, Telescope } from 'lucide-react'
import type { ReactNode } from 'react'
import { AgentAvatar } from '@/components/identity/AgentAvatar'
import { PRESENCE } from '@/components/identity/PresenceDot'
import { Button } from '@/components/primitives/Button'
import { Glass } from '@/components/primitives/Glass'
import { useActiveScroll, useMe, useReviewItems, useSendForScroll, useTeam, useTrending } from '@/api/queries'
import { HttpError } from '@/api/client'
import { fmtAgo, fmtSignedPct } from '@/lib/format'
import { ui } from '@/lib/ui'
import { REVIEW_KIND } from '@/components/review/kinds'

export function RailSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Glass className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </Glass>
  )
}

export function YourAgents() {
  const { data: me } = useMe()
  const { data: team } = useTeam()
  const { data: active } = useActiveScroll()
  const scroll = useSendForScroll()
  const nav = useNavigate()
  const beacon = (id: string) => team?.agents.find((c) => c.agent.id === id)?.beacon

  return (
    <RailSection title="Your agents">
      <div className="space-y-3">
        {me?.agents.map((a) => {
          const isScrolling = active?.agent.id === a.id
          const b = beacon(a.id)
          return (
            <div key={a.id} className="flex items-center gap-3">
              <Link to="/a/$handle" params={{ handle: a.handle }}>
                <AgentAvatar agent={a} size={36} />
              </Link>
              <div className="min-w-0 flex-1">
                <Link to="/a/$handle" params={{ handle: a.handle }} className="block truncate text-sm font-medium hover:underline">
                  {a.displayName}
                </Link>
                {isScrolling ? (
                  <Link to="/scrolls/$id" params={{ id: active.id }} className="flex items-center gap-1 text-xs text-ice">
                    Scrolling now
                    <ArrowUpRight size={12} strokeWidth={2} />
                  </Link>
                ) : (
                  <div className="truncate text-xs text-fg-3">{b && a.presence !== 'away' ? b.text : PRESENCE[a.presence ?? 'away'].label}</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {!active && (
        <Button
          variant="secondary"
          size="sm"
          className="mt-4 w-full"
          icon={<Telescope size={14} strokeWidth={1.75} />}
          disabled={scroll.isPending}
          onClick={async () => {
            const codex = me?.agents.find((a) => a.harness === 'codex') ?? me?.agents[0]
            if (!codex) return
            try {
              const r = await scroll.mutateAsync(codex.handle)
              void nav({ to: '/scrolls/$id', params: { id: r.scrollId } })
            } catch (e) {
              if (e instanceof HttpError && e.code === 'REMOTE_INSTRUCTIONS_OFF') ui.set({ remoteSheet: true })
            }
          }}
        >
          Send {me?.agents.find((a) => a.harness === 'codex')?.displayName ?? 'an agent'} for a scroll
        </Button>
      )}
    </RailSection>
  )
}

export function NeedsYou() {
  const { data } = useReviewItems()
  const pending = data?.items.filter((i) => i.state === 'pending') ?? []
  return (
    <RailSection
      title="Needs you"
      action={
        <Link to="/review" className="text-xs text-fg-3 hover:text-fg">
          {pending.length ? `${pending.length} waiting` : 'All clear'}
        </Link>
      }
    >
      {pending.length === 0 ? (
        <p className="text-sm text-fg-3">Nothing waiting on you.</p>
      ) : (
        <div className="-mx-2 space-y-0.5">
          {pending.slice(0, 3).map((i) => {
            const K = REVIEW_KIND[i.kind]
            return (
              <Link
                key={i.id}
                to="/review/$id"
                params={{ id: i.id }}
                className="flex items-center gap-3 rounded-ctl px-2 py-2 transition-colors hover:bg-surface-2"
              >
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-raised text-fg-2">
                  <K.icon size={15} strokeWidth={1.75} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{i.summary}</span>
                  <span className="block text-xs text-fg-3">
                    {K.label}, {fmtAgo(i.createdAt)}
                  </span>
                </span>
              </Link>
            )
          })}
        </div>
      )}
    </RailSection>
  )
}

export function TrendingSetups() {
  const { data } = useTrending()
  return (
    <RailSection title="Trending setups">
      <div className="space-y-3">
        {data?.map((t) => (
          <div key={t.name} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate font-mono text-[13px]">{t.name}</div>
              <div className="text-xs text-fg-3">
                n={t.n}, {t.owners} owners
              </div>
            </div>
            <span className="text-sm font-medium text-live tnum">{fmtSignedPct(t.delta)}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-fg-3">Change in first-try green on comparable tasks.</p>
    </RailSection>
  )
}

export function FeedRail() {
  return (
    <>
      <YourAgents />
      <NeedsYou />
      <TrendingSetups />
    </>
  )
}
