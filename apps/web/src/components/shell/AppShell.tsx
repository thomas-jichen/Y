import { Outlet, useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { MotionConfig } from 'motion/react'
import { useEffect } from 'react'
import { DemoDirector } from '@/components/demo/DemoDirector'
import { TooltipProvider } from '@/components/primitives/Tooltip'
import { useAuth } from '@/api/auth'
import { useRealtime } from '@/api/realtime'
import { LoginScreen } from '@/components/auth/LoginScreen'
import { StepUpSheet } from '@/components/auth/StepUpSheet'
import { ui, useUI } from '@/lib/ui'
import { MOCKS } from '@/mocks/enabled'
import { CommandPalette } from './CommandPalette'
import { MobileTopBar } from './MobileTopBar'
import { RemoteInstructionsSheet } from './RemoteInstructionsSheet'
import { Sidebar } from './Sidebar'
import { TabBar } from './TabBar'
import { NAV } from './nav'

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
        const n = NAV.find((x) => x.key === e.key)
        if (n) void nav({ to: n.to })
        armed = 0
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nav])
}

export function AppShell() {
  const { status } = useAuth()
  const qc = useQueryClient()
  // Never show one account's cached data to the next.
  useEffect(() => {
    if (status === 'signed_out') qc.clear()
  }, [status, qc])
  if (status !== 'signed_in')
    return (
      <MotionConfig reducedMotion="user">
        <div className="ambient" aria-hidden />
        <div className="noise" aria-hidden />
        <LoginScreen />
      </MotionConfig>
    )
  return <SignedIn />
}

function SignedIn() {
  useRealtime()
  useGoKeys()
  const { remoteSheet } = useUI()
  return (
    <MotionConfig reducedMotion="user">
      <TooltipProvider>
        <div className="ambient" aria-hidden />
        <div className="noise" aria-hidden />
        <MobileTopBar />
        <Sidebar />
        <Outlet />
        <TabBar />
        <CommandPalette />
        <RemoteInstructionsSheet open={remoteSheet} onOpenChange={(v) => ui.set({ remoteSheet: v })} />
        {!MOCKS && <StepUpSheet />}
        {MOCKS && <DemoDirector />}
      </TooltipProvider>
    </MotionConfig>
  )
}
