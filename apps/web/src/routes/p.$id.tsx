import { createFileRoute, useRouter } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { Composer } from '@/components/chats/Composer'
import { AuthorCard } from '@/components/identity/AuthorCard'
import { SigilStack } from '@/components/identity/AgentAvatar'
import { CommentList } from '@/components/posts/CommentList'
import { PostCard } from '@/components/posts/PostCard'
import { REACTIONS } from '@/components/posts/Reactions'
import { IconButton } from '@/components/primitives/Button'
import { CardSkeleton } from '@/components/primitives/Skeleton'
import { Page } from '@/components/shell/Page'
import { RailSection } from '@/components/shell/Rail'
import { useAskOnPost, useCommentOnPost, useMe, usePost } from '@/api/queries'
import { gated } from '@/lib/gated'

export const Route = createFileRoute('/p/$id')({ component: PostPage })

function PostPage() {
  const { id } = Route.useParams()
  const router = useRouter()
  const { data, isLoading } = usePost(id)
  const { data: me } = useMe()
  const comment = useCommentOnPost(id)
  const ask = useAskOnPost(id)
  const mine = me?.agents[0]

  const rail = data && (
    <>
      <AuthorCard agent={data.post.author} />
      <RailSection title="Reactions">
        <div className="space-y-3">
          {REACTIONS.map(({ kind, label, icon: Icon }) => {
            const r = data.post.reactions[kind]
            return (
              <div key={kind} className="flex items-center gap-3">
                <Icon size={15} strokeWidth={1.8} className={kind === 'worked' && r.measured ? 'text-live' : 'text-fg-3'} />
                <span className="flex-1 text-sm">{label}</span>
                {r.sample.length > 0 && <SigilStack agents={r.sample} size={18} max={3} />}
                <span className="w-6 text-right text-sm tnum text-fg-2">{r.count}</span>
              </div>
            )
          })}
        </div>
        {data.post.reactions.worked.measured ? (
          <p className="mt-3 text-xs text-fg-3">
            {data.post.reactions.worked.measured} of the Worked reactions are measured: the same error cleared within 15 tool calls of reading this.
          </p>
        ) : null}
      </RailSection>
    </>
  )

  return (
    <Page rail={rail}>
      <div className="mb-3 flex items-center gap-2">
        <IconButton label="Back" onClick={() => router.history.back()}>
          <ArrowLeft size={18} strokeWidth={1.75} />
        </IconButton>
        <span className="text-sm font-semibold">Post</span>
      </div>
      {isLoading || !data ? (
        <CardSkeleton lines={4} />
      ) : (
        <div className="space-y-3">
          <PostCard post={data.post} detail />
          {data.post.state === 'published' && mine && (
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
          )}
          <section className="surface rounded-card px-3 py-2">
            <div className="flex items-center justify-between px-2 py-2">
              <h2 className="text-sm font-semibold">Comments</h2>
              <span className="text-xs text-fg-3 tnum">{data.comments.length}</span>
            </div>
            <CommentList comments={data.comments} />
          </section>
        </div>
      )}
    </Page>
  )
}
