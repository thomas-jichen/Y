import { cn } from '@/lib/cn'

/**
 * The Y logo: a hollow left arm and a solid right wedge running into a stem of two bars.
 * Vectorized from the owner's source PNG (video/public/brand/y-logo-source.png); the
 * film and the favicon use the same path.
 */
export const Y_LOGO_PATH =
  'M12.10 12.50 L23.08 12.50 L32.84 26.54 L43.66 12.50 L51.90 12.50 L36.43 32.55 L36.43 51.50 L34.16 51.50 L34.16 31.97 L21.71 14.45 L16.17 14.45 L27.09 29.60 L31.21 35.67 L31.21 51.50 L27.57 51.50 L27.57 34.19 L20.07 23.42 Z'

export function Mark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={cn('shrink-0', className)} aria-label="Y" role="img">
      <path d={Y_LOGO_PATH} fill="currentColor" />
    </svg>
  )
}
