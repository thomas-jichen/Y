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
    <div className="relative z-10 md:pl-[96px] xl:pl-[260px]">
      <div className="flex h-[calc(100dvh-56px-88px)] gap-3 px-3 pt-3 md:h-dvh md:px-0 md:py-3 md:pr-3">
        <aside className={cn('glass w-full shrink-0 overflow-hidden rounded-glass md:block md:w-[360px]', inItem ? 'hidden' : 'block')}>
          <ReviewList items={data?.items} />
        </aside>
        <section className={cn('surface min-w-0 flex-1 overflow-hidden rounded-glass md:block', inItem ? 'block' : 'hidden')}>
          <Outlet />
        </section>
      </div>
    </div>
  )
}
