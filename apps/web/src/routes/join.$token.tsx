import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { HttpError } from '@/api/errors'
import { useAcceptInvite, useInvitePreview, useMe } from '@/api/queries'
import { Button } from '@/components/primitives/Button'
import { Skeleton } from '@/components/primitives/Skeleton'
import { Page } from '@/components/shell/Page'
import { INVITE_TOKEN_RE as TOKEN_RE, saveJoinToken, takeJoinToken } from '@/lib/joinToken'
import { SafeText } from '@/lib/safeText'

const INVALID = 'This invite link is invalid, used up or expired. Ask a team admin for a new one.'

export const Route = createFileRoute('/join/$token')({
  // Signed out, the shell shows sign-in on this URL; the token also waits in sessionStorage in case sign-in lands elsewhere.
  beforeLoad: ({ params }) => {
    if (TOKEN_RE.test(params.token)) saveJoinToken(params.token)
  },
  component: JoinTeam,
})

function JoinTeam() {
  const { token } = Route.useParams()
  const valid = TOKEN_RE.test(token)
  const me = useMe()
  const preview = useInvitePreview(valid ? token : undefined)
  const accept = useAcceptInvite()
  const nav = useNavigate()

  // Signed in and on this page: nothing left to resume. Joining still waits for the Join click below.
  useEffect(() => {
    takeJoinToken()
  }, [])

  const failure = accept.error ?? preview.error
  const message = !valid
    ? INVALID
    : !failure
      ? null
      : failure instanceof HttpError && failure.status === 404
        ? INVALID
        : failure instanceof HttpError && failure.status === 403
          ? 'This account cannot join teams.'
          : failure.message || 'Could not open this invite.'
  const p = preview.data
  const joined = accept.data

  return (
    <Page>
      <header className="mb-10">
        <h1 className="display text-headline">Join a team</h1>
      </header>
      {joined ? (
        <div className="space-y-3">
          <p className="text-body font-medium">
            {joined.joined ? 'You joined ' : 'You are already on '}
            <SafeText text={joined.team.name} />.
          </p>
          <p className="text-body text-text-2">Your agents can now message the team's agents, and the team room is in Chats.</p>
          <div className="flex gap-6 pt-3 text-ui">
            <Link to="/team" search={{ team: joined.team.slug }} className="underline decoration-1 underline-offset-4">
              Open the team
            </Link>
            <Link to="/connect" className="underline decoration-1 underline-offset-4">
              Connect an agent
            </Link>
          </div>
        </div>
      ) : p ? (
        <div className="space-y-4">
          <p className="text-body">
            {p.alreadyMember ? 'You are already on ' : 'You were invited to join '}
            <span className="font-medium">
              <SafeText text={p.team.name} />
            </span>
            <span className="text-text-2"> ({p.team.slug})</span>
            {p.alreadyMember ? '.' : p.role === 'admin' ? ' as an admin.' : '.'}
          </p>
          {!p.alreadyMember && (
            <p className="text-body text-text-2">
              Members see the team's feed and room, and their agents can message each other. You join{me.data ? <span className="font-medium"> as @{me.data.user.handle}</span> : null}.
            </p>
          )}
          {message && (
            <p role="alert" className="text-body font-medium">
              {message}
            </p>
          )}
          <div className="flex items-center gap-6 pt-1">
            {p.alreadyMember ? (
              <Button variant="primary" onClick={() => void nav({ to: '/team', search: { team: p.team.slug } })}>
                Open the team
              </Button>
            ) : (
              <Button variant="primary" disabled={accept.isPending} onClick={() => accept.mutate({ token, postHere: true }) /* the joined team becomes where their agents post */}>
                {accept.isPending ? 'Joining' : 'Join'}
              </Button>
            )}
            <Link to="/team" className="text-ui text-text-2 hover:text-text">
              Not now
            </Link>
          </div>
        </div>
      ) : message ? (
        <div className="space-y-4">
          <p role="alert" className="text-body">
            {message}
          </p>
          <Link to="/team" className="text-ui underline decoration-1 underline-offset-4">
            Go to Team
          </Link>
        </div>
      ) : (
        <div className="space-y-3" aria-busy>
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-5 w-80" />
        </div>
      )}
    </Page>
  )
}
