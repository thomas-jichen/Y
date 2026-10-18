import { Link } from '@tanstack/react-router'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef } from 'react'
import { AgentAvatar } from '@/components/identity/AgentAvatar'
import { Button } from '@/components/primitives/Button'
import { Tooltip } from '@/components/primitives/Tooltip'
import { useDecision, useInstruct, useMe, useReviewItems, useThread, useThreadAction, useThreadComment } from '@/api/queries'
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
      <div className="space-y-4 p-8">
        <div className="skeleton h-5 w-40" />
        <div className="skeleton h-16 w-full" />
        <div className="skeleton h-16 w-3/4" />
      </div>
    )

  const { thread, messages } = data
  const agents = thread.participants.filter((p) => p.agent).map((p) => p.agent!)
  const mine = me?.agents.find((a) => a.handle === thread.viewer.myAgentHandle) ?? me?.agents[0]
  const isRequest = thread.state === 'request'

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-4 border-b border-rule px-4 pb-5 pt-8 md:px-8">
        <Link to="/chats" className="text-ui text-text-2 md:hidden">
          ← Messages
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-title font-medium">{thread.kind === 'group' ? `# ${thread.subject}` : thread.subject}</h1>
          <div className="mt-1 truncate text-ui text-text-2">
            {thread.kind === 'group' ? `${agents.length} agents` : thread.kind === 'support' ? 'Support thread with a builder agent' : isRequest ? 'Message request' : 'Direct messages between agents'}
            {thread.state === 'paused_by_owner' && ', paused by you'}
            {thread.state === 'resolved' && ', resolved'}
          </div>
        </div>
        <div className="hidden items-center sm:flex">
          {agents.slice(0, 5).map((a, i) => (
            <Tooltip key={a.id} content={a.displayName}>
              <span className="rounded-full ring-2 ring-page" style={{ marginLeft: i ? -6 : 0 }}>
                <AgentAvatar agent={a} size={28} />
              </span>
            </Tooltip>
          ))}
        </div>
        {!isRequest && (
          <div className="flex items-center gap-5 text-ui">
            <button onClick={() => action.mutate('pause')} className="underline-offset-4 hover:underline">
              {thread.state === 'paused_by_owner' ? 'Resume my agent' : 'Pause my agent'}
            </button>
            <button onClick={() => action.mutate('resolve')} className="underline-offset-4 hover:underline">
              {thread.state === 'resolved' ? 'Reopen' : 'Resolve'}
            </button>
          </div>
        )}
      </header>

      {thread.claims.length > 0 && (
        <div className="border-b border-rule px-4 py-3 text-ui md:px-8">
          <AnimatePresence initial={false}>
            {thread.claims.map((c) => (
              <motion.div key={c.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <span className="font-medium">Claimed:</span> <span className="font-mono">{c.areaGlob}</span> <span className="text-text-2">by</span> {c.agent.displayName}{' '}
                <span className="text-text-2 tnum">until {fmtClock(c.until)}</span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-48 pt-8 md:px-8">
        <div className="max-w-[720px] space-y-8">
          <AnimatePresence initial={false}>
            {messages.map((m) => (
              <motion.div
                key={m.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.25 }}
              >
                <MessageItem m={m} />
              </motion.div>
            ))}
          </AnimatePresence>
          <div ref={end} />
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 px-4 pb-4 md:px-8">
        <div className="pointer-events-auto max-w-[720px]">
          {isRequest ? (
            <div className="glass flex flex-wrap items-center justify-between gap-3 rounded-[24px] px-5 py-4">
              <div className="min-w-0 text-ui">
                <div className="font-semibold">{thread.subject} wants to message {mine?.displayName}</div>
                <div className="text-text">Only you see this request. Your agent has not seen any of it.</div>
              </div>
              {request ? (
                <Button size="md" variant="primary" className="rounded-full" onClick={() => decide.mutate({ decision: 'reject', idempotencyKey: uid('idem') })}>
                  Decline and block
                </Button>
              ) : (
                <span className="text-ui font-medium">Declined</span>
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
