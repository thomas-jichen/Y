import { Link, useNavigate } from '@tanstack/react-router'
import { motion } from 'motion/react'
import { useState } from 'react'
import type { AgentRef, Post, Trust } from '@/api/types'
import { AgentArt } from '@/components/identity/AgentArt'
import { AgentAvatar } from '@/components/identity/AgentAvatar'
import { AgentName } from '@/components/identity/AgentName'
import { Quarantined } from '@/components/trust/Quarantined'
import { ScreenChip, TrustBadge } from '@/components/trust/TrustBadge'
import { useReading } from '@/api/reading'
import { cn } from '@/lib/cn'
import { fmtAgo } from '@/lib/format'
import { SafeText } from '@/lib/safeText'
import { Attachment } from './Attachment'
import { POST_KIND } from './kinds'
import { Reactions } from './Reactions'

/** Which agent is reading this post right now. Moves from post to post with the reading session. */
export function ReadingPill({ name, agent }: { name: string; agent: AgentRef }) {
  return (
    <motion.span
      layoutId="reading-pill"
      transition={{ type: 'spring', stiffness: 380, damping: 34 }}
      className="inline-flex shrink-0 items-center gap-2 text-caption font-medium"
    >
      <AgentArt agent={agent} size={16} />
      {name} is reading
    </motion.span>
  )
}

/** Posts are team-only, so an author is a teammate unless core marks it a stranger. */
const authorTrust = (a: AgentRef): Trust => (a.stranger ? 'stranger' : 'teammate')

/** Core's reasons for a post that was never flagged (removed by its owner, still screening): the flagged copy would be false. */
const NOT_FLAGGED = new Set(['removed', 'screening', 'not published'])

/**
 * A post sits on the page: no card. Hairlines between posts come from the list.
 * Avatar in the margin, a one-line header, the body, then text-only actions.
 */
export function PostCard({ post, detail }: { post: Post; detail?: boolean }) {
  const nav = useNavigate()
  const reading = useReading()
  const [expanded, setExpanded] = useState(false)
  const beingRead = reading.postId === post.id && reading.agent

  if (post.state === 'quarantined') {
    return (
      <article className="grid grid-cols-[40px_1fr] gap-x-4">
        <AgentAvatar agent={post.author} size={40} presence={false} />
        <div className="min-w-0">
          <header className="flex h-6 items-center gap-2 text-ui">
            <span className="truncate font-medium">{post.author.displayName}</span>
            <span className="text-text-2">Unverified · {fmtAgo(post.createdAt)}</span>
          </header>
          <Quarantined
            className="mt-2"
            reason={post.quarantineReason}
            categories={post.screen.categories}
            compact={!!post.quarantineReason && NOT_FLAGGED.has(post.quarantineReason)}
          />
        </div>
      </article>
    )
  }

  const long = post.body.length > 300
  return (
    <motion.article
      layout="position"
      onClick={() => !detail && nav({ to: '/p/$id', params: { id: post.id } })}
      className={cn('grid grid-cols-[40px_1fr] gap-x-4', !detail && 'cursor-pointer')}
    >
      <Link to="/a/$handle" params={{ handle: post.author.handle }} onClick={(e) => e.stopPropagation()} aria-label={post.author.displayName} className="self-start">
        <AgentAvatar agent={post.author} size={40} />
      </Link>
      <div className="min-w-0">
        <header className="flex h-6 items-center gap-2 text-ui">
          <AgentName agent={post.author} className="shrink-0 font-medium" />
          <TrustBadge trust={authorTrust(post.author)} />
          <ScreenChip label={post.screen.label} compact />
          <span className="min-w-0 truncate text-text-2">
            <span className="hidden font-mono text-caption sm:inline">@{post.author.handle} · </span>{POST_KIND[post.kind].label} · <span className="tnum">{fmtAgo(post.createdAt)}</span>
          </span>
          <span className="flex-1" />
          {beingRead && <ReadingPill name={reading.agent!.displayName} agent={reading.agent!} />}
        </header>

        <div className={cn('mt-2', detail ? 'text-read' : 'text-body')}>
          <SafeText text={post.body} clamp={!detail && !expanded && long ? 6 : undefined} />
          {!detail && long && !expanded && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setExpanded(true)
              }}
              className="mt-1 block text-ui underline decoration-1 underline-offset-4"
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

        <footer className="mt-3 flex flex-wrap items-center justify-between gap-x-6">
          <Reactions post={post} />
          {!detail && post.commentCount > 0 && (
            <Link to="/p/$id" params={{ id: post.id }} onClick={(e) => e.stopPropagation()} className="text-ui text-text-2 hover:text-text">
              <span className="tnum">{post.commentCount}</span> {post.commentCount === 1 ? 'reply' : 'replies'}
            </Link>
          )}
        </footer>

        {!detail && post.topComment && (
          <div className="mt-2 flex gap-2 text-ui">
            <span aria-hidden className="text-text-2">
              ↳
            </span>
            <div className="min-w-0">
              <span className="font-medium">
                {post.topComment.author.kind === 'agent' ? post.topComment.author.agent.displayName : post.topComment.author.user.name}
              </span>{' '}
              <TrustBadge trust={post.topComment.trust} /> <ScreenChip label={post.topComment.screen.label} compact />{' '}
              <span className="text-text-2">
                <SafeText text={post.topComment.body} clamp={2} />
              </span>
            </div>
          </div>
        )}
      </div>
    </motion.article>
  )
}
