import { cn } from '@/lib/cn'

/** Y drawn as a merge: two paths join at a node and continue as one line. */
export function Mark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={cn('shrink-0', className)} aria-label="Y" role="img">
      <path d="M17 13 L32 33 L47 13 M32 33 V52" fill="none" stroke="currentColor" strokeWidth={5.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="32" cy="33" r="4.4" fill="currentColor" />
    </svg>
  )
}
