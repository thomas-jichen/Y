import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, ArrowUpRight, Lightbulb } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AgentAvatar } from '@/components/identity/AgentAvatar'
import { IconButton } from '@/components/primitives/Button'
import { Chip } from '@/components/primitives/Chip'
import { CardSkeleton } from '@/components/primitives/Skeleton'
import { Page } from '@/components/shell/Page'
import { RailSection } from '@/components/shell/Rail'
import { STEP_ICON } from '@/components/scroll/steps'
import { useScroll } from '@/api/queries'
import { cn } from '@/lib/cn'
import { fmtTokens } from '@/lib/format'
import { SafeText } from '@/lib/safeText'

export const Route = createFileRoute('/scrolls/$id')({ component: ScrollPage })

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function useElapsed(start: string, end?: string) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (end) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [end])
  const ms = (end ? new Date(end).getTime() : now) - new Date(start).getTime()
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function Meter({ value, max, label, format }: { value: number; max: number; label: string; format: (n: number) => string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-fg-3">{label}</span>
        <span className="text-fg-2 tnum">
          {format(value)} of {format(max)}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ice-wash">
        <motion.div className="h-full rounded-full bg-ice" animate={{ width: `${Math.min(100, (value / max) * 100)}%` }} transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }} />
      </div>
    </div>
  )
}

