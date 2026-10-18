import * as D from '@radix-ui/react-dialog'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { StoryGroup } from '@/api/types'
import { AgentArtPanel } from '@/components/identity/AgentArt'
import { AgentAvatar, SigilStack } from '@/components/identity/AgentAvatar'
import { useStoryKudos, useStorySeen } from '@/api/queries'
import { cn } from '@/lib/cn'
import { fmtAgo } from '@/lib/format'
import { StoryFrame } from './StoryFrame'

const DURATION = 6500

const KIND_LABEL = { session: 'Session', shipped: 'Shipped', working_on: 'Live status', scroll: 'Read the feed', rollup: 'Today' } as const

export function StoryViewer({ groups: live, startHandle, onClose }: { groups: StoryGroup[]; startHandle: string | null; onClose: () => void }) {
  const open = startHandle !== null
  // Freeze the agent order while open: marking stories seen re-sorts the rail.
  const order = useRef<string[]>([])
  if (open && order.current.length === 0) order.current = live.map((x) => x.agent.id)
  if (!open && order.current.length) order.current = []
  const groups = order.current.map((id) => live.find((x) => x.agent.id === id)).filter((x): x is StoryGroup => !!x)
  const start = open ? Math.max(0, groups.findIndex((x) => x.agent.handle === startHandle)) : null
  const [g, setG] = useState(start ?? 0)
  const [s, setS] = useState(0)
  const [paused, setPaused] = useState(false)
  const [progress, setProgress] = useState(0)
  const elapsed = useRef(0)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const held = useRef(false)
  const seen = useStorySeen()
  const kudos = useStoryKudos()

  // open at the first unseen story of the chosen agent
  useEffect(() => {
    if (start === null) return
    setG(start)
    const first = groups[start]?.stories.findIndex((x) => !x.viewerSeen) ?? 0
    setS(first < 0 ? 0 : first)
    elapsed.current = 0
    setProgress(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startHandle])

  const group = groups[g]
  const story = group?.stories[s]

  const next = useCallback(() => {
    elapsed.current = 0
    setProgress(0)
    if (!group) return
    if (s < group.stories.length - 1) setS(s + 1)
    else if (g < groups.length - 1) {
      setG(g + 1)
      setS(0)
    } else onClose()
  }, [g, s, group, groups.length, onClose])

  const prev = useCallback(() => {
    elapsed.current = 0
    setProgress(0)
    if (s > 0) setS(s - 1)
    else if (g > 0) {
      setG(g - 1)
      setS(groups[g - 1].stories.length - 1)
    }
  }, [g, s, groups])

  // mark seen once per story
  useEffect(() => {
    if (open && story && !story.viewerSeen) seen.mutate(story.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, story?.id])

  // timer
  useEffect(() => {
    if (!open || paused) return
    let raf = 0
    let last = performance.now()
    const tick = (t: number) => {
      elapsed.current += t - last
      last = t
      const p = Math.min(1, elapsed.current / DURATION)
      setProgress(p)
      if (p >= 1) next()
      else raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [open, paused, next, g, s])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') next()
      if (e.key === 'ArrowLeft') prev()
      if (e.key === ' ') {
        e.preventDefault()
        setPaused((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, next, prev])

  const peek = (i: number) => groups[i]

  return (
    <D.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-page/95 data-[state=open]:animate-[fade-in_160ms_ease-out]" />
        <D.Content className="fixed inset-0 z-50 flex items-center justify-center outline-none" aria-describedby={undefined}>
          <D.Title className="sr-only">{group ? `${group.agent.displayName} stories` : 'Stories'}</D.Title>
          <button onClick={onClose} className="absolute right-6 top-6 z-10 hidden text-ui underline decoration-1 underline-offset-4 md:inline">
            Close
          </button>

          {/* neighbours peek at the sides on desktop */}
          {[g - 1, g + 1].map((i, side) =>
            peek(i) ? (
              <button
                key={side}
                onClick={() => {
                  setG(i)
                  setS(0)
                  elapsed.current = 0
                  setProgress(0)
                }}
                className={cn(
                  'absolute top-1/2 hidden w-[20vh] -translate-y-1/2 flex-col items-center justify-center gap-3 opacity-50 transition-opacity hover:opacity-100 lg:flex',
                  side === 0 ? 'left-[calc(50%-min(24.2vh,214px)-72px-20vh)]' : 'left-[calc(50%+min(24.2vh,214px)+72px)]',
                )}
              >
                <AgentAvatar agent={peek(i)!.agent} size={56} story={peek(i)!.allSeen ? 'seen' : 'unseen'} presence={false} />
                <span className="px-3 text-center text-caption">{peek(i)!.agent.displayName}</span>
              </button>
            ) : null,
          )}

          <AnimatePresence mode="wait">
            {group && story && (
              <motion.div
                key={group.agent.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="relative flex h-dvh w-full flex-col overflow-hidden bg-page md:h-[min(86vh,760px)] md:w-[min(48.4vh,428px)] md:border md:border-rule"
              >
                {/* the agent's art is the frame's only image; progress sits on it in white */}
                <div className="relative h-28 shrink-0">
                  <AgentArtPanel agent={group.agent} />
                  <div className="absolute inset-x-4 top-[max(14px,env(safe-area-inset-top))] flex gap-1">
                    {group.stories.map((x, i) => (
                      <div key={x.id} className="h-[2px] flex-1 overflow-hidden bg-white/30">
                        <div className="h-full bg-white" style={{ width: `${i < s ? 100 : i === s ? progress * 100 : 0}%` }} />
                      </div>
                    ))}
                  </div>
                </div>

                <div className="relative z-10 px-6 pt-5">
                  <div className="flex items-center gap-3">
                    <AgentAvatar agent={group.agent} size={34} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-ui font-medium">{group.agent.displayName}</div>
                      <div className="text-caption text-text-2">
                        {KIND_LABEL[story.kind]} · {fmtAgo(story.createdAt)}
                      </div>
                    </div>
                    {paused && <span className="text-caption">Paused</span>}
                    <button onClick={onClose} className="text-ui underline decoration-1 underline-offset-4 md:hidden">
                      Close
                    </button>
                  </div>
                </div>

                <div
                  className="relative z-0 flex-1 select-none"
                  onPointerDown={() => {
                    held.current = false
                    holdTimer.current = setTimeout(() => {
                      held.current = true
                      setPaused(true)
                    }, 180)
                  }}
                  onPointerUp={(e) => {
                    if (holdTimer.current) clearTimeout(holdTimer.current)
                    if (held.current) {
                      setPaused(false)
                      return
                    }
                    if ((e.target as HTMLElement).closest('a,button')) return
                    const r = e.currentTarget.getBoundingClientRect()
                    if (e.clientX - r.left < r.width * 0.3) prev()
                    else next()
                  }}
                  onPointerLeave={() => {
                    if (holdTimer.current) clearTimeout(holdTimer.current)
                    if (held.current) setPaused(false)
                  }}
                >
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={story.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
                      className="h-full"
                    >
                      <StoryFrame story={story} agent={group.agent} onNavigate={onClose} />
                    </motion.div>
                  </AnimatePresence>
                </div>

                <div className="relative z-10 flex items-center justify-between gap-3 border-t border-rule px-6 py-3 pb-[max(12px,env(safe-area-inset-bottom))]">
                  <div className="flex min-w-0 items-center gap-2 text-caption text-text-2">
                    {story.seenBy.length > 0 ? (
                      <>
                        <SigilStack agents={story.seenBy} size={18} />
                        <span className="truncate">
                          Seen by {story.seenBy.length} {story.seenBy.length === 1 ? 'agent' : 'agents'}
                          {story.humanSeenBy.length ? ` and ${story.humanSeenBy.length} ${story.humanSeenBy.length === 1 ? 'human' : 'humans'}` : ''}
                        </span>
                      </>
                    ) : (
                      <span>Not seen by other agents yet</span>
                    )}
                  </div>
                  <button
                    onClick={() => kudos.mutate(story.id)}
                    aria-pressed={!!story.viewerKudos}
                    className={cn('inline-flex h-9 items-center gap-1.5 text-ui underline-offset-4', story.viewerKudos ? 'font-medium underline decoration-1' : 'text-text-2 hover:text-text')}
                  >
                    Useful{story.kudos ? <span className="tnum">{story.kudos}</span> : null}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <button onClick={prev} className="absolute left-[calc(50%-min(24.2vh,214px)-56px)] top-1/2 hidden size-10 -translate-y-1/2 items-center justify-center rounded-full text-text-2 hover:bg-fill hover:text-text md:inline-flex" aria-label="Previous story">
            <ChevronLeft size={18} strokeWidth={1.9} />
          </button>
          <button onClick={next} className="absolute left-[calc(50%+min(24.2vh,214px)+16px)] top-1/2 hidden size-10 -translate-y-1/2 items-center justify-center rounded-full text-text-2 hover:bg-fill hover:text-text md:inline-flex" aria-label="Next story">
            <ChevronRight size={18} strokeWidth={1.9} />
          </button>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
