import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import type { UsageRange } from '@/api/types'
import { BarList } from '@/components/charts/BarList'
import { Heatmap } from '@/components/charts/Heatmap'
import { RadialClock } from '@/components/charts/RadialClock'
import { StackedBar } from '@/components/charts/StackedBar'
import { Legend, TimeSeries } from '@/components/charts/TimeSeries'
import { Segmented } from '@/components/primitives/Segmented'
import { Skeleton } from '@/components/primitives/Skeleton'
import { Page, PageHeader } from '@/components/shell/Page'
import { AgentPicker } from '@/components/usage/AgentPicker'
import { KpiTile } from '@/components/usage/KpiTile'
import { useMe, useTeam, useUsage } from '@/api/queries'
import { cn } from '@/lib/cn'
import { fmtCompact, fmtHours, fmtNum, fmtPct, fmtTokens, fmtUsd } from '@/lib/format'

export const Route = createFileRoute('/usage')({ component: Usage })

/** Days without sessions have no tokens-to-green; carry the last value instead of dropping to zero. */
const carry = (xs: number[]) => xs.reduce<number[]>((out, v, i) => [...out, v || out[i - 1] || xs.find(Boolean) || 0], [])

function Card({ title, sub, aside, children, className }: { title: string; sub?: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('surface rounded-card p-5', className)}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {sub && <p className="mt-0.5 text-xs text-fg-3">{sub}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  )
}

function Usage() {
  const { data: me } = useMe()
  const { data: team } = useTeam()
  const [mine, setMine] = useState<string | undefined>()
  const [range, setRange] = useState<UsageRange>('30d')
  const [peer, setPeer] = useState<string | undefined>()
  const handle = mine ?? me?.agents[0]?.handle
  const { data: u, isPlaceholderData } = useUsage(handle, range)
  const { data: p } = useUsage(peer, range)
  const peers = useMemo(() => team?.agents.map((c) => c.agent).filter((a) => !me?.agents.some((m) => m.id === a.id)) ?? [], [team, me])
  const peerAgent = peers.find((a) => a.handle === peer)
  const delta = (a: number, b: number) => (b ? (a - b) / b : undefined)
  const total = (d: { tokensIn: number; tokensOut: number; cacheRead: number }) => d.tokensIn + d.tokensOut + d.cacheRead
  const youLabel = u?.agent.displayName ?? 'You'
  const peerLabel = peerAgent?.displayName ?? ''

  return (
    <Page kind="wide">
      <PageHeader
        title="Usage"
        subtitle={u ? `${u.agent.displayName}, last ${range === '7d' ? '7' : range === '30d' ? '30' : '90'} days${u.streak ? `, ${u.streak} day streak` : ''}` : 'Loading'}
        actions={
          <>
            {me && me.agents.length > 1 && (
              <Segmented size="sm" value={handle ?? ''} onChange={(v) => setMine(v)} options={me.agents.map((a) => ({ value: a.handle, label: a.displayName.replace(/^.*'s /, '') }))} />
            )}
            <Segmented<UsageRange>
              size="sm"
              value={range}
              onChange={setRange}
              options={[
                { value: '7d', label: '7 days' },
                { value: '30d', label: '30 days' },
                { value: '90d', label: '90 days' },
              ]}
            />
            <AgentPicker agents={peers} value={peer} onChange={setPeer} placeholder="Compare with a teammate" />
          </>
        }
      />

      {!u ? (
        <div className="grid gap-3 md:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-28 rounded-card" />
          ))}
        </div>
      ) : (
        <div className={cn('space-y-3 transition-opacity duration-200', isPlaceholderData && 'opacity-60')}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <KpiTile label="Tokens" value={fmtTokens(u.totals.tokens)} delta={delta(u.totals.tokens, u.prior.tokens)} peer={p ? fmtTokens(p.totals.tokens) : undefined} />
            <KpiTile label="Sessions" value={fmtNum(u.totals.sessions)} delta={delta(u.totals.sessions, u.prior.sessions)} peer={p ? fmtNum(p.totals.sessions) : undefined} />
            <KpiTile label="Active" value={fmtHours(u.totals.activeMs)} delta={delta(u.totals.activeMs, u.prior.activeMs)} peer={p ? fmtHours(p.totals.activeMs) : undefined} />
            <KpiTile label="Cost" value={fmtUsd(u.totals.costUsd, 0)} delta={delta(u.totals.costUsd, u.prior.costUsd)} goodWhenUp={false} peer={p ? fmtUsd(p.totals.costUsd, 0) : undefined} />
            <KpiTile label="Ended green" value={fmtPct(u.totals.greenRate)} delta={delta(u.totals.greenRate, u.prior.greenRate)} goodWhenUp peer={p ? fmtPct(p.totals.greenRate) : undefined} />
          </div>

          <Card
            title="Tokens per day"
            sub={`${fmtPct(u.totals.cacheShare)} served from cache`}
            aside={
              <Legend
                items={[
                  { label: youLabel, color: 'var(--series-you)' },
                  ...(p ? [{ label: peerLabel, color: 'var(--series-peer)' }] : []),
                ]}
              />
            }
          >
            <TimeSeries
              dates={u.days.map((d) => d.day)}
              format={fmtCompact}
              series={[
                { key: 'you', label: youLabel, color: 'var(--series-you)', values: u.days.map(total), area: true },
                ...(p ? [{ key: 'peer', label: peerLabel, color: 'var(--series-peer)', values: p.days.map(total) }] : []),
              ]}
            />
          </Card>

          <div className="grid gap-3 lg:grid-cols-[1.35fr_1fr]">
            <Card title="Sessions per day" sub="Last 13 weeks">
              <Heatmap days={u.heat} />
            </Card>
            <Card title="When you code" sub="Share of sessions by starting hour">
              <div className="flex justify-center">
                <RadialClock hours={u.hours} peer={p?.hours} size={232} youLabel={youLabel} peerLabel={peerLabel} />
              </div>
            </Card>
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <Card title="Tool mix" sub="Calls in this range">
              <BarList rows={Object.entries(u.tools).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }))} />
            </Card>
            <Card title="Model mix" sub={u.agent.model === 'codex' ? 'Codex reports a single model' : 'Share of tokens by model'}>
              {u.agent.model === 'codex' ? (
                <div className="flex h-24 items-center text-sm text-fg-3">All sessions ran on Codex.</div>
              ) : (
                <StackedBar
                  parts={[
                    { label: 'Opus', value: u.models.opus, color: 'var(--tier-3)', ink: 'var(--tier-3-ink)' },
                    { label: 'Sonnet', value: u.models.sonnet, color: 'var(--tier-2)', ink: 'var(--tier-2-ink)' },
                    { label: 'Haiku', value: u.models.haiku, color: 'var(--tier-1)', ink: 'var(--tier-1-ink)' },
                  ]}
                />
              )}
            </Card>
            <Card title="Tokens to green" sub="Median per day, lower is better">
              <TimeSeries
                dates={u.days.map((d) => d.day)}
                format={fmtCompact}
                height={160}
                series={[
                  { key: 'you', label: youLabel, color: 'var(--series-you)', values: carry(u.days.map((d) => d.tokensToGreen)) },
                  ...(p ? [{ key: 'peer', label: peerLabel, color: 'var(--series-peer)', values: carry(p.days.map((d) => d.tokensToGreen)) }] : []),
                ]}
              />
            </Card>
          </div>
        </div>
      )}
    </Page>
  )
}
