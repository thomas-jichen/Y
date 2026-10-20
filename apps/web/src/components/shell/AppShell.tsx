import { Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { MotionConfig } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react'
import { DemoDirector } from '@/components/demo/DemoDirector'
import { TooltipProvider } from '@/components/primitives/Tooltip'
import { useAuth } from '@/api/auth'
import { useRealtime } from '@/api/realtime'
import { LoginScreen } from '@/components/auth/LoginScreen'
import { StepUpSheet } from '@/components/auth/StepUpSheet'
import { NewMessageSheet } from '@/components/chats/NewMessageSheet'
import { takeJoinToken } from '@/lib/joinToken'
import { ui, useUI } from '@/lib/ui'
import { MOCKS } from '@/mocks/enabled'
import { CommandPalette } from './CommandPalette'
import { RemoteInstructionsSheet } from './RemoteInstructionsSheet'
import { REPO_BAR_OFFSET, RepoBar, useRepoBar } from './RepoBar'
import { TopBar } from './TopBar'
import { GO } from './nav'

function useGoKeys() {
  const nav = useNavigate()
  useEffect(() => {
    let armed = 0
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'g') {
        armed = Date.now()
        return
      }
      if (Date.now() - armed < 900) {
        const n = GO.find((x) => x.key === e.key)
        if (n) void nav({ to: n.to })
        armed = 0
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nav])
}

export function AppShell() {
  const { status, account } = useAuth()
  const qc = useQueryClient()
  // Never show one account's cached data to the next.
  useEffect(() => {
    if (status === 'signed_out') qc.clear()
  }, [status, qc])
  // A different account signed in without a sign-out in between (another GitHub user in this tab):
  // drop the previous one's cache too. SignedIn is keyed by account below, so its pages remount.
  // (A layout effect: it runs before the new account's pages paint.)
  const shownFor = useRef(account)
  useLayoutEffect(() => {
    if (status !== 'signed_in' || shownFor.current === account) return
    if (shownFor.current !== undefined) qc.clear()
    shownFor.current = account
  }, [status, account, qc])
  if (status !== 'signed_in')
    return (
      <MotionConfig reducedMotion="user">
        <LoginScreen />
      </MotionConfig>
    )
  return <SignedIn key={account} />
}

/** A Slack link token saved before sign-in (routes/slack.link.tsx) resumes here, wherever sign-in landed. The page only previews it; linking still needs the Link click. */
function useResumeSlackLink() {
  const nav = useNavigate()
  const pathname = useLocation({ select: (l) => l.pathname })
  useEffect(() => {
    try {
      if (pathname !== '/slack/link' && sessionStorage.getItem('y.slackLinkToken')) void nav({ to: '/slack/link', search: {} })
    } catch {
      /* storage unavailable */
    }
  }, [pathname, nav])
}

/**
 * An invite link opened while signed out (routes/join.$token.tsx saved its token) resumes here once,
 * wherever sign-in landed. The join page only previews it; joining still needs the Join click.
 */
function useResumeJoin() {
  const nav = useNavigate()
  const pathname = useLocation({ select: (l) => l.pathname })
  useEffect(() => {
    if (pathname.startsWith('/join/')) return
    const token = takeJoinToken()
    if (token) void nav({ to: '/join/$token', params: { token } })
  }, [pathname, nav])
}

function SignedIn() {
  useRealtime()
  useGoKeys()
  useResumeSlackLink()
  useResumeJoin()
  const { remoteSheet } = useUI()
  const repoBar = useRepoBar()
  return (
    <MotionConfig reducedMotion="user">
      <TooltipProvider>
        <TopBar />
        {repoBar && <RepoBar model={repoBar} />}
        {/* Pages start below the floating bars: they add --repo-bar-h to their top padding. */}
        <div className="contents" style={repoBar ? ({ '--repo-bar-h': REPO_BAR_OFFSET } as CSSProperties) : undefined}>
          <Outlet />
        </div>
        <CommandPalette />
        <RemoteInstructionsSheet open={remoteSheet} onOpenChange={(v) => ui.set({ remoteSheet: v })} />
        <NewMessageSheet />
        {!MOCKS && <StepUpSheet />}
        {MOCKS && <DemoDirector />}
      </TooltipProvider>
    </MotionConfig>
  )
}
