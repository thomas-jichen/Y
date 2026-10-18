import { animate, motion, useMotionTemplate, useMotionValue, useTransform } from 'motion/react'
import { Check, Loader2, ShieldCheck } from 'lucide-react'
import { useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { uid } from '@/lib/hash'

type Phase = 'idle' | 'holding' | 'working' | 'done'

/**
 * Press and hold to approve. One gesture yields one idempotency key, so a
 * double click or a second hold can never produce a second decision.
 */
export function HoldButton({
  label,
  doneLabel = 'Approved',
  duration = 700,
  onComplete,
  disabled,
  done,
  className,
}: {
  label: string
  doneLabel?: string
  duration?: number
  onComplete: (idempotencyKey: string) => Promise<unknown> | void
  disabled?: boolean
  done?: boolean
  className?: string
}) {
  const progress = useMotionValue(0)
  const [phase, setPhase] = useState<Phase>(done ? 'done' : 'idle')
  const key = useRef<string | null>(null)
  const anim = useRef<ReturnType<typeof animate> | null>(null)
  const clip = useMotionTemplate`inset(0 ${useTransform(progress, (p) => `${(1 - p) * 100}%`)} 0 0 round 12px)`
  const shown: Phase = done ? 'done' : phase

  const start = () => {
    if (disabled || shown === 'working' || shown === 'done') return
    key.current = key.current ?? uid('idem')
    setPhase('holding')
    navigator.vibrate?.(8)
    anim.current?.stop()
    anim.current = animate(progress, 1, {
      duration: (duration / 1000) * (1 - progress.get()),
      ease: 'linear',
      onComplete: async () => {
        setPhase('working')
        navigator.vibrate?.([12, 40, 18])
        try {
          await onComplete(key.current!)
          setPhase('done')
        } catch {
          setPhase('idle')
          animate(progress, 0, { duration: 0.3 })
        }
      },
    })
  }

  const cancel = () => {
    if (phase !== 'holding') return
    anim.current?.stop()
    setPhase('idle')
    animate(progress, 0, { duration: 0.28, ease: [0.2, 0.8, 0.2, 1] })
  }

  const content = (inverse: boolean) => (
    <span className={cn('flex items-center justify-center gap-2 text-[15px] font-semibold', inverse ? 'text-ice-fg' : 'text-fg')}>
      {shown === 'done' ? (
        <Check size={17} strokeWidth={2.25} />
      ) : shown === 'working' ? (
        <Loader2 size={17} strokeWidth={2} className="animate-[spin-slow_0.9s_linear_infinite]" />
      ) : (
        <ShieldCheck size={17} strokeWidth={1.9} />
      )}
      {shown === 'done' ? doneLabel : shown === 'working' ? 'Approving' : shown === 'holding' ? 'Keep holding' : label}
    </span>
  )

  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={(e) => {
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* capture is best effort */
        }
        start()
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onKeyDown={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
          e.preventDefault()
          start()
        }
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') cancel()
      }}
      onContextMenu={(e) => e.preventDefault()}
      aria-label={label}
      className={cn(
        'relative h-12 w-full select-none touch-none overflow-hidden rounded-[12px] border border-line-strong bg-raised transition-transform duration-150 disabled:opacity-40',
        shown === 'holding' && 'scale-[0.99]',
        className,
      )}
    >
      {content(false)}
      <motion.span
        aria-hidden
        className="absolute inset-0 flex items-center justify-center bg-ice"
        style={{ clipPath: shown === 'done' || shown === 'working' ? 'inset(0 0 0 0 round 12px)' : clip }}
      >
        {content(true)}
      </motion.span>
    </button>
  )
}
