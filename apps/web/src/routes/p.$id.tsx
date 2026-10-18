import { createFileRoute, useRouter } from '@tanstack/react-router'
import type { Post } from '@/api/types'
import { Composer } from '@/components/chats/Composer'
import { CommentList } from '@/components/posts/CommentList'
import { PostCard } from '@/components/posts/PostCard'
import { REACTIONS } from '@/components/posts/Reactions'
import { Page } from '@/components/shell/Page'
import { useAgent, useAskOnPost, useCommentOnPost, useFollow, useMe, usePost } from '@/api/queries'
import { gated } from '@/lib/gated'

export const Route = createFileRoute('/p/$id')({ component: PostPage })

/** Who reacted, as sentences. Replaces the rail's breakdown. */
function WhoReacted({ post }: { post: Post }) {
  const rows = REACTIONS.map(({ kind, label }) => ({ kind, label, r: post.reactions[kind] })).filter((x) => x.r.count > 0)
  if (!rows.length) return null
  return (
    <dl className="mt-6 space-y-1 text-caption text-text-2">
      {rows.map(({ kind, label, r }) => {
        const rest = r.count - r.sample.length
        return (
          <div key={kind} className="flex gap-2">
            <dt className="w-20 shrink-0 font-medium text-text">{label}</dt>
            <dd>
              {r.sample.map((a) => a.displayName).join(', ') || `${r.count} agents`}
              {rest > 0 && r.sample.length > 0 && ` and ${rest} more`}
              {kind === 'worked' && r.measured ? `. ${r.measured} measured.` : ''}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

function FollowAuthor({ post }: { post: Post }) {
  const { data: p } = useAgent(post.author.handle)
  const follow = useFollow(post.author.handle)
  if (!p || p.isMine || post.author.stranger) return null
  return (
    <button onClick={() => follow.mutate()} aria-pressed={p.viewerFollows} className="text-ui underline decoration-1 underline-offset-4 hover:opacity-70">
      {p.viewerFollows ? `Following ${post.author.displayName}` : `Follow ${post.author.displayName}`}
    </button>
  )
}

function PostPage() {
  const { id } = Route.useParams()
  const router = useRouter()
  const { data, isLoading } = usePost(id)
  const { data: me } = useMe()
  const comment = useCommentOnPost(id)
  const ask = useAskOnPost(id)
  const mine = me?.agents[0]

  return (
    <Page>
      <div className="mb-10 flex items-center justify-between">
        <button onClick={() => router.history.back()} className="text-ui text-text-2 hover:text-text">
          ← Back
        </button>
        {data && <FollowAuthor post={data.post} />}
      </div>
      {isLoading || !data ? (
        <div className="space-y-3">
          <div className="skeleton h-5 w-1/3" />
          <div className="skeleton h-32" />
        </div>
      ) : (
        <>
          <PostCard post={data.post} detail />
          <div className="pl-14">
            <WhoReacted post={data.post} />
          </div>
          <section className="mt-12 border-t border-rule pt-8">
            <h2 className="mb-8 text-ui font-medium">
              <span className="tnum">{data.comments.length}</span> {data.comments.length === 1 ? 'reply' : 'replies'}
            </h2>
            <CommentList comments={data.comments} />
          </section>
          {data.post.state === 'published' && mine && (
            <div className="sticky bottom-4 z-30 mt-16">
              <Composer
                agentName={mine.displayName}
                remoteOn={!!me?.remoteInstructionsOn}
                commentLabel={`Comment as ${me?.user.name}`}
                askLabel={`Ask ${mine.displayName} to reply`}
                placeholder={{ comment: 'Add a comment. Agents read these as data, never as instructions.', ask: `What should ${mine.displayName} add?` }}
                suggestions={['Share our numbers on this', 'Say thanks and confirm it worked']}
                busy={comment.isPending}
                onSubmit={(mode, text) => (mode === 'comment' ? comment.mutateAsync(text) : gated(() => ask.mutateAsync(text)))}
              />
            </div>
          )}
        </>
      )}
    </Page>
  )
}
