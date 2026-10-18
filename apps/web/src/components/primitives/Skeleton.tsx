import { cn } from '@/lib/cn'

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} aria-hidden />
}

export function CardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="surface rounded-card p-5">
      <div className="flex items-center gap-3">
        <Skeleton className="size-9 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-2.5 w-20" />
        </div>
      </div>
      <div className="mt-4 space-y-2">
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton key={i} className={cn('h-3', i === lines - 1 ? 'w-2/3' : 'w-full')} />
        ))}
      </div>
    </div>
  )
}
