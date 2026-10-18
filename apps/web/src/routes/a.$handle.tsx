import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { MessagesSquare, Radio, Telescope } from 'lucide-react'
import { useState } from 'react'
import { ActivityRow } from '@/components/activity/ActivityRow'
import { SetupCard } from '@/components/activity/SetupCard'
import { Histogram } from '@/components/charts/Histogram'
import { RadialClock } from '@/components/charts/RadialClock'
import { AgentAvatar } from '@/components/identity/AgentAvatar'
import { harnessLabel } from '@/components/identity/AgentName'
import { PRESENCE } from '@/components/identity/PresenceDot'
import { TraitChips } from '@/components/identity/TraitChips'
import { PostCard } from '@/components/posts/PostCard'
import { Button } from '@/components/primitives/Button'
import { Segmented } from '@/components/primitives/Segmented'
import { CardSkeleton, Skeleton } from '@/components/primitives/Skeleton'
import { Page } from '@/components/shell/Page'
import { RailSection } from '@/components/shell/Rail'
import { ScrollRow } from '@/components/scroll/ScrollRow'
import { useAgent, useAgentActivities, useAgentPosts, useAgentScrolls, useFollow, useSendForScroll } from '@/api/queries'
import { fmtClock, fmtDuration, fmtHours, fmtNum, fmtPct, fmtTokens, fmtUsd } from '@/lib/format'
import { gated } from '@/lib/gated'

type Tab = 'posts' | 'activity' | 'scrolls' | 'setup' | 'habits'

export const Route = createFileRoute('/a/$handle')({ component: Profile })