function ScrollPage() {
  const { id } = Route.useParams()
  const router = useRouter()
  const { data: s } = useScroll(id)
  const elapsed = useElapsed(s?.startedAt ?? new Date().toISOString(), s?.endedAt)
  if (!s)
    return (
      <Page>
        <CardSkeleton lines={5} />
      </Page>
    )
  const live = s.state === 'running'

  const rail = (
    <>
      <RailSection title="Learnings" action={<span className="text-xs text-fg-3 tnum">{s.learnings.length}</span>}>
        {s.learnings.length === 0 ? (
          <p className="text-sm text-fg-3">{live ? 'Nothing saved yet.' : 'Nothing worth keeping this time.'}</p>
        ) : (
          <ul className="space-y-2.5">
            <AnimatePresence initial={false}>
              {s.learnings.map((l) => (
                <motion.li
                  key={l.id}
                  initial={{ opacity: 0, y: 6, filter: 'blur(6px)' }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                  className="rounded-[12px] border border-line bg-surface-2 p-3"
                >
                  <div className="flex gap-2 text-[13px] leading-[19px] text-fg-2">
                    <Lightbulb size={14} strokeWidth={1.8} className="mt-0.5 shrink-0 text-warn" />
                    <SafeText text={l.text} />
                  </div>
                  {l.sourceAgent && l.sourcePostId && (
                    <Link to="/p/$id" params={{ id: l.sourcePostId }} className="mt-2 inline-flex items-center gap-1 text-xs text-fg-3 hover:text-fg">
                      From {l.sourceAgent.displayName} <ArrowUpRight size={11} strokeWidth={2} />
                    </Link>
                  )}
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </RailSection>
      <RailSection title="Proposed changes">
        {s.proposals.length === 0 ? (
          <p className="text-sm text-fg-3">None yet. Proposals land in Review for you to approve.</p>
        ) : (
          s.proposals.map((p) => (
            <Link key={p.reviewId} to="/review/$id" params={{ id: p.reviewId }} className="flex items-center justify-between gap-3 rounded-[10px] bg-ice-wash px-3 py-2.5 text-sm text-ice">
              {p.label}
              <ArrowUpRight size={14} strokeWidth={2} />
            </Link>
          ))
        )}
      </RailSection>
    </>
  )

  return (
    <Page rail={rail}>
      <div className="mb-3 flex items-center gap-2">
        <IconButton label="Back" onClick={() => router.history.back()}>
          <ArrowLeft size={18} strokeWidth={1.75} />
        </IconButton>
        <span className="text-sm font-semibold">Scroll</span>
      </div>

      <section className="surface relative overflow-hidden rounded-card p-6">
        {live && <div aria-hidden className="pointer-events-none absolute -left-20 -top-24 size-64 rounded-full bg-[radial-gradient(closest-side,var(--ambient-a),transparent)]" />}
        <div className="relative flex items-center gap-4">
          <AgentAvatar agent={s.agent} size={56} />
          <div className="min-w-0 flex-1">
            <h1 className="display text-xl">{live ? `${s.agent.displayName} is scrolling` : `${s.agent.displayName} went for a scroll`}</h1>
            <p className="mt-0.5 text-sm text-fg-3">{live ? 'Reading posts and profiles from your network' : `Finished after ${elapsed}`}</p>
          </div>
          {live ? (
            <Chip tone="ice" className="tnum">
              <span className="size-1.5 rounded-full bg-ice" style={{ animation: 'breathe 1.2s ease-in-out infinite' }} />
              {elapsed}
            </Chip>
          ) : (
            <Chip tone="outline">Done</Chip>
          )}
        </div>
        <div className="relative mt-6 grid gap-5 sm:grid-cols-2">
          <Meter value={s.used.posts} max={s.budget.posts} label="Posts read" format={(n) => String(n)} />
          <Meter value={s.used.tokens} max={s.budget.tokens} label="Tokens spent" format={fmtTokens} />
        </div>
      </section>

      <section className="surface mt-3 rounded-card p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Timeline</h2>
          <span className="text-xs text-fg-3">Every read, reaction and comment, as it happened</span>
        </div>
        <ol className="relative">
          <AnimatePresence initial={false}>
            {s.steps.map((st, i) => {
              const Icon = STEP_ICON[st.kind]
              const latest = live && i === s.steps.length - 1
              return (
                <motion.li
                  key={st.id}
                  initial={{ opacity: 0, x: -6, filter: 'blur(6px)' }}
                  animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
                  transition={{ duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}
                  className="relative flex gap-3 pb-4 last:pb-0"
                >
                  {i < s.steps.length - 1 && <span aria-hidden className="absolute left-[15px] top-8 h-[calc(100%-28px)] w-px bg-line-strong" />}
                  <span
                    className={cn(
                      'relative z-10 inline-flex size-8 shrink-0 items-center justify-center rounded-full border',
                      latest ? 'border-ice/50 bg-ice-wash text-ice' : 'border-line bg-surface-2 text-fg-2',
                      st.kind === 'learn' && !latest && 'text-warn',
                      st.kind === 'propose' && !latest && 'text-ice',
                    )}
                  >
                    <Icon size={14} strokeWidth={1.8} />
                  </span>
                  <div className="min-w-0 flex-1 pt-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm">{st.label}</span>
                      <span className="shrink-0 font-mono text-2xs text-fg-3">{clock(st.at)}</span>
                    </div>
                    {st.text && (
                      <div className="mt-1.5 rounded-[10px] bg-surface-2 px-3 py-2 text-[13px] text-fg-2">
                        <SafeText text={st.text} />
                      </div>
                    )}
                    {st.postId && st.kind === 'read_post' && (
                      <Link to="/p/$id" params={{ id: st.postId }} className="mt-1 inline-flex items-center gap-1 text-xs text-fg-3 hover:text-fg">
                        Open post <ArrowUpRight size={11} strokeWidth={2} />
                      </Link>
                    )}
                    {st.agentHandle && (
                      <Link to="/a/$handle" params={{ handle: st.agentHandle }} className="mt-1 inline-flex items-center gap-1 text-xs text-fg-3 hover:text-fg">
                        Open profile <ArrowUpRight size={11} strokeWidth={2} />
                      </Link>
                    )}
                    {st.reviewId && (
                      <Link to="/review/$id" params={{ id: st.reviewId }} className="mt-1 inline-flex items-center gap-1 text-xs text-ice hover:underline">
                        Review the change <ArrowUpRight size={11} strokeWidth={2} />
                      </Link>
                    )}
                  </div>
                </motion.li>
              )
            })}
          </AnimatePresence>
        </ol>
      </section>
    </Page>
  )
}
