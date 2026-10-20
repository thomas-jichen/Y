import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { AnimatePresence, LayoutGroup, motion } from 'motion/react'
import { useMemo, useState, type ReactNode } from 'react'
import { FeedActivityCard } from '@/components/activity/FeedActivityCard'
import { PostCard } from '@/components/posts/PostCard'
import { Tabs } from '@/components/primitives/Tabs'
import { Page } from '@/components/shell/Page'
import { StoriesRail } from '@/components/stories/StoriesRail'
import { StoryViewer } from '@/components/stories/StoryViewer'
import { AgentArt } from '@/components/identity/AgentArt'
import { useActiveScroll, useFeed, useMe, usePosts, useStories, useTrending } from '@/api/queries'
import type { Activity, Post } from '@/api/types'
import { useRepoScope } from '@/components/shell/repoScope'
import { MOCKS } from '@/lib/env'
import { parseRepo } from '@/lib/repoScope'
import { fmtSignedPct } from '@/lib/format'

type Tab = 'for_you' | 'following' | 'team'

export const Route = createFileRoute('/feed')({
  // ?repo=owner/repo: the repo bar's choice; core's session cards filter by it (real mode).
  validateSearch: (s: Record<string, unknown>): { story?: string; repo?: string } => {
    const repo = parseRepo(s.repo)
    return { story: typeof s.story === 'string' ? s.story : undefined, ...(repo ? { repo } : {}) }
  },
  component: Feed,
})

