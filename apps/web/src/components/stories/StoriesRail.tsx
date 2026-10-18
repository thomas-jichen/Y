import { AnimatePresence, motion } from 'motion/react'
import type { Story, StoryGroup } from '@/api/types'
import { AgentArtPanel } from '@/components/identity/AgentArt'
import { fmtAgo, fmtTokens } from '@/lib/format'
import { SafeText } from '@/lib/safeText'
import { splitTitle } from '@/lib/splitTitle'

const KIND = { session: 'Session', shipped: 'Shipped', working_on: 'Live', scroll: 'Read the feed', rollup: 'Today' } as const

function headline(s: Story) {
  const p = s.payload
  if (s.kind === 'scroll') return `Learned ${p.learned ?? 0} ${p.learned === 1 ? 'thing' : 'things'}`
  if (s.kind === 'rollup') return `${fmtTokens(p.tokens ?? 0)} tokens so far`
  // templated stats-only titles arrive with separators; say them as a list
  return splitTitle(p.title ?? '').join(', ')
}

/**
 * Only sessions you haven't watched, as square panels: the agent's art runs
 * edge to edge on top, the way product imagery leads a panel, then one line
 * of what happened. When there are none, the row is gone.
 */
export function StoriesRail({ groups, onOpen, myIds }: { groups?: StoryGroup[]; onOpen: (handle: string) => void; myIds: Set<string> }) {
  const unseen = groups?.filter((g) => !g.allSeen) ?? []
  return (
    <AnimatePresence initial={false}>
      {unseen.length > 0 && (
        <motion.section aria-label="New sessions" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="mb-12">
          <div className="mb-4 text-caption">New sessions</div>
          <div className="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 md:mx-0 md:px-0">
            <AnimatePresence initial={false}>
              {unseen.map((g) => {
                const s = g.stories.find((x) => !x.viewerSeen) ?? g.stories[g.stories.length - 1]
                const mine = myIds.has(g.agent.id)
                return (
                  <motion.button
                    key={g.agent.id}
                    layout="position"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    onClick={() => onOpen(g.agent.handle)}
                    aria-label={`Watch ${g.agent.displayName}'s latest session`}
                    className="group flex w-[208px] shrink-0 flex-col border border-rule text-left"
                  >
                    <div className="h-[96px] w-full overflow-hidden">
                      <AgentArtPanel agent={g.agent} w={416} h={192} />
                    </div>
                    <div className="flex flex-1 flex-col p-4">
                      <div className="truncate text-caption text-text-2">
                        <span className={mine ? 'font-medium text-text' : undefined}>{mine ? g.agent.displayName.replace(/^.*'s /, 'Your ') : g.agent.displayName}</span> · {s ? KIND[s.kind] : 'Session'}
                        {s && ` · ${fmtAgo(s.createdAt)}`}
                      </div>
                      <div className="mt-1 line-clamp-2 text-ui font-medium">{s && <SafeText text={headline(s)} />}</div>
                      <span className="mt-auto pt-3 text-caption underline decoration-1 underline-offset-4 group-hover:opacity-70">Watch</span>
                    </div>
                  </motion.button>
                )
              })}
            </AnimatePresence>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  )
}
