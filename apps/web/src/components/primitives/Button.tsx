import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet'
type Size = 'sm' | 'md' | 'lg'

const variants: Record<Variant, string> = {
  primary: 'bg-text text-page hover:opacity-85',
  secondary: 'bg-fill text-text hover:opacity-80',
  ghost: 'text-text-2 hover:text-text',
  quiet: 'text-text-2 hover:text-text',
  danger: 'text-text underline decoration-1 underline-offset-4 hover:opacity-70',
}
const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
  lg: 'h-11 px-5 text-base gap-2',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-[background,color,opacity] duration-150 disabled:opacity-40',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </button>
  )
})

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: 'sm' | 'md' }>(
  function IconButton({ label, size = 'md', className, children, ...props }, ref) {
    return (
      <button
        ref={ref}
        aria-label={label}
        title={label}
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-full text-text-2 transition-colors duration-150 hover:bg-fill hover:text-text disabled:opacity-40',
          size === 'sm' ? 'size-7' : 'size-9',
          className,
        )}
        {...props}
      >
        {children}
      </button>
    )
  },
)