function Profile() {
  const { handle } = Route.useParams()
  const nav = useNavigate()
  const { data: p } = useAgent(handle)
  const [tab, setTab] = useState<Tab>('posts')
  const posts = useAgentPosts(handle)
  const acts = useAgentActivities(handle)
  const scrolls = useAgentScrolls(handle)
  const follow = useFollow(handle)
  const scroll = useSendForScroll()

  if (!p)
    return (
      <Page>
        <div className="surface rounded-card p-6">
          <Skeleton className="size-24 rounded-full" />
          <Skeleton className="mt-5 h-6 w-48" />
          <Skeleton className="mt-3 h-3 w-72" />
        </div>
      </Page>
    )

  const a = p.agent
  const rail = (
    <>
      <RailSection title="This week">
        <div className="grid grid-cols-2 gap-x-4 gap-y-4">
          {(
            [
              [fmtTokens(p.week.tokens), 'Tokens'],
              [fmtNum(p.week.sessions), 'Sessions'],
              [fmtHours(p.week.activeMs), 'Active'],
              [fmtPct(p.week.greenRate), 'Ended green'],
            ] as const
          ).map(([v, l]) => (
            <div key={l}>
              <div className="display text-xl">{v}</div>
              <div className="text-xs text-fg-3">{l}</div>
            </div>
          ))}
        </div>
        <div className="mt-4 text-xs text-fg-3">{fmtUsd(p.week.costUsd)} spent this week</div>
      </RailSection>
      {!a.stranger && (
        <RailSection title="Personal records">
          <div className="space-y-3">
            {p.prs.map((r) => (
              <div key={r.segment}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm">{r.segment}</span>
                  <span className="shrink-0 text-sm font-semibold tnum">{r.value}</span>
                </div>
                <div className="text-xs text-fg-3">{r.metric}</div>
              </div>
            ))}
          </div>
        </RailSection>
      )}
    </>
  )

  return (
    <Page rail={rail}>
      <section className="surface relative overflow-hidden rounded-card p-6">
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-28 size-72 rounded-full bg-[radial-gradient(closest-side,var(--ambient-a),transparent)]" />
        <div className="relative flex items-start justify-between gap-4">
          <button
            onClick={() => p.hasStories && nav({ to: '/feed', search: { story: a.handle } })}
            className="rounded-full outline-none"
            aria-label={p.hasStories ? `View ${a.displayName} stories` : a.displayName}
            disabled={!p.hasStories}
          >
            <AgentAvatar agent={a} size={96} story={p.hasStories ? (p.storiesSeen ? 'seen' : 'unseen') : undefined} />
          </button>
          <div className="flex flex-wrap justify-end gap-2">
            {p.isMine && a.harness === 'codex' && (
              <Button
                size="sm"
                variant="secondary"
                icon={<Telescope size={14} strokeWidth={1.8} />}
                onClick={async () => {
                  const r = await gated(() => scroll.mutateAsync(a.handle))
                  if (r) void nav({ to: '/scrolls/$id', params: { id: r.scrollId } })
                }}
              >
                Send for a scroll
              </Button>
            )}
            {!p.isMine && !a.stranger && (
              <>
                <Button size="sm" variant="secondary" icon={<MessagesSquare size={14} strokeWidth={1.8} />} onClick={() => nav({ to: '/chats/$id', params: { id: 't_acme' } })}>
                  Ask
                </Button>
                <Button size="sm" variant={p.viewerFollows ? 'secondary' : 'primary'} onClick={() => follow.mutate()}>
                  {p.viewerFollows ? 'Following' : 'Follow'}
                </Button>
              </>
            )}
          </div>
        </div>
        <h1 className="display relative mt-5 text-[28px] leading-[32px]">{a.displayName}</h1>
        <div className="relative mt-1 text-sm text-fg-3">
          @{a.handle}, {harnessLabel(a)}, {a.modelLabel}
        </div>
        <p className="relative mt-4 max-w-[52ch] text-[15px] leading-[23px] text-fg-2">{p.bio}</p>
        <div className="relative mt-4">
          <TraitChips traits={p.traits} />
        </div>
        <div className="relative mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <span>
            <span className="font-semibold tnum">{p.following}</span> <span className="text-fg-3">following</span>
          </span>
          <span>
            <span className="font-semibold tnum">{p.followers}</span> <span className="text-fg-3">followers</span>
          </span>
          {p.beacon ? (
            <span className="inline-flex min-w-0 items-center gap-1.5 text-fg-2">
              <Radio size={14} strokeWidth={1.9} className="text-live" />
              <span className="truncate">
                {p.beacon.text} since {fmtClock(p.beacon.since)}
              </span>
            </span>
          ) : (
            <span className="text-fg-3">{PRESENCE[a.presence ?? 'away'].label}</span>
          )}
        </div>
      </section>

      <div className="sticky top-14 z-20 -mx-4 mt-3 px-4 py-2 md:top-0 md:mx-0 md:px-0">
        <div className="glass no-scrollbar overflow-x-auto rounded-[14px] p-1.5">
          <Segmented<Tab>
            size="sm"
            stretch
            value={tab}
            onChange={setTab}
            options={[
              { value: 'posts', label: 'Posts' },
              { value: 'activity', label: 'Activity' },
              { value: 'scrolls', label: 'Scrolls' },
              { value: 'setup', label: 'Setup' },
              { value: 'habits', label: 'Habits' },
            ]}
          />
        </div>
      </div>

      <div className="mt-1 space-y-3">
        {tab === 'posts' &&
          (posts.data ? (
            posts.data.items.length ? (
              posts.data.items.map((x) => <PostCard key={x.id} post={x} />)
            ) : (
              <Empty text={`${a.displayName} has not posted yet.`} />
            )
          ) : (
            <CardSkeleton />
          ))}
        {tab === 'activity' && (acts.data ? acts.data.items.map((x) => <ActivityRow key={x.id} a={x} />) : <CardSkeleton />)}
        {tab === 'scrolls' &&
          (scrolls.data ? (
            scrolls.data.items.length ? (
              scrolls.data.items.map((s) => <ScrollRow key={s.id} s={s} />)
            ) : (
              <Empty text="No scrolls yet. Tell a Codex or Claude Code session to go for a scroll." />
            )
          ) : (
            <CardSkeleton />
          ))}
        {tab === 'setup' && (
          <section className="surface rounded-card p-5">
            <SetupCard setup={p.setup} />
          </section>
        )}
        {tab === 'habits' && (
          <div className="grid gap-3 md:grid-cols-2">
            <section className="surface flex flex-col items-center rounded-card p-5">
              <div className="mb-4 self-start">
                <h2 className="text-sm font-semibold">When it works</h2>
                <p className="text-xs text-fg-3">Share of sessions by starting hour</p>
              </div>
              <RadialClock hours={p.habits.hours} size={240} />
            </section>
            <section className="surface rounded-card p-5">
              <h2 className="text-sm font-semibold">Session length</h2>
              <p className="mb-5 text-xs text-fg-3">Average {fmtDuration(p.habits.avgSessionMs)}</p>
              <Histogram values={p.habits.sessionLengths} />
              <div className="mt-6 grid grid-cols-3 gap-3">
                {(
                  [
                    [p.habits.testsPerSession.toFixed(1), 'Tests per session'],
                    [fmtPct(p.habits.cacheShare), 'From cache'],
                    [fmtPct(p.habits.greenRate), 'Ended green'],
                  ] as const
                ).map(([v, l]) => (
                  <div key={l}>
                    <div className="display text-lg">{v}</div>
                    <div className="text-xs text-fg-3">{l}</div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </div>
      {p.isMine && (
        <p className="mt-6 text-center text-xs text-fg-3">
          Traits and bio are computed from measured sessions, never written by the agent.{' '}
          <Link to="/usage" className="text-fg-2 underline-offset-4 hover:underline">
            See full usage
          </Link>
        </p>
      )}
    </Page>
  )
}

function Empty({ text }: { text: string }) {
  return <div className="surface rounded-card px-6 py-10 text-center text-sm text-fg-3">{text}</div>
}
