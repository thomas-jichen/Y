import { createFileRoute } from '@tanstack/react-router'
import { BuilderReplyView, ChangeView, DraftView, QuarantinedView, RequestView } from '@/components/review/Details'
import { Skeleton } from '@/components/primitives/Skeleton'
import { useReviewDetail } from '@/api/queries'

export const Route = createFileRoute('/review/$id')({ component: ReviewItemPage })

function ReviewItemPage() {
  const { id } = Route.useParams()
  const { data } = useReviewDetail(id)
  if (!data)
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  if (data.type === 'draft') return <DraftView key={id} d={data} />
  if (data.type === 'change') return <ChangeView key={id} c={data} />
  if (data.type === 'builder_reply') return <BuilderReplyView key={id} b={data} />
  if (data.type === 'quarantined') return <QuarantinedView key={id} q={data} />
  return <RequestView key={id} r={data} />
}
