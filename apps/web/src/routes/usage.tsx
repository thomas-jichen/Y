import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import type { UsageRange, UsageSeries } from '@/api/types'
import { Legend, TimeSeries } from '@/components/charts/TimeSeries'
import { Tabs } from '@/components/primitives/Tabs'
import { Page } from '@/components/shell/Page'
import { AgentPicker } from '@/components/usage/AgentPicker'
import { useMe, useTeam, useUsage } from '@/api/queries'
import { agentColor } from '@/lib/art'
import { cn } from '@/lib/cn'
import { fmtCompact, fmtHours, fmtNum, fmtPct, fmtTokens, fmtUsd } from '@/lib/format'

export const Route = createFileRoute('/usage')({ component: Usage })

const RANGE: Record<UsageRange, { label: string; days: number }> = {
  '7d': { label: '7 days', days: 7 },
  '30d': { label: '30 days', days: 30 },
  '90d': { label: '90 days', days: 90 },
}

const share = (part: number, all: number) => (all ? part / all : 0)

/** Tool and model mix as one typographic table. A teammate, when chosen, is a second column. */
function MixTable({ u, p, peerLabel }: { u: UsageSeries; p?: UsageSeries; peerLabel: string }) {
  const toolTotal = (x: UsageSeries) => Object.values(x.tools).reduce((a, b) => a + b, 0)
  const modelTotal = (x: UsageSeries) => x.models.opus + x.models.sonnet + x.models.haiku
  const tools = Object.entries(u.tools).sort((a, b) => b[1] - a[1])
  const models = (['opus', 'sonnet', 'haiku'] as const).filter((m) => u.models[m] > 0 || (p && p.models[m] > 0))
  const head = 'pb-3 text-left text-caption font-normal text-text-2'
  const num = 'py-2.5 text-right tnum'
  return (
    <table className="w-full text-ui">
      <thead>
        <tr className="border-b border-text">
          <th className={head}>Tool</th>
          <th className={cn(head, 'text-right')}>Calls</th>
          <th className={cn(head, 'text-right')}>Share</th>
          {p && <th className={cn(head, 'text-right')}>{peerLabel}</th>}
        </tr>
      </thead>
      <tbody className="divide-y divide-rule">
        {tools.map(([name, n]) => (
          <tr key={name}>
            <td className="py-2.5 font-mono">{name}</td>
            <td className={num}>{fmtNum(n)}</td>
            <td className={num}>{fmtPct(share(n, toolTotal(u)))}</td>
            {p && <td className={cn(num, 'text-text-2')}>{fmtPct(share(p.tools[name] ?? 0, toolTotal(p)))}</td>}
          </tr>
        ))}
      </tbody>
      <thead>
        <tr className="border-b border-text">
          <th className={cn(head, 'pt-10')}>Model</th>
          <th className={cn(head, 'pt-10 text-right')} />
          <th className={cn(head, 'pt-10 text-right')}>Share of tokens</th>
          {p && <th className={cn(head, 'pt-10 text-right')}>{peerLabel}</th>}
        </tr>
      </thead>
      <tbody className="divide-y divide-rule">
        {u.agent.model === 'astra' ? (
          <tr>
            <td className="py-2.5" colSpan={p ? 4 : 3}>
              Astra reports a single model. All sessions ran on Astra.
            </td>
          </tr>
        ) : (
          models.map((m) => (
            <tr key={m}>
              <td className="py-2.5 capitalize">{m}</td>
              <td />
              <td className={num}>{fmtPct(share(u.models[m], modelTotal(u)))}</td>
              {p && <td className={cn(num, 'text-text-2')}>{p.agent.model === 'astra' ? 'n/a' : fmtPct(share(p.models[m], modelTotal(p)))}</td>}
            </tr>
          ))
        )}
      </tbody>
    </table>
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
  const total = (d: { tokensIn: number; tokensOut: number; cacheRead: number }) => d.tokensIn + d.tokensOut + d.cacheRead
  const youLabel = u?.agent.displayName ?? 'You'
  const peerLabel = peerAgent?.displayName ?? ''
  const change = u && u.prior.tokens ? (u.totals.tokens - u.prior.tokens) / u.prior.tokens : undefined
  const days = RANGE[range].days

  return (
    <Page kind="wide">
      <div className="max-w-[1000px]">
        {!u ? (
          <div className="skeleton h-24 w-3/4" />
        ) : (
          <div className={cn('transition-opacity duration-200', isPlaceholderData && 'opacity-60')}>
            <h1 className="display max-w-[22ch] text-headline">
              {u.agent.displayName} used {fmtTokens(u.totals.tokens)} tokens in the last {days} days
              {change !== undefined && (
                <>
                  , {fmtPct(Math.abs(change))} {change >= 0 ? 'more' : 'fewer'} than the {days} before
                </>
              )}
              .
            </h1>
            <p className="mt-4 text-body text-text-2 tnum">
              {fmtNum(u.totals.sessions)} sessions, {fmtHours(u.totals.activeMs)} active, {fmtUsd(u.totals.costUsd, 0)} spent, {fmtPct(u.totals.greenRate)} ended green,{' '}
              {fmtPct(u.totals.cacheShare)} served from cache.{u.streak ? ` ${u.streak} day streak.` : ''}
              {p && (
                <span className="text-text">
                  {' '}
                  {peerLabel}: {fmtTokens(p.totals.tokens)} tokens, {fmtNum(p.totals.sessions)} sessions, {fmtPct(p.totals.greenRate)} ended green.
                </span>
              )}
            </p>
          </div>
        )}

        <div className="mt-10 flex flex-wrap items-center gap-x-10 gap-y-4">
          {me && me.agents.length > 1 && (
            <Tabs size="sm" label="Agent" value={handle ?? ''} onChange={(v) => setMine(v)} options={me.agents.map((a) => ({ value: a.handle, label: a.displayName }))} />
          )}
          <Tabs<UsageRange>
            size="sm"
            label="Range"
            value={range}
            onChange={setRange}
            options={(Object.keys(RANGE) as UsageRange[]).map((r) => ({ value: r, label: RANGE[r].label }))}
          />
          <AgentPicker agents={peers} value={peer} onChange={setPeer} placeholder="Compare with a teammate" />
        </div>

        {u && (
          <div className={cn('transition-opacity duration-200', isPlaceholderData && 'opacity-60')}>
            <section className="mt-12 border-t border-text pt-3">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="text-caption">Tokens per day</h2>
                {p && peerAgent && (
                  <Legend
                    items={[
                      { label: youLabel, color: agentColor(u.agent) },
                      { label: peerLabel, color: agentColor(peerAgent) },
                    ]}
                  />
                )}
              </div>
              <div className="mt-6">
                <TimeSeries
                  dates={u.days.map((d) => d.day)}
                  format={fmtCompact}
                  series={[
                    { key: 'you', label: youLabel, color: agentColor(u.agent), values: u.days.map(total), area: true },
                    ...(p && peerAgent ? [{ key: 'peer', label: peerLabel, color: agentColor(peerAgent), values: p.days.map(total) }] : []),
                  ]}
                />
              </div>
            </section>

            <section className="mt-16 max-w-[680px]">
              <MixTable u={u} p={p} peerLabel={peerLabel} />
            </section>
          </div>
        )}
      </div>
    </Page>
  )
}
