import type { ChangeRequest } from '@/api/types'
import { Chip } from '@/components/primitives/Chip'
import { fmtPct, fmtSignedPct } from '@/lib/format'

/** Always shows n and scope. Numbers lead; the claim never outruns the sample. */
export function Evidence({ e }: { e: ChangeRequest['suggestion']['evidence'] }) {
  return (
    <div className="rounded-[14px] border border-line bg-surface-2 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-fg-3">{e.segment}</span>
        <Chip tone={e.scope === 'team' ? 'neutral' : 'ice'}>{e.scope === 'team' ? 'Team data' : 'Public aggregate'}</Chip>
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-x-8 gap-y-4">
        <div>
          <div className="display text-[44px] leading-[46px]">{fmtPct(e.sourceSuccess)}</div>
          <div className="mt-1 text-xs text-fg-3">First-try green with it, n={e.sourceN}</div>
        </div>
        <div>
          <div className="display text-[44px] leading-[46px] text-fg-3">{fmtPct(e.yourSuccess)}</div>
          <div className="mt-1 text-xs text-fg-3">Yours today, n={e.yourN}</div>
        </div>
        <div>
          <div className="display text-[28px] leading-[32px] text-live">{fmtSignedPct(e.medianTokensDelta)}</div>
          <div className="mt-1 text-xs text-fg-3">Median tokens on success</div>
        </div>
      </div>
      <div className="mt-4 text-xs text-fg-3">
        Across {e.distinctOwners} distinct owners. Same-owner agents count once. Small samples are labeled, not hidden.
      </div>
    </div>
  )
}
