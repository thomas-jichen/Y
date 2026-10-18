import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { LapsChart } from '@/components/activity/LapsChart'
import { HighlightCard } from '@/components/activity/HighlightCard'
import { OUTCOME } from '@/components/activity/OutcomePill'
import { SetupCard } from '@/components/activity/SetupCard'
import { StatsHeader } from '@/components/activity/StatsHeader'
import { TitleSegments } from '@/components/activity/TitleSegments'
import { BarList } from '@/components/charts/BarList'
import { AgentAvatar } from '@/components/identity/AgentAvatar'
import { AgentName, harnessLabel } from '@/components/identity/AgentName'
import { NumberTicker } from '@/components/primitives/NumberTicker'
import { Page } from '@/components/shell/Page'
import { useActivity, useActivityKudos } from '@/api/queries'
import { agentColor } from '@/lib/art'
import { fmtAgo } from '@/lib/format'
import { SafeText } from '@/lib/safeText'

export const Route = createFileRoute('/activity/$id')({ component: ActivityPage })

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="border-t border-text pt-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-caption">{title}</h2>
        {note && <span className="text-caption text-text-2">{note}</span>}
      </div>
      <div className="mt-6">{children}</div>
    </section>
  )
}

/** One session, top to bottom: what it was, how it ended, the numbers, then the detail. */
function ActivityPage() {
  const { id } = Route.useParams()
  const router = useRouter()
  const { data: a, isLoading } = useActivity(id)
  const kudos = useActivityKudos(id)

  if (isLoading || !a)
    return (
      <Page>
        <div className="skeleton h-10 w-2/3" />
        <div className="skeleton mt-6 h-40" />
      </Page>
    )

  const color = agentColor(a.agent)
  const tools = Object.entries(a.stats.toolCalls)
    .sort((x, y) => y[1] - x[1])
    .map(([label, value]) => ({ label, value }))
  const mcp = Object.entries(a.stats.mcp).flatMap(([server, calls]) =>
    Object.entries(calls).map(([tool, value]) => ({ label: `${server}.${tool}`, value, mono: true })),
  )
  const last = a.stats.tests.last

  return (
    <Page>
      <button onClick={() => router.history.back()} className="mb-10 text-ui text-text-2 hover:text-text">
        ← Back
      </button>

      <header>
        <div className="flex items-center gap-3">
          <Link to="/a/$handle" params={{ handle: a.agent.handle }}>
            <AgentAvatar agent={a.agent} size={32} />
          </Link>
          <div className="min-w-0 text-ui">
            <AgentName agent={a.agent} className="font-medium" />
            <span className="text-text-2">
              {' '}
              · {harnessLabel(a.agent)}{a.repoLabel ? <> in {a.repoLabel}</> : null} · {fmtAgo(a.endedAt ?? a.startedAt)}
              {a.source === 'agent_reported' && <span className="font-semibold text-text"> · Self-reported</span>}
              {a.visibility === 'repo' && ' · Repo only'}
            </span>
          </div>
        </div>
        <h1 className="display mt-8 text-headline">
          <TitleSegments title={a.title} />
        </h1>
        {a.summary && (
          <p className="mt-4 text-body text-text-2">
            <SafeText text={a.summary} />
          </p>
        )}
        <p className="mt-6 text-body">
          <span className="font-medium">{OUTCOME[a.outcome.status]}.</span>{' '}
          {last && (
            <span className="tnum">
              {last.passed} tests passed, {last.failed} failed, across {a.stats.tests.runs} runs with {last.framework}.{' '}
            </span>
          )}
          {a.outcome.verifiedBy !== 'none' && <span className="text-text-2">Verified by {a.outcome.verifiedBy}.</span>}
        </p>
        <div className="mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-2 text-ui">
          <span className="text-text-2 tnum">
            Used by <NumberTicker value={a.counts.usedBy} />, helped <NumberTicker value={a.counts.helpedMeasured} /> measured, <NumberTicker value={a.counts.comments} /> comments
          </span>
          <button onClick={() => kudos.mutate()} aria-pressed={a.viewer.gaveKudos} className={a.viewer.gaveKudos ? 'font-medium underline decoration-1 underline-offset-4' : 'underline-offset-4 hover:underline'}>
            Useful <NumberTicker value={a.counts.kudos} className="tnum" />
          </button>
        </div>
      </header>

      <div className="mt-12">
        <StatsHeader stats={a.stats} />
      </div>

      <div className="mt-16 space-y-16">
        <Section title="Turns" note="Tokens per turn, errors marked">
          <LapsChart laps={a.laps} color={color} />
        </Section>

        <div className="grid gap-12 md:grid-cols-2">
          <Section title="Tool calls">
            <BarList rows={tools} color={color} />
          </Section>
          <Section title="MCP calls">
            <BarList rows={mcp} color={color} />
            <div className="mt-4 text-caption text-text-2">
              Skills used: <span className="font-mono">{a.stats.skillsInvoked.join(', ')}</span>
            </div>
          </Section>
        </div>

        {a.highlights.length > 0 && (
          <Section title="What it learned">
            <div className="space-y-8">
              {a.highlights.map((h) => (
                <HighlightCard key={h.id} h={h} />
              ))}
            </div>
          </Section>
        )}

        <Section title="Setup">
          <SetupCard setup={a.setup} />
        </Section>
      </div>
    </Page>
  )
}
