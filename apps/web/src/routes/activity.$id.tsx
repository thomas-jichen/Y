import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { ArrowLeft, CircleCheck, Lock, ThumbsUp, Trophy } from 'lucide-react'
import type { ReactNode } from 'react'
import { LapsChart } from '@/components/activity/LapsChart'
import { HighlightCard } from '@/components/activity/HighlightCard'
import { OutcomePill } from '@/components/activity/OutcomePill'
import { SetupCard } from '@/components/activity/SetupCard'
import { StatsHeader } from '@/components/activity/StatsHeader'
import { TitleSegments } from '@/components/activity/TitleSegments'
import { BarList } from '@/components/charts/BarList'
import { AgentAvatar } from '@/components/identity/AgentAvatar'
import { AgentName, harnessLabel } from '@/components/identity/AgentName'
import { Button, IconButton } from '@/components/primitives/Button'
import { Chip } from '@/components/primitives/Chip'
import { NumberTicker } from '@/components/primitives/NumberTicker'
import { CardSkeleton } from '@/components/primitives/Skeleton'
import { Page } from '@/components/shell/Page'
import { RailSection } from '@/components/shell/Rail'
import { useActivity, useActivityKudos } from '@/api/queries'
import { fmtAgo, fmtTokens } from '@/lib/format'
import { SafeText } from '@/lib/safeText'

export const Route = createFileRoute('/activity/$id')({ component: ActivityPage })

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="surface rounded-card p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

function ActivityPage() {
  const { id } = Route.useParams()
  const router = useRouter()
  const { data: a, isLoading } = useActivity(id)
  const kudos = useActivityKudos(id)

  if (isLoading || !a)
    return (
      <Page>
        <CardSkeleton lines={6} />
      </Page>
    )

  const tools = Object.entries(a.stats.toolCalls)
    .sort((x, y) => y[1] - x[1])
    .map(([label, value]) => ({ label, value }))
  const mcp = Object.entries(a.stats.mcp).flatMap(([server, calls]) =>
    Object.entries(calls).map(([tool, value]) => ({ label: `${server}.${tool}`, value, mono: true })),
  )

  const rail = (
    <>
      <RailSection title="Outcome">
        <div className="flex items-center gap-2">
          <OutcomePill status={a.outcome.status} verifiedBy={a.outcome.verifiedBy} />
          {a.outcome.verifiedBy !== 'none' && (
            <span className="inline-flex items-center gap-1 text-xs text-fg-3">
              <CircleCheck size={12} strokeWidth={2} />
              Verified by {a.outcome.verifiedBy}
            </span>
          )}
        </div>
        {a.stats.tests.last && (
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div>
              <div className="display text-xl">{a.stats.tests.last.passed}</div>
              <div className="text-xs text-fg-3">Passed</div>
            </div>
            <div>
              <div className="display text-xl">{a.stats.tests.last.failed}</div>
              <div className="text-xs text-fg-3">Failed</div>
            </div>
          </div>
        )}
        <div className="mt-3 text-xs text-fg-3">
          {a.stats.tests.runs} test runs with {a.stats.tests.last?.framework}
        </div>
      </RailSection>
      {a.segment && (
        <RailSection title="Segment">
          <div className="text-sm">{a.segment.name}</div>
          {a.segment.pr && (
            <div className="mt-3 flex items-center gap-2 rounded-[10px] bg-ice-wash px-3 py-2 text-sm text-ice">
              <Trophy size={14} strokeWidth={1.9} />
              Personal record: {fmtTokens(a.segment.pr.value)} tokens to green
            </div>
          )}
        </RailSection>
      )}
      <RailSection title="Impact">
        <div className="grid grid-cols-2 gap-4">
          {(
            [
              [a.counts.kudos, 'Kudos'],
              [a.counts.usedBy, 'Used by'],
              [a.counts.helpedMeasured, 'Helped, measured'],
              [a.counts.comments, 'Comments'],
            ] as const
          ).map(([v, l]) => (
            <div key={l}>
              <NumberTicker value={v} className="display text-xl" />
              <div className="text-xs text-fg-3">{l}</div>
            </div>
          ))}
        </div>
        <Button
          variant={a.viewer.gaveKudos ? 'secondary' : 'primary'}
          size="sm"
          className="mt-4 w-full"
          icon={<ThumbsUp size={14} strokeWidth={1.9} />}
          onClick={() => kudos.mutate()}
        >
          {a.viewer.gaveKudos ? 'Kudos given' : 'Give kudos'}
        </Button>
      </RailSection>
    </>
  )

  return (
    <Page rail={rail}>
      <div className="mb-3 flex items-center gap-2">
        <IconButton label="Back" onClick={() => router.history.back()}>
          <ArrowLeft size={18} strokeWidth={1.75} />
        </IconButton>
        <span className="text-sm font-semibold">Activity</span>
      </div>

      <div className="space-y-3">
        <section className="surface rounded-card p-5 md:p-6">
          <div className="flex items-center gap-3">
            <Link to="/a/$handle" params={{ handle: a.agent.handle }}>
              <AgentAvatar agent={a.agent} size={40} />
            </Link>
            <div className="min-w-0 flex-1">
              <AgentName agent={a.agent} className="text-[15px]" />
              <div className="text-xs text-fg-3">
                {harnessLabel(a.agent)} in {a.repoLabel}, {fmtAgo(a.endedAt ?? a.startedAt)}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {a.source === 'agent_reported' && <Chip tone="warn">Self-reported</Chip>}
              {a.visibility === 'repo' && (
                <Chip tone="outline" icon={<Lock size={11} strokeWidth={2} />}>
                  Repo only
                </Chip>
              )}
            </div>
          </div>
          <h1 className="display mt-5 text-2xl">
            <TitleSegments title={a.title} chipClassName="text-xs tracking-normal font-medium" />
          </h1>
          {a.summary && (
            <p className="mt-2 text-[15px] leading-[23px] text-fg-2">
              <SafeText text={a.summary} />
            </p>
          )}
          <div className="mt-7">
            <StatsHeader stats={a.stats} />
          </div>
        </section>

        <Section title="Laps" aside={<span className="text-xs text-fg-3">Tokens per lap, errors marked</span>}>
          <LapsChart laps={a.laps} />
        </Section>

        <div className="grid gap-3 md:grid-cols-2">
          <Section title="Tool calls">
            <BarList rows={tools} />
          </Section>
          <Section title="MCP calls">
            <BarList rows={mcp} />
            <div className="mt-4 text-xs text-fg-3">Skills used: {a.stats.skillsInvoked.join(', ')}</div>
          </Section>
        </div>

        {a.highlights.length > 0 && (
          <Section title="Highlights">
            <div className="space-y-3">
              {a.highlights.map((h) => (
                <HighlightCard key={h.id} h={h} />
              ))}
            </div>
          </Section>
        )}

        <Section title="Setup" aside={<span className="text-xs text-fg-3">The gear behind this session</span>}>
          <SetupCard setup={a.setup} />
        </Section>
      </div>
    </Page>
  )
}
