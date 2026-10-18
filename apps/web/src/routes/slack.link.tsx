import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Page } from '@/components/shell/Page'
import { HttpError } from '@/api/errors'
import { Button } from '@/components/primitives/Button'
import { useMe, useSlackLink, useSlackLinkPreview } from '@/api/queries'

/** Where the token waits while a signed-out visitor goes through GitHub sign-in (AppShell resumes it). */
const SLACK_LINK_TOKEN_KEY = 'y.slackLinkToken'

const INVALID = 'This link is invalid, used or expired. Run /y connect in Slack again.'

export const Route = createFileRoute('/slack/link')({
  validateSearch: (s: Record<string, unknown>): { token?: string } => (typeof s.token === 'string' ? { token: s.token } : {}),
  beforeLoad: ({ search }) => {
    if (!search.token) return
    try {
      sessionStorage.setItem(SLACK_LINK_TOKEN_KEY, search.token)
    } catch {
      /* storage unavailable: the token still works from the URL while signed in */
    }
  },
  component: SlackLink,
})

function storedToken(): string | undefined {
  try {
    return sessionStorage.getItem(SLACK_LINK_TOKEN_KEY) ?? undefined
  } catch {
    return undefined
  }
}

function clearStoredToken() {
  try {
    sessionStorage.removeItem(SLACK_LINK_TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

function SlackLink() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const me = useMe()
  const link = useSlackLink()
  const [token] = useState(() => search.token ?? storedToken())
  const preview = useSlackLinkPreview(token)

  // Never link on load or on resume after sign-in: a forwarded link would bind this Y account to someone
  // else's Slack user. The token is only read here; POST /slack/link waits for the Link click below.
  // It stays in sessionStorage (so a step-up sign-in can come back here) until it is used, invalid or cancelled.
  useEffect(() => {
    // Keep the token out of history and Referer headers.
    if (search.token) void navigate({ to: '/slack/link', search: {}, replace: true })
  }, [search.token, navigate])
  const gone = (e: unknown) => e instanceof HttpError && e.status === 404
  useEffect(() => {
    if (link.isSuccess || gone(link.error) || gone(preview.error)) clearStoredToken()
  }, [link.isSuccess, link.error, preview.error])

  const failure = link.error ?? preview.error
  const message = !failure
    ? null
    : failure instanceof HttpError && failure.status === 404
      ? INVALID
      : failure instanceof HttpError && failure.code === 'STEP_UP_REQUIRED'
        ? 'Sign in again to link Slack, then press Link.'
        : failure.message || 'Could not link your Slack account.'
  const p = preview.data
  const slackName = p ? (p.slackUserName ? `@${p.slackUserName}` : p.slackUserId) : ''

  return (
    <Page>
      <header className="mb-10">
        <h1 className="display text-headline">Connect Slack</h1>
      </header>
      {!token ? (
        <p className="text-body text-text-2">Open this page from the link that /y connect sends you in Slack.</p>
      ) : link.isSuccess ? (
        <div className="space-y-3">
          <p className="text-body font-medium">
            Slack is connected.
            {link.data.workspaceName && <span className="text-text-2"> {link.data.workspaceName}</span>}
          </p>
          <p className="text-body text-text-2">You'll get notifications from the Y bot in Slack.</p>
          <div className="flex gap-6 pt-3 text-ui">
            <Link to="/connect" hash="slack" className="underline decoration-1 underline-offset-4">
              Slack settings
            </Link>
            <Link to="/chats" className="underline decoration-1 underline-offset-4">
              Open chats
            </Link>
          </div>
        </div>
      ) : p ? (
        <div className="space-y-4">
          <p className="text-body">
            Link Slack user <span className="font-medium">{slackName}</span>
            {p.slackUserName && <span className="text-text-2"> ({p.slackUserId})</span>}
            {p.workspaceName && (
              <>
                {' '}
                in <span className="font-medium">{p.workspaceName}</span>
              </>
            )}{' '}
            to your Y account{me.data ? <span className="font-medium"> @{me.data.user.handle}</span> : null}?
          </p>
          <p className="text-body text-text-2">
            That Slack account will see your notifications and can approve, decline and release items for you. Only continue if it's
            yours and you just ran /y connect.
          </p>
          {message && (
            <p role="alert" className="text-body font-medium">
              {message}
            </p>
          )}
          <div className="flex items-center gap-6 pt-1">
            <Button variant="primary" disabled={link.isPending} onClick={() => link.mutate(token)}>
              {link.isPending ? 'Linking…' : 'Link Slack account'}
            </Button>
            <Link to="/" onClick={clearStoredToken} className="text-ui underline decoration-1 underline-offset-4">
              Cancel
            </Link>
          </div>
        </div>
      ) : message ? (
        <p role="alert" className="text-body font-medium">
          {message}
        </p>
      ) : (
        <p className="text-body text-text-2">Checking your link…</p>
      )}
    </Page>
  )
}
