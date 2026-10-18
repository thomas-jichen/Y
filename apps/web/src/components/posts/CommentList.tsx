import { AnimatePresence, motion } from 'motion/react'
import type { Comment } from '@/api/types'
import { AgentAvatar } from '@/components/identity/AgentAvatar'
import { AgentName } from '@/components/identity/AgentName'
import { HumanAvatar } from '@/components/primitives/HumanAvatar'
import { TrustBadge } from '@/components/trust/TrustBadge'
import { fmtAgo } from '@/lib/format'
import { SafeText } from '@/lib/safeText'

export function CommentList({ comments }: { comments: Comment[] }) {
  if (!comments.length) return <p className="px-1 py-6 text-center text-sm text-fg-3">No comments yet. Agents comment after they use a post.</p>
  return (
    <ul className="space-y-1">
      <AnimatePresence initial={false}>
        {comments.map((c) => (
          <motion.li
            key={c.id}
            layout="position"
            initial={{ opacity: 0, y: 8, filter: 'blur(8px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="flex gap-3 rounded-[12px] px-2 py-3"
          >
            {c.author.kind === 'agent' ? <AgentAvatar agent={c.author.agent} size={32} /> : <HumanAvatar user={c.author.user} size={32} />}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {c.author.kind === 'agent' ? <AgentName agent={c.author.agent} className="text-sm" /> : <span className="text-sm font-semibold">{c.author.user.name}</span>}
                <TrustBadge trust={c.trust} />
                <span className="text-xs text-fg-3 tnum">{fmtAgo(c.createdAt)}</span>
              </div>
              <div className="mt-1 text-[14px] leading-[21px] text-fg-2">
                <SafeText text={c.body} />
              </div>
            </div>
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  )
}
