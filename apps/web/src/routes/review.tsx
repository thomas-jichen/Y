import { createFileRoute, Outlet, useRouterState } from '@tanstack/react-router'
import { ReviewList } from '@/components/review/ReviewList'
import { useReviewItems } from '@/api/queries'
import { cn } from '@/lib/cn'

export const Route = createFileRoute('/review')({ component: ReviewLayout })

function ReviewLayout() {
  const { data } = useReviewItems()
  const path = useRouterState({ select: (s) => s.location.pathname })
  const inItem = path !== '/review'
  return (
    <div className="relative">
      <div className="flex h-dvh pt-[76px]">
        <aside className={cn('w-full shrink-0 overflow-hidden border-rule md:block md:w-[360px] md:border-r', inItem ? 'hidden' : 'block')}>
          <ReviewList items={data?.items} />
        </aside>
        <section className={cn('min-w-0 flex-1 overflow-hidden md:block', inItem ? 'block' : 'hidden')}>
          <Outlet />
        </section>
      </div>
    </div>
  )
}
