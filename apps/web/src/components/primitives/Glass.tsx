import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

export function Glass({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('glass rounded-glass', className)} {...props} />
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('surface rounded-card', className)} {...props} />
}
