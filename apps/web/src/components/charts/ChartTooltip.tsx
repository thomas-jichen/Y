import type { ReactNode } from 'react'

/** Value leads, label follows; line keys instead of boxes. */
export function ChartTooltip({ x, y, children, align = 'center' }: { x: number; y: number; children: ReactNode; align?: 'center' | 'left' | 'right' }) {
  const tx = align === 'center' ? '-50%' : align === 'left' ? '8px' : 'calc(-100% - 8px)'
  return (
    <div
      className="glass-pop pointer-events-none absolute z-20 whitespace-nowrap rounded-[10px] px-2.5 py-1.5 text-xs"
      style={{ left: x, top: y, transform: `translate(${tx}, calc(-100% - 10px))` }}
    >
      {children}
    </div>
  )
}

export function TipRow({ color, value, label, dashed }: { color: string; value: string; label: string; dashed?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="inline-block h-0 w-3" style={{ borderTop: `2px ${dashed ? 'dotted' : 'solid'} ${color}` }} />
      <span className="font-semibold text-fg tnum">{value}</span>
      <span className="text-fg-3">{label}</span>
    </div>
  )
}
