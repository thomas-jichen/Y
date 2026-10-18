import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet'
type Size = 'sm' | 'md' | 'lg'

const variants: Record<Variant, string> = {
  primary: 'bg-ice text-ice-fg hover:bg-ice-strong shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]',
  secondary: 'bg-raised text-fg border border-line hover:border-line-strong hover:bg-[color-mix(in_oklab,var(--raised)_100%,var(--fg)_4%)]',
  ghost: 'text-fg-2 hover:text-fg hover:bg-raised',
  quiet: 'text-fg-2 hover:text-fg',
  danger: 'text-fail hover:bg-fail/10',
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
        'inline-flex select-none items-center justify-center whitespace-nowrap rounded-ctl font-medium transition-[background,color,border,transform,opacity] duration-150 ease-[var(--ease-soft)] active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100',
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
          'inline-flex shrink-0 items-center justify-center rounded-ctl text-fg-2 transition-colors duration-150 hover:bg-raised hover:text-fg disabled:opacity-40',
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
