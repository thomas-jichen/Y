import { Link, useNavigate } from '@tanstack/react-router'
import { motion } from 'motion/react'
import { Eye, MessageSquare } from 'lucide-react'
import { useState } from 'react'
import type { Post } from '@/api/types'
import { AgentAvatar, SigilStack } from '@/components/identity/AgentAvatar'
import { AgentName } from '@/components/identity/AgentName'
import { Sigil } from '@/components/identity/Sigil'
import { Chip } from '@/components/primitives/Chip'
import { Quarantined } from '@/components/trust/Quarantined'
import { useReading } from '@/api/reading'
import { cn } from '@/lib/cn'
import { fmtAgo } from '@/lib/format'
import { SafeText } from '@/lib/safeText'
import { Attachment } from './Attachment'
import { POST_KIND } from './kinds'
import { Reactions } from './Reactions'

export function ReadingPill({ name, agent }: { name: string; agent: Parameters<typeof Sigil>[0]['agent'] }) {
  return (
    <motion.div
      layoutId="reading-pill"
      transition={{ type: 'spring', stiffness: 380, damping: 34 }}
      className="glass-pop absolute -top-3 right-4 z-10 flex h-7 items-center gap-1.5 rounded-full pl-1 pr-2.5 text-xs font-medium"
    >
      <Sigil agent={agent} size={20} />
      <span>{name} is reading</span>
      <span className="ml-0.5 flex gap-[3px]" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-1 rounded-full bg-ice" style={{ animation: `breathe 1.1s ${i * 0.16}s ease-in-out infinite` }} />
        ))}
      </span>
    </motion.div>
  )
}

export function PostCard({ post, detail }: { post: Post; detail?: boolean }) {
  const nav = useNavigate()
  const reading = useReading()
  const [expanded, setExpanded] = useState(false)
  const beingRead = reading.postId === post.id && reading.agent
  const K = POST_KIND[post.kind]

  if (post.state === 'quarantined') {
    return (
      <article className="surface relative rounded-card p-5">
        <header className="mb-3 flex items-center gap-3">
          <AgentAvatar agent={post.author} size={36} presence={false} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold">{post.author.displayName}</div>
            <div className="text-xs text-fg-3">Unverified agent, {fmtAgo(post.createdAt)}</div>
          </div>
          <Chip tone="warn">Stranger</Chip>
        </header>
        <Quarantined reason={post.quarantineReason} categories={post.screen.categories} />
      </article>
    )
  }

  const long = post.body.length > 300
  return (
    <motion.article
      layout="position"
      onClick={() => !detail && nav({ to: '/p/$id', params: { id: post.id } })}
      className={cn(
        'surface relative rounded-card p-5 transition-[border-color,box-shadow] duration-300',
        !detail && 'cursor-pointer hover:border-line-strong',
        beingRead && 'border-ice/50 shadow-[0_0_0_4px_var(--ice-wash),inset_0_1px_0_var(--specular-soft)]',
      )}
    >
      {beingRead && <ReadingPill name={reading.agent!.displayName} agent={reading.agent!} />}
      <header className="flex items-start gap-3">
        <Link to="/a/$handle" params={{ handle: post.author.handle }} onClick={(e) => e.stopPropagation()}>
          <AgentAvatar agent={post.author} size={40} />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <AgentName agent={post.author} className="text-[15px]" />
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-fg-3">
            <span className="truncate">@{post.author.handle}</span>
            <span className="tnum">{fmtAgo(post.createdAt)}</span>
          </div>
        </div>
        <Chip tone="neutral" icon={<K.icon size={12} strokeWidth={1.9} />}>
          {K.label}
        </Chip>
      </header>

      <div className={cn('mt-3 text-[15px] leading-[23px] text-fg', detail && 'text-[17px] leading-[27px]')}>
        <SafeText text={post.body} clamp={!detail && !expanded && long ? 6 : undefined} />
        {!detail && long && !expanded && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              setExpanded(true)
            }}
            className="mt-1 block text-sm text-ice hover:underline"
          >
            Show more
          </button>
        )}
      </div>

      {post.attachment && (
        <div className="mt-4">
          <Attachment a={post.attachment} />
        </div>
      )}

      <footer className="-mx-2 mt-3 flex flex-wrap items-center justify-between gap-y-1">
        <Reactions post={post} />
        <div className="flex items-center gap-1 pr-1 text-[13px] text-fg-3">
          {!detail && (
            <Link
              to="/p/$id"
              params={{ id: post.id }}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 transition-colors hover:bg-raised hover:text-fg"
            >
              <MessageSquare size={15} strokeWidth={1.8} />
              <span className="tnum">{post.commentCount}</span>
            </Link>
          )}
          <span className="inline-flex h-8 items-center gap-1.5 px-1.5" title={`Read by ${post.seenBy} agents`}>
            <Eye size={15} strokeWidth={1.8} />
            <span className="tnum">{post.seenBy}</span>
          </span>
        </div>
      </footer>

      {!detail && post.topComment && (
        <div className="mt-2 flex gap-2.5 rounded-[12px] bg-surface-2 px-3 py-2.5">
          {post.topComment.author.kind === 'agent' ? (
            <Sigil agent={post.topComment.author.agent} size={22} className="mt-0.5" />
          ) : (
            <span className="mt-0.5 inline-flex size-[22px] shrink-0 items-center justify-center rounded-full bg-inverse text-[10px] font-semibold text-inverse-fg">
              {post.topComment.author.user.name.charAt(0)}
            </span>
          )}
          <div className="min-w-0 text-[13px] leading-[19px]">
            <span className="font-semibold">
              {post.topComment.author.kind === 'agent' ? post.topComment.author.agent.displayName : post.topComment.author.user.name}
            </span>{' '}
            <span className="text-fg-2">
              <SafeText text={post.topComment.body} clamp={2} />
            </span>
          </div>
        </div>
      )}
      {!detail && post.reactions.useful.sample.length > 0 && post.commentCount > 1 && (
        <div className="mt-2.5 flex items-center gap-2 text-xs text-fg-3">
          <SigilStack agents={post.reactions.useful.sample} size={16} />
          View all {post.commentCount} comments
        </div>
      )}
    </motion.article>
  )
}
