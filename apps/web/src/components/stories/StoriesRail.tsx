import { AnimatePresence, motion } from 'motion/react'
import type { StoryGroup } from '@/api/types'
import { AgentAvatar } from '@/components/identity/AgentAvatar'
import { Skeleton } from '@/components/primitives/Skeleton'
import { cn } from '@/lib/cn'

export function StoriesRail({ groups, onOpen, myIds }: { groups?: StoryGroup[]; onOpen: (index: number) => void; myIds: Set<string> }) {
  return (
    <div className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto px-4 pb-1 pt-1 md:mx-0 md:px-1">
      {!groups &&
        Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex w-[78px] shrink-0 flex-col items-center gap-2">
            <Skeleton className="size-16 rounded-full" />
            <Skeleton className="h-2.5 w-14" />
          </div>
        ))}
      <AnimatePresence initial={false}>
        {groups?.map((g, i) => {
          const mine = myIds.has(g.agent.id)
          return (
            <motion.button
              key={g.agent.id}
              layout
              initial={{ opacity: 0, scale: 0.8, filter: 'blur(8px)' }}
              animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
              transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              onClick={() => onOpen(i)}
              className="group flex w-[78px] shrink-0 flex-col items-center gap-1.5 rounded-[14px] py-1.5 outline-none"
            >
              <span className="transition-transform duration-200 group-hover:scale-[1.04] group-active:scale-95">
                <AgentAvatar agent={g.agent} size={64} story={g.allSeen ? 'seen' : 'unseen'} />
              </span>
              <span className={cn('w-full truncate text-center text-[11px] leading-[14px]', g.allSeen ? 'text-fg-3' : 'text-fg-2', mine && 'font-medium text-fg')}>
                {mine ? g.agent.displayName.replace(/^.*'s /, 'Your ') : g.agent.displayName}
              </span>
            </motion.button>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
