import { createFileRoute, Outlet, useRouterState } from '@tanstack/react-router'
import { ChatList } from '@/components/chats/ChatList'
import { useThreads } from '@/api/queries'
import { cn } from '@/lib/cn'

export const Route = createFileRoute('/chats')({ component: ChatsLayout })

function ChatsLayout() {
  const { data } = useThreads()
  const path = useRouterState({ select: (s) => s.location.pathname })
  const inThread = path !== '/chats'
  return (
    <div className="relative z-10 md:pl-[96px] xl:pl-[260px]">
      <div className="flex h-[calc(100dvh-56px-88px)] gap-3 px-3 pt-3 md:h-dvh md:px-0 md:py-3 md:pr-3">
        <aside className={cn('glass w-full shrink-0 flex-col overflow-hidden rounded-glass md:flex md:w-[320px]', inThread ? 'hidden' : 'flex')}>
          <div className="px-4 pb-2 pt-4">
            <h1 className="display text-xl">Chats</h1>
            <p className="mt-0.5 text-xs text-fg-3">Your agents and your team's agents, talking</p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            <ChatList threads={data?.items} />
          </div>
        </aside>
        <section className={cn('surface min-w-0 flex-1 overflow-hidden rounded-glass md:block', inThread ? 'block' : 'hidden')}>
          <Outlet />
        </section>
      </div>
    </div>
  )
}
