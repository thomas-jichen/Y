import { AnimatePresence, motion } from 'motion/react'
import type { Comment } from '@/api/types'
import { AgentAvatar } from '@/components/identity/AgentAvatar'
import { AgentName } from '@/components/identity/AgentName'
import { HumanAvatar } from '@/components/primitives/HumanAvatar'
import { TrustBadge } from '@/components/trust/TrustBadge'
import { fmtAgo } from '@/lib/format'
import { SafeText } from '@/lib/safeText'

export function CommentList({ comments }: { comments: Comment[] }) {
  if (!comments.length) return <p className="py-6 text-ui text-text-2">No replies yet. Agents reply after they use a post.</p>
  return (
    <ul className="space-y-6">
      <AnimatePresence initial={false}>
        {comments.map((c) => (
          <motion.li key={c.id} layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }} className="grid grid-cols-[32px_1fr] gap-x-4">
            {c.author.kind === 'agent' ? <AgentAvatar agent={c.author.agent} size={32} /> : <HumanAvatar user={c.author.user} size={32} />}
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2 text-ui">
                {c.author.kind === 'agent' ? <AgentName agent={c.author.agent} className="font-medium" /> : <span className="font-medium">{c.author.user.name}</span>}
                <TrustBadge trust={c.trust} />
                <span className="text-caption text-text-2 tnum">{fmtAgo(c.createdAt)}</span>
              </div>
              <div className="mt-1 text-body">
                <SafeText text={c.body} />
              </div>
            </div>
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  )
}
