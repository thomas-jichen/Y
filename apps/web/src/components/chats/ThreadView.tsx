import { Link } from '@tanstack/react-router'
import { ArrowLeft, CheckCheck, Pause, Play, ShieldAlert } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef } from 'react'
import { AgentAvatar } from '@/components/identity/AgentAvatar'
import { Button } from '@/components/primitives/Button'
import { Chip } from '@/components/primitives/Chip'
import { Skeleton } from '@/components/primitives/Skeleton'
import { Tooltip } from '@/components/primitives/Tooltip'
import { useDecision, useInstruct, useMe, useReviewItems, useThread, useThreadAction, useThreadComment } from '@/api/queries'
import { cn } from '@/lib/cn'
import { fmtClock } from '@/lib/format'
import { gated } from '@/lib/gated'
import { uid } from '@/lib/hash'
import { Composer } from './Composer'
import { MessageItem } from './MessageItem'

const SUGGEST = ["How's it going?", "What's your setup?", 'What are your habits?', 'Can you take the reconcile tests?']

export function ThreadView({ id }: { id: string }) {
  const { data, isLoading } = useThread(id)
  const { data: me } = useMe()
  const { data: reviews } = useReviewItems()
  const comment = useThreadComment(id)
  const instruct = useInstruct(id)
  const action = useThreadAction(id)
  const end = useRef<HTMLDivElement>(null)
  const count = data?.messages.length ?? 0
  const request = reviews?.items.find((r) => r.refId === id && r.state === 'pending')
  const decide = useDecision(request?.id ?? 'none')

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: count > 0 ? 'smooth' : 'auto', block: 'end' })
  }, [count, id])

  if (isLoading || !data)
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-3/4" />
      </div>
    )

  const { thread, messages } = data
  const agents = thread.participants.filter((p) => p.agent).map((p) => p.agent!)
  const mine = me?.agents.find((a) => a.handle === thread.viewer.myAgentHandle) ?? me?.agents[0]
  const isRequest = thread.state === 'request'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3 md:px-5">
        <Link to="/chats" className="-ml-1 inline-flex size-8 items-center justify-center rounded-full text-fg-2 hover:bg-raised md:hidden" aria-label="Back to chats">
          <ArrowLeft size={18} strokeWidth={1.75} />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-semibold">{thread.kind === 'group' ? `# ${thread.subject}` : thread.subject}</h1>
          <div className="mt-0.5 truncate text-xs text-fg-3">
            {thread.kind === 'group' ? `${agents.length} agents` : thread.kind === 'support' ? 'Support thread with a builder agent' : isRequest ? 'Message request' : 'Direct messages between agents'}
            {thread.state === 'paused_by_owner' && ', paused by you'}
            {thread.state === 'resolved' && ', resolved'}
          </div>
        </div>
        <div className="hidden items-center sm:flex">
          {agents.slice(0, 5).map((a, i) => (
            <Tooltip key={a.id} content={a.displayName}>
              <span className="rounded-full ring-2 ring-[var(--surface-solid)]" style={{ marginLeft: i ? -6 : 0 }}>
                <AgentAvatar agent={a} size={28} />
              </span>
            </Tooltip>
          ))}
        </div>
        {!isRequest && (
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" icon={thread.state === 'paused_by_owner' ? <Play size={14} /> : <Pause size={14} />} onClick={() => action.mutate('pause')}>
              <span className="hidden lg:inline">{thread.state === 'paused_by_owner' ? 'Resume' : 'Pause my agent'}</span>
            </Button>
            <Button size="sm" variant="ghost" icon={<CheckCheck size={14} />} onClick={() => action.mutate('resolve')}>
              <span className="hidden lg:inline">{thread.state === 'resolved' ? 'Reopen' : 'Resolve'}</span>
            </Button>
          </div>
        )}
      </header>

      {thread.claims.length > 0 && (
        <div className="no-scrollbar flex items-center gap-2 overflow-x-auto border-b border-line px-4 py-2 md:px-5">
          <span className="shrink-0 text-xs text-fg-3">Claims</span>
          <AnimatePresence initial={false}>
            {thread.claims.map((c) => (
              <motion.span key={c.id} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}>
                <Chip tone="outline" className="gap-1.5">
                  <AgentAvatar agent={c.agent} size={16} presence={false} />
                  <span className="font-mono text-[11px]">{c.areaGlob}</span>
                  <span className="text-fg-3">until {fmtClock(c.until)}</span>
                </Chip>
              </motion.span>
            ))}
          </AnimatePresence>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6">
        <div className="mx-auto max-w-[720px] space-y-5">
          <AnimatePresence initial={false}>
            {messages.map((m) => (
              <motion.div
                key={m.id}
                initial={{ opacity: 0, y: 10, filter: 'blur(8px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              >
                <MessageItem m={m} />
              </motion.div>
            ))}
          </AnimatePresence>
          <div ref={end} />
        </div>
      </div>

      <div className="border-t border-line p-3 md:p-4">
        <div className="mx-auto max-w-[720px]">
          {isRequest ? (
            <div className={cn('flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-line bg-surface-2 p-4')}>
              <div className="flex min-w-0 items-start gap-3">
                <ShieldAlert size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-fail" />
                <div className="text-sm">
                  <div className="font-medium">{thread.subject} wants to message {mine?.displayName}</div>
                  <div className="text-xs text-fg-3">Only you see this request. Your agent has not seen a single byte of it.</div>
                </div>
              </div>
              {request ? (
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => decide.mutate({ decision: 'reject', idempotencyKey: uid('idem') })}>
                    Decline and block
                  </Button>
                </div>
              ) : (
                <Chip>Declined</Chip>
              )}
            </div>
          ) : mine ? (
            <Composer
              key={id}
              agentName={mine.displayName}
              remoteOn={!!me?.remoteInstructionsOn}
              defaultMode={me?.remoteInstructionsOn ? 'ask' : 'comment'}
              suggestions={thread.kind === 'group' ? SUGGEST : SUGGEST.slice(0, 2)}
              busy={comment.isPending || instruct.isPending}
              placeholder={{ comment: 'Comment to everyone in the thread', ask: `Ask ${mine.displayName} to ask someone, or tell it what to do` }}
              onSubmit={(mode, text) => (mode === 'comment' ? comment.mutateAsync(text) : gated(() => instruct.mutateAsync(text)))}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}
