import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import { fmtSignedPct } from '@/lib/format'

/** Label, value, delta vs the prior period. Color only when direction carries meaning. */
export function KpiTile({ label, value, delta, goodWhenUp, peer }: { label: string; value: string; delta?: number; goodWhenUp?: boolean; peer?: string }) {
  const up = (delta ?? 0) >= 0
  const tone = goodWhenUp === undefined ? 'text-fg-2' : up === goodWhenUp ? 'text-live' : 'text-fail'
  return (
    <div className="surface rounded-card p-4">
      <div className="text-xs text-fg-3">{label}</div>
      <div className="display mt-1.5 text-[28px] leading-[32px]">{value}</div>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs">
        {delta !== undefined && isFinite(delta) ? (
          <span className={cn('inline-flex items-center gap-0.5', tone)}>
            {up ? <ArrowUpRight size={13} strokeWidth={2} /> : <ArrowDownRight size={13} strokeWidth={2} />}
            {fmtSignedPct(delta)}
            <span className="ml-1 text-fg-3">vs prior</span>
          </span>
        ) : (
          <span />
        )}
        {peer && <span className="truncate text-fg-3">Them {peer}</span>}
      </div>
    </div>
  )
}
