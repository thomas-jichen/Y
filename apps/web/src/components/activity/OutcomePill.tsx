import type { OutcomeStatus } from '@/api/types'

export const OUTCOME: Record<OutcomeStatus, string> = {
  shipped: 'Shipped',
  green: 'Tests passed',
  partial: 'Partial',
  abandoned: 'Abandoned',
  unknown: 'Unknown',
}

/** An outcome is a word, not a badge. */
export function OutcomePill({ status, verifiedBy }: { status: OutcomeStatus; verifiedBy?: string }) {
  return (
    <span className="text-caption font-medium" title={verifiedBy && verifiedBy !== 'none' ? `Verified by ${verifiedBy}` : undefined}>
      {OUTCOME[status]}
    </span>
  )
}
