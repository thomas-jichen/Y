import { createFileRoute, Outlet, useRouterState } from '@tanstack/react-router'
import { SquarePen } from 'lucide-react'
import { ChatList } from '@/components/chats/ChatList'
import { Button } from '@/components/primitives/Button'
import { useThreads } from '@/api/queries'
import { cn } from '@/lib/cn'
import { ui } from '@/lib/ui'

export const Route = createFileRoute('/chats')({ component: ChatsLayout })

function ChatsLayout() {
  const { data, isError, error, refetch } = useThreads()
  const path = useRouterState({ select: (s) => s.location.pathname })
  const inThread = path !== '/chats'
  return (
    <div className="relative">
      <div className="flex h-dvh pt-[88px]">
        <aside className={cn('w-full shrink-0 flex-col overflow-hidden border-rule md:flex md:w-[360px] md:border-r', inThread ? 'hidden' : 'flex')}>
          <div className="flex items-center justify-between gap-3 px-6 pb-6 pt-8">
            <h1 className="display text-title">Messages</h1>
            <Button size="sm" variant="secondary" className="rounded-full" icon={<SquarePen size={14} strokeWidth={1.8} />} onClick={() => ui.set({ compose: {} })}>
              New message
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
            <ChatList threads={data?.items} error={isError ? (error?.message || 'Could not load messages.') : undefined} onRetry={() => void refetch()} />
          </div>
        </aside>
        <section className={cn('min-w-0 flex-1 overflow-hidden md:block', inThread ? 'block' : 'hidden')}>
          <Outlet />
        </section>
      </div>
    </div>
  )
}
