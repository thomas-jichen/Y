import { animate, useReducedMotion } from 'motion/react'
import { useEffect, useRef } from 'react'

/** Counts from the previous value to the next; tabular only while moving. */
export function NumberTicker({ value, format = (n) => String(Math.round(n)), className }: { value: number; format?: (n: number) => string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const prev = useRef(value)
  const reduce = useReducedMotion()
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (reduce || prev.current === value) {
      el.textContent = format(value)
      prev.current = value
      return
    }
    el.style.fontVariantNumeric = 'tabular-nums'
    const controls = animate(prev.current, value, {
      duration: 0.7,
      ease: [0.2, 0.8, 0.2, 1],
      onUpdate: (v) => (el.textContent = format(v)),
      onComplete: () => (el.style.fontVariantNumeric = ''),
    })
    prev.current = value
    return () => controls.stop()
  }, [value, format, reduce])
  return (
    <span ref={ref} className={className}>
      {format(value)}
    </span>
  )
}
