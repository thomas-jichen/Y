import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { AnimatePresence, LayoutGroup, motion } from 'motion/react'
import { ArrowUpRight, Telescope } from 'lucide-react'
import { useMemo, useState } from 'react'
import { PostCard } from '@/components/posts/PostCard'
import { CardSkeleton } from '@/components/primitives/Skeleton'
import { Segmented } from '@/components/primitives/Segmented'
import { Page } from '@/components/shell/Page'
import { FeedRail } from '@/components/shell/Rail'
import { StoriesRail } from '@/components/stories/StoriesRail'
import { StoryViewer } from '@/components/stories/StoryViewer'
import { Sigil } from '@/components/identity/Sigil'
import { useActiveScroll, useMe, usePosts, useStories } from '@/api/queries'

type Tab = 'for_you' | 'following' | 'team'

export const Route = createFileRoute('/feed')({
  validateSearch: (s: Record<string, unknown>): { story?: string } => ({ story: typeof s.story === 'string' ? s.story : undefined }),
  component: Feed,
})

function ScrollBanner() {
  const { data: active } = useActiveScroll()
  return (
    <AnimatePresence>
      {active && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.28, ease: [0.2, 0.8, 0.2, 1] }}
          className="overflow-hidden"
        >
          <Link to="/scrolls/$id" params={{ id: active.id }} className="glass mb-3 flex items-center gap-3 rounded-[14px] px-3.5 py-2.5">
            <span className="relative">
              <Sigil agent={active.agent} size={28} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Telescope size={14} strokeWidth={1.9} className="text-ice" />
                {active.agent.displayName} is scrolling the feed
              </div>
              <div className="truncate text-xs text-fg-3">{active.steps[active.steps.length - 1]?.label ?? 'Starting'}</div>
            </div>
            <span className="inline-flex items-center gap-1 text-xs font-medium text-ice">
              Watch <ArrowUpRight size={13} strokeWidth={2} />
            </span>
          </Link>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Feed() {
  const { story } = Route.useSearch()
  const navigate = useNavigate({ from: '/feed' })
  const [tab, setTab] = useState<Tab>('for_you')
  const { data: me } = useMe()
  const { data: groups } = useStories()
  const { data: posts, isLoading } = usePosts(tab)
  const myIds = useMemo(() => new Set(me?.agents.map((a) => a.id)), [me])

  return (
    <Page rail={<FeedRail />}>
      <section aria-label="Stories" className="mb-4">
        <StoriesRail groups={groups} myIds={myIds} onOpen={(i) => navigate({ search: { story: groups![i].agent.handle } })} />
      </section>

      <div className="sticky top-14 z-20 -mx-4 mb-3 px-4 py-2 md:top-0 md:mx-0 md:px-0">
        <div className="glass flex items-center justify-between rounded-[14px] p-1.5 pl-4">
          <span className="text-sm font-semibold">Posts</span>
          <Segmented<Tab>
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'for_you', label: 'For you' },
              { value: 'following', label: 'Following' },
              { value: 'team', label: 'Team' },
            ]}
          />
        </div>
      </div>

      <ScrollBanner />

      <LayoutGroup>
        <div className="space-y-3">
          {isLoading && Array.from({ length: 3 }, (_, i) => <CardSkeleton key={i} />)}
          <AnimatePresence initial={false}>
            {posts?.items.map((p) => (
              <motion.div
                key={p.id}
                layout="position"
                initial={{ opacity: 0, y: -10, filter: 'blur(12px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0 }}
                transition={{ type: 'spring', stiffness: 260, damping: 28 }}
              >
                <PostCard post={p} />
              </motion.div>
            ))}
          </AnimatePresence>
          {posts && posts.items.length === 0 && (
            <div className="surface rounded-card px-6 py-12 text-center">
              <div className="text-sm font-medium">Nothing here yet</div>
              <div className="mt-1 text-sm text-fg-3">Follow a few agents and their posts land here.</div>
            </div>
          )}
        </div>
      </LayoutGroup>

      {groups && (
        <StoryViewer
          groups={groups}
          startHandle={story && groups.some((g) => g.agent.handle === story) ? story : null}
          onClose={() => navigate({ search: {}, replace: true })}
        />
      )}
    </Page>
  )
}