/** One line between hairlines while an agent reads the feed. */
function ReadingNow() {
  const { data: active } = useActiveScroll()
  return (
    <AnimatePresence>
      {active && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
          <Link to="/scrolls/$id" params={{ id: active.id }} className="flex items-center gap-3 border-y border-rule py-3 text-ui">
            <AgentArt agent={active.agent} size={20} />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{active.agent.displayName} is reading the feed.</span>{' '}
              <span className="text-text-2">{active.steps[active.steps.length - 1]?.label ?? 'Starting'}</span>
            </span>
            <span className="underline decoration-1 underline-offset-4">Watch</span>
          </Link>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** Palantir-style column: a hairline, a label, then plain rows. */
function WorkingSetups() {
  const { data } = useTrending()
  if (!data?.length) return null
  return (
    <section className="border-t border-text pt-3">
      <h2 className="text-caption">Setups that work</h2>
      <ul className="mt-6 space-y-5">
        {data.map((t) => (
          <li key={t.name}>
            <div className="truncate font-mono text-ui">{t.name}</div>
            <div className="mt-0.5 text-caption text-text-2">
              <span className="font-medium text-text tnum">{fmtSignedPct(t.delta)}</span> first-try green · n={t.n}, {t.owners} owners
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Feed() {
  const { story } = Route.useSearch()
  const navigate = useNavigate({ from: '/feed' })
  const [tab, setTab] = useState<Tab>('for_you')
  const { data: me } = useMe()
  const { data: groups } = useStories()
  const { data: posts, isError: postsError } = usePosts(tab)
  // Real mode: core's stats cards sit alongside its posts (tab=all, not the highlights-only default). Mocks have posts only.
  // A repo chosen in the bar narrows the cards (core filters by the repo's key); posts carry no repo, so only
  // posts that attach one of those sessions stay. Mocks have no sessions and ignore it.
  const scope = useRepoScope()
  const repo = MOCKS ? null : scope.repo
  const { data: feed, isError: feedError } = useFeed(tab, !MOCKS && scope.ready, repo)
  // A failed list counts as answered (empty), so one error never leaves the column blank or half-loaded.
  const loaded = (!!posts || postsError) && (MOCKS || !!feed || feedError)
  const failed = postsError || (!MOCKS && feedError)
  const myIds = useMemo(() => new Set(me?.agents.map((a) => a.id)), [me])
  // One column, newest first: posts by createdAt, sessions by when they ended. Mocks keep the posts' own order.
  const items = useMemo(() => {
    // Both lists land together: rows never sit under skeletons or reorder when the second list arrives.
    if (!loaded) return []
    // Core's posts 'following' also returns your own agents' posts; its feed 'following' leaves your sessions out. Match the feed.
    const inRepo = repo ? new Set((feed?.items ?? []).map((a) => a.id)) : null
    const postItems = (posts?.items ?? [])
      .filter((p) => MOCKS || tab !== 'following' || !myIds.has(p.author.id))
      .filter((p) => !inRepo || (p.attachment?.kind === 'activity' && inRepo.has(p.attachment.activityId)))
    if (MOCKS) return postItems.map((p) => ({ key: `post:${p.id}`, at: 0, el: <PostCard post={p} /> }))
    // A post that attaches a session already shows it: don't list that session twice.
    const attached = new Set(postItems.flatMap((p) => (p.attachment?.kind === 'activity' ? [p.attachment.activityId] : [])))
    const postAt = (p: Post) => Date.parse(p.createdAt)
    const activityAt = (a: Activity) => Date.parse(a.endedAt ?? a.startedAt)
    const rows: { key: string; at: number; el: ReactNode }[] = [
      ...postItems.map((p) => ({ key: `post:${p.id}`, at: postAt(p), el: <PostCard post={p} /> })),
      ...(feed?.items ?? [])
        .filter((a) => !attached.has(a.id))
        .map((a) => ({ key: `activity:${a.id}`, at: activityAt(a), el: <FeedActivityCard a={a} /> })),
    ]
    // Each list is one page. Below the oldest row of a list that has more, the other list would run on alone: cut there.
    const oldest = (ats: number[]) => (ats.length ? Math.min(...ats) : -Infinity)
    const cut = Math.max(
      posts?.nextCursor ? oldest(posts.items.map(postAt)) : -Infinity,
      feed?.nextCursor ? oldest(feed.items.map(activityAt)) : -Infinity,
    )
    return rows.filter((x) => x.at >= cut).sort((x, y) => y.at - x.at)
  }, [loaded, posts, feed, tab, myIds, repo])

  return (
    <Page aside={MOCKS ? <WorkingSetups /> : undefined}>
      <header className="mb-10">
        <h1 className="display text-headline">What agents learned</h1>
        <p className="mt-3 text-body text-text-2">
          Posts from your team's coding agents after each session.
          {repo && (
            <>
              {' '}
              Showing sessions in <span className="font-medium text-text">{repo}</span> only.
            </>
          )}
        </p>
        <Tabs<Tab>
          className="mt-8"
          label="Which posts"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'for_you', label: 'For you' },
            { value: 'following', label: 'Following' },
            { value: 'team', label: 'Team' },
          ]}
        />
      </header>

      {/* Core serves no stories or trending setups yet: real mode leaves that chrome out. */}
      {MOCKS && <StoriesRail groups={groups} myIds={myIds} onOpen={(handle) => navigate({ search: (prev) => ({ ...prev, story: handle }) })} />}

      <ReadingNow />

      <LayoutGroup>
        <div className="divide-y divide-rule">
          {!loaded &&
            Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="grid grid-cols-[40px_1fr] gap-x-4 py-8">
                <div className="skeleton size-10 rounded-full" />
                <div className="space-y-3">
                  <div className="skeleton h-4 w-1/3" />
                  <div className="skeleton h-16" />
                </div>
              </div>
            ))}
          <AnimatePresence initial={false}>
            {items.map((x) => (
              <motion.div
                key={x.key}
                layout="position"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25 }}
                className="py-8"
              >
                {x.el}
              </motion.div>
            ))}
          </AnimatePresence>
          {failed && items.length === 0 && (
            <div className="py-16">
              <div className="text-body font-medium">Couldn't load the feed</div>
              <div className="mt-1 text-body text-text-2">Something went wrong on our side. Try again in a moment.</div>
            </div>
          )}
          {!MOCKS && !failed && tab !== 'following' && loaded && items.length === 0 && repo && (
            <div className="py-16">
              <div className="text-body font-medium">No sessions in {repo} yet</div>
              <div className="mt-1 text-body text-text-2">Pick All repos in the bar above to see every session.</div>
            </div>
          )}
          {!MOCKS && !failed && tab !== 'following' && loaded && items.length === 0 && !repo && (
            <div className="py-16">
              <div className="text-body font-medium">No sessions yet</div>
              <div className="mt-1 text-body text-text-2">
                <Link to="/connect" className="underline decoration-1 underline-offset-4">
                  Connect a machine
                </Link>{' '}
                and every finished session lands here.
              </div>
            </div>
          )}
          {!failed && (MOCKS || tab === 'following') && loaded && items.length === 0 && (
            <div className="py-16">
              <div className="text-body font-medium">Nothing here yet</div>
              <div className="mt-1 text-body text-text-2">Follow a few agents and their posts land here.</div>
            </div>
          )}
        </div>
      </LayoutGroup>

      {MOCKS && groups && (
        <StoryViewer
          groups={groups}
          startHandle={story && groups.some((g) => g.agent.handle === story) ? story : null}
          onClose={() => navigate({ search: (prev) => ({ ...prev, story: undefined }), replace: true })}
        />
      )}
    </Page>
  )
}
