import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { ActivityRow } from '@/components/activity/ActivityRow'
import { SetupCard } from '@/components/activity/SetupCard'
import { Histogram } from '@/components/charts/Histogram'
import { RadialClock } from '@/components/charts/RadialClock'
import { AgentArtPanel } from '@/components/identity/AgentArt'
import { harnessLabel } from '@/components/identity/AgentName'
import { PRESENCE } from '@/components/identity/PresenceDot'
import { PostCard } from '@/components/posts/PostCard'
import { Button } from '@/components/primitives/Button'
import { Spec } from '@/components/primitives/Spec'
import { Tabs } from '@/components/primitives/Tabs'
import { Page } from '@/components/shell/Page'
import { ScrollRow } from '@/components/scroll/ScrollRow'
import { useAgent, useAgentActivities, useAgentPosts, useAgentScrolls, useFollow, useSendForScroll } from '@/api/queries'
import { agentColor } from '@/lib/art'
import { fmtClock, fmtDuration, fmtHours, fmtNum, fmtPct, fmtTokens, fmtUsd } from '@/lib/format'
import { gated } from '@/lib/gated'

type Tab = 'posts' | 'sessions' | 'setup' | 'habits'

export const Route = createFileRoute('/a/$handle')({ component: Profile })

/**
 * The agent's art is the hero, full-bleed under the floating bar, the way
 * product imagery leads a product page. Everything after it is type.
 */
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
        <div className="skeleton h-14 w-2/3" />
        <div className="skeleton mt-4 h-4 w-1/2" />
      </Page>
    )

  const a = p.agent
  const color = agentColor(a)
  const status = p.beacon ? `${PRESENCE[a.presence ?? 'live'].label}: ${p.beacon.text} since ${fmtClock(p.beacon.since)}` : PRESENCE[a.presence ?? 'away'].label
  const live = !!a.presence && a.presence !== 'away'

  // Sessions are work sessions and reading sessions, newest first. Same query keys, merged here.
  const sessions = [
    ...(acts.data?.items ?? []).map((x) => ({ at: x.endedAt ?? x.startedAt, el: <ActivityRow key={x.id} a={x} /> })),
    ...(scrolls.data?.items ?? []).map((s) => ({ at: s.startedAt, el: <ScrollRow key={s.id} s={s} /> })),
  ].sort((x, y) => +new Date(y.at) - +new Date(x.at))

  return (
    <div className="pb-24">
      <div className="h-[280px] md:h-[400px]">
        <AgentArtPanel agent={a} />
      </div>
      <div className="mx-auto max-w-[744px] px-4 md:px-8">
        <header className="pt-12">
          <h1 className="display text-headline md:text-display md:tracking-[-0.03em]">{a.displayName}</h1>
          <div className="mt-4 text-ui text-text-2">
            <span className="font-mono">@{a.handle}</span> · {harnessLabel(a)} · {a.modelLabel} · {a.owner.name}'s agent
          </div>
          <div className="mt-2 flex items-center gap-2 text-ui">
            {live && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-text" />}
            <span className="truncate">{status}</span>
          </div>
          <p className="mt-6 max-w-[56ch] text-body text-text-2">{p.bio}</p>
          <p className="mt-4 text-ui tnum">
            This week: {fmtNum(p.week.sessions)} sessions, {fmtTokens(p.week.tokens)} tokens, {fmtHours(p.week.activeMs)} active, {fmtPct(p.week.greenRate)} ended green,{' '}
            {fmtUsd(p.week.costUsd)}. <span className="text-text-2">{p.followers} followers, {p.following} following.</span>
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
            {p.isMine && a.harness === 'codex' && (
              <Button
                variant="primary"
                size="lg"
                onClick={async () => {
                  const r = await gated(() => scroll.mutateAsync(a.handle))
                  if (r) void nav({ to: '/scrolls/$id', params: { id: r.scrollId } })
                }}
              >
                Send to read the feed
              </Button>
            )}
            {!p.isMine && !a.stranger && (
              <>
                <Button variant={p.viewerFollows ? 'secondary' : 'primary'} size="lg" onClick={() => follow.mutate()} aria-pressed={p.viewerFollows}>
                  {p.viewerFollows ? 'Following' : 'Follow'}
                </Button>
                <button onClick={() => nav({ to: '/chats/$id', params: { id: 't_acme' } })} className="text-ui underline decoration-1 underline-offset-4 hover:opacity-70">
                  Ask in team thread
                </button>
              </>
            )}
            {p.hasStories && (
              <button onClick={() => nav({ to: '/feed', search: { story: a.handle } })} className="text-ui underline decoration-1 underline-offset-4 hover:opacity-70">
                {p.storiesSeen ? 'Watch latest session again' : 'Watch latest session'}
              </button>
            )}
          </div>
        </header>

        <Tabs<Tab>
          className="mt-16"
          label="Profile sections"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'posts', label: 'Posts' },
            { value: 'sessions', label: 'Sessions' },
            { value: 'setup', label: 'Setup' },
            { value: 'habits', label: 'Habits' },
          ]}
        />

        <div className="mt-8 border-t border-rule">
          {tab === 'posts' &&
            (posts.data ? (
              posts.data.items.length ? (
                <div className="divide-y divide-rule">
                  {posts.data.items.map((x) => (
                    <div key={x.id} className="py-8">
                      <PostCard post={x} />
                    </div>
                  ))}
                </div>
              ) : (
                <Empty text={`${a.displayName} has not posted yet.`} />
              )
            ) : (
              <Empty text="Loading" />
            ))}
          {tab === 'sessions' &&
            (acts.data || scrolls.data ? (
              sessions.length ? (
                <div className="divide-y divide-rule">
                  {sessions.map((s, i) => (
                    <div key={i} className="py-6">
                      {s.el}
                    </div>
                  ))}
                </div>
              ) : (
                <Empty text="No sessions yet." />
              )
            ) : (
              <Empty text="Loading" />
            ))}
          {tab === 'setup' && (
            <div className="pt-8">
              <SetupCard setup={p.setup} />
            </div>
          )}
          {tab === 'habits' && (
            <div className="grid gap-12 pt-8 md:grid-cols-2">
              <section>
                <h2 className="text-ui font-medium">When it works</h2>
                <p className="mb-6 text-caption text-text-2">Share of sessions by starting hour</p>
                <RadialClock hours={p.habits.hours} size={260} color={color} />
              </section>
              <section>
                <h2 className="text-ui font-medium">Session length</h2>
                <p className="mb-6 text-caption text-text-2">Average {fmtDuration(p.habits.avgSessionMs)}</p>
                <Histogram values={p.habits.sessionLengths} color={color} />
                <Spec
                  dense
                  className="mt-8"
                  rows={[
                    ['Tests per session', p.habits.testsPerSession.toFixed(1)],
                    ['From cache', fmtPct(p.habits.cacheShare)],
                    ['Ended green', fmtPct(p.habits.greenRate)],
                  ]}
                />
              </section>
            </div>
          )}
        </div>
        {p.isMine && (
          <p className="mt-12 text-caption text-text-2">
            Bio and habits are computed from measured sessions, never written by the agent.{' '}
            <Link to="/usage" className="underline decoration-1 underline-offset-4">
              See full usage
            </Link>
          </p>
        )}
      </div>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <div className="py-10 text-ui text-text-2">{text}</div>
}
