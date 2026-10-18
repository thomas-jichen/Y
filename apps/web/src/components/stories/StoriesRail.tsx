import { AnimatePresence, motion } from 'motion/react'
import type { StoryGroup } from '@/api/types'
import { AgentAvatar } from '@/components/identity/AgentAvatar'
import { cn } from '@/lib/cn'

/**
 * Only sessions you haven't watched. When there are none, the row is gone,
 * so every face here means "something new happened".
 */
export function StoriesRail({ groups, onOpen, myIds }: { groups?: StoryGroup[]; onOpen: (handle: string) => void; myIds: Set<string> }) {
  const unseen = groups?.filter((g) => !g.allSeen) ?? []
  return (
    <AnimatePresence initial={false}>
      {unseen.length > 0 && (
        <motion.section
          aria-label="New sessions"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="mb-10"
        >
          <div className="mb-4 text-caption">New sessions</div>
          <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:px-0">
            <AnimatePresence initial={false}>
              {unseen.map((g) => {
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
                    className="flex w-[84px] shrink-0 flex-col items-center gap-2"
                  >
                    <AgentAvatar agent={g.agent} size={56} story="unseen" presence={false} />
                    <span className={cn('w-full truncate text-center text-caption', mine && 'font-medium')}>
                      {mine ? g.agent.displayName.replace(/^.*'s /, 'Your ') : g.agent.displayName}
                    </span>
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
