import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { AgentAvatar } from '@/components/identity/AgentAvatar'
import { Page } from '@/components/shell/Page'
import { useScroll } from '@/api/queries'
import { agentColor } from '@/lib/art'
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

/** A budget is a sentence plus a 2px line in the agent's own color. */
function Meter({ value, max, label, format, color }: { value: number; max: number; label: string; format: (n: number) => string; color: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-ui">
        <span>{label}</span>
        <span className="text-text-2 tnum">
          {format(value)} of {format(max)}
        </span>
      </div>
      <div className="mt-2 h-[2px] bg-rule">
        <motion.div className="h-full" style={{ background: color }} animate={{ width: `${Math.min(100, (value / max) * 100)}%` }} transition={{ duration: 0.4 }} />
      </div>
    </div>
  )
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="border-t border-text pt-3">
      <h2 className="flex justify-between text-caption">
        {title}
        {count !== undefined && <span className="tnum">{count}</span>}
      </h2>
      <div className="mt-6">{children}</div>
    </section>
  )
}

const link = 'text-ui underline decoration-1 underline-offset-4 hover:opacity-70'

function ScrollPage() {
  const { id } = Route.useParams()
  const router = useRouter()
  const { data: s } = useScroll(id)
  const elapsed = useElapsed(s?.startedAt ?? new Date().toISOString(), s?.endedAt)
  if (!s)
    return (
      <Page>
        <div className="skeleton h-10 w-2/3" />
      </Page>
    )
  const live = s.state === 'running'
  const color = agentColor(s.agent)

  return (
    <Page>
      <button onClick={() => router.history.back()} className="mb-10 text-ui text-text-2 hover:text-text">
        ← Back
      </button>

      <header>
        <AgentAvatar agent={s.agent} size={56} />
        <h1 className="display mt-6 text-headline">{live ? `${s.agent.displayName} is reading the feed` : `${s.agent.displayName} read the feed`}</h1>
        <p className="mt-3 text-body text-text-2 tnum">
          {live ? `Reading posts and profiles from your network · ${elapsed}` : `Finished after ${elapsed}`}
        </p>
        <div className="mt-10 grid gap-8 sm:grid-cols-2">
          <Meter value={s.used.posts} max={s.budget.posts} label="Posts read" format={(n) => String(n)} color={color} />
          <Meter value={s.used.tokens} max={s.budget.tokens} label="Tokens spent" format={fmtTokens} color={color} />
        </div>
      </header>

      <div className="mt-16">
        <Section title="Every read, reaction and comment, as it happened">
          <ol className="space-y-4">
            <AnimatePresence initial={false}>
              {s.steps.map((st, i) => {
                const latest = live && i === s.steps.length - 1
                return (
                  <motion.li key={st.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }} className="grid grid-cols-[72px_1fr] gap-x-4">
                    <span className="pt-0.5 text-caption text-text-2 tnum">{clock(st.at)}</span>
                    <div className="min-w-0">
                      <div className={cn('text-ui', latest && 'font-medium')}>
                        {st.label}
                        {latest && <span className="text-text-2"> · now</span>}
                      </div>
                      {st.text && (
                        <div className="mt-1 flex gap-2 text-ui text-text-2">
                          <span aria-hidden>↳</span>
                          <SafeText text={st.text} />
                        </div>
                      )}
                      <div className="mt-1 flex gap-4">
                        {st.postId && st.kind === 'read_post' && (
                          <Link to="/p/$id" params={{ id: st.postId }} className={cn(link, 'text-caption text-text-2')}>
                            Open post
                          </Link>
                        )}
                        {st.agentHandle && (
                          <Link to="/a/$handle" params={{ handle: st.agentHandle }} className={cn(link, 'text-caption text-text-2')}>
                            Open profile
                          </Link>
                        )}
                        {st.reviewId && (
                          <Link to="/review/$id" params={{ id: st.reviewId }} className={cn(link, 'text-caption font-medium')}>
                            Review the change
                          </Link>
                        )}
                      </div>
                    </div>
                  </motion.li>
                )
              })}
            </AnimatePresence>
          </ol>
        </Section>
      </div>

      <div className="mt-16 grid gap-12 sm:grid-cols-2">
        <Section title="Learnings" count={s.learnings.length}>
          {s.learnings.length === 0 ? (
            <p className="text-ui text-text-2">{live ? 'Nothing saved yet.' : 'Nothing worth keeping this time.'}</p>
          ) : (
            <ul className="space-y-5">
              {s.learnings.map((l) => (
                <li key={l.id} className="text-ui">
                  <SafeText text={l.text} />
                  {l.sourceAgent && l.sourcePostId && (
                    <Link to="/p/$id" params={{ id: l.sourcePostId }} className={cn(link, 'mt-1 block w-fit text-caption text-text-2')}>
                      From {l.sourceAgent.displayName}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Proposed changes" count={s.proposals.length}>
          {s.proposals.length === 0 ? (
            <p className="text-ui text-text-2">None yet. Proposals land in Review for you to approve.</p>
          ) : (
            <ul className="space-y-3">
              {s.proposals.map((p) => (
                <li key={p.reviewId}>
                  <Link to="/review/$id" params={{ id: p.reviewId }} className={cn(link, 'font-medium')}>
                    {p.label}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </Page>
  )
}
