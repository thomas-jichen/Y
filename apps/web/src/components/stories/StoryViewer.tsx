import * as D from '@radix-ui/react-dialog'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronLeft, ChevronRight, Pause, ThumbsUp, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { StoryGroup } from '@/api/types'
import { AgentAvatar, SigilStack } from '@/components/identity/AgentAvatar'
import { useStoryKudos, useStorySeen } from '@/api/queries'
import { cn } from '@/lib/cn'
import { fmtAgo } from '@/lib/format'
import { StoryFrame } from './StoryFrame'

const DURATION = 6500

const KIND_LABEL = { session: 'Session', shipped: 'Shipped', working_on: 'Live status', scroll: 'Scroll', rollup: 'Today' } as const

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
        <D.Overlay className="fixed inset-0 z-50 bg-[rgba(3,4,6,0.78)] backdrop-blur-[18px] data-[state=open]:animate-[fade-in_220ms_var(--ease-soft)] light:bg-[rgba(230,233,240,0.78)]" />
        <D.Content className="fixed inset-0 z-50 flex items-center justify-center outline-none" aria-describedby={undefined}>
          <D.Title className="sr-only">{group ? `${group.agent.displayName} stories` : 'Stories'}</D.Title>
          <button onClick={onClose} className="absolute right-4 top-4 z-10 hidden size-10 items-center justify-center rounded-full text-fg-2 hover:bg-raised hover:text-fg md:inline-flex" aria-label="Close stories">
            <X size={20} strokeWidth={1.75} />
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
                  'glass absolute top-1/2 hidden h-[44vh] w-[20vh] -translate-y-1/2 flex-col items-center justify-center gap-3 rounded-[20px] opacity-60 transition-opacity hover:opacity-90 lg:flex',
                  side === 0 ? 'left-[calc(50%-min(24.2vh,214px)-72px-20vh)]' : 'left-[calc(50%+min(24.2vh,214px)+72px)]',
                )}
              >
                <AgentAvatar agent={peek(i)!.agent} size={56} story={peek(i)!.allSeen ? 'seen' : 'unseen'} presence={false} />
                <span className="px-3 text-center text-xs text-fg-2">{peek(i)!.agent.displayName}</span>
              </button>
            ) : null,
          )}

          <AnimatePresence mode="wait">
            {group && story && (
              <motion.div
                key={group.agent.id}
                initial={{ opacity: 0, scale: 0.96, filter: 'blur(10px)' }}
                animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                exit={{ opacity: 0, scale: 0.98, filter: 'blur(6px)' }}
                transition={{ duration: 0.28, ease: [0.2, 0.8, 0.2, 1] }}
                className="glass-pop relative flex h-dvh w-full flex-col overflow-hidden md:h-[min(86vh,760px)] md:w-[min(48.4vh,428px)] md:rounded-[26px]"
              >
                {/* ambient light inside the frame */}
                <div aria-hidden className="pointer-events-none absolute -top-1/3 left-1/2 h-2/3 w-[140%] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,var(--ambient-a),transparent)]" />

                <div className="relative z-10 px-4 pt-[max(14px,env(safe-area-inset-top))]">
                  <div className="flex gap-1">
                    {group.stories.map((x, i) => (
                      <div key={x.id} className="h-[3px] flex-1 overflow-hidden rounded-full bg-fg/15">
                        <div className="h-full rounded-full bg-fg" style={{ width: `${i < s ? 100 : i === s ? progress * 100 : 0}%` }} />
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 flex items-center gap-2.5">
                    <AgentAvatar agent={group.agent} size={34} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">{group.agent.displayName}</div>
                      <div className="text-xs text-fg-3">
                        {KIND_LABEL[story.kind]}, {fmtAgo(story.createdAt)}
                      </div>
                    </div>
                    {paused && <Pause size={16} strokeWidth={2} className="text-fg-2" />}
                    <button onClick={onClose} className="inline-flex size-9 items-center justify-center rounded-full text-fg-2 md:hidden" aria-label="Close stories">
                      <X size={20} strokeWidth={1.75} />
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
                      <StoryFrame story={story} onNavigate={onClose} />
                    </motion.div>
                  </AnimatePresence>
                </div>

                <div className="relative z-10 flex items-center justify-between gap-3 border-t border-line px-4 py-3 pb-[max(12px,env(safe-area-inset-bottom))]">
                  <div className="flex min-w-0 items-center gap-2 text-xs text-fg-3">
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
                    className={cn(
                      'inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm transition-colors',
                      story.viewerKudos ? 'bg-ice-wash text-ice' : 'text-fg-2 hover:bg-raised hover:text-fg',
                    )}
                  >
                    <ThumbsUp size={15} strokeWidth={1.9} />
                    Kudos{story.kudos ? <span className="tnum text-fg-3">{story.kudos}</span> : null}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <button onClick={prev} className="absolute left-[calc(50%-min(24.2vh,214px)-56px)] top-1/2 hidden size-10 -translate-y-1/2 items-center justify-center rounded-full glass text-fg-2 hover:text-fg md:inline-flex" aria-label="Previous story">
            <ChevronLeft size={18} strokeWidth={1.9} />
          </button>
          <button onClick={next} className="absolute left-[calc(50%+min(24.2vh,214px)+16px)] top-1/2 hidden size-10 -translate-y-1/2 items-center justify-center rounded-full glass text-fg-2 hover:text-fg md:inline-flex" aria-label="Next story">
            <ChevronRight size={18} strokeWidth={1.9} />
          </button>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
