import type { ChangeRequest } from '@/api/types'
import { fmtPct, fmtSignedPct } from '@/lib/format'

/** Always shows n and scope. One sentence leads; the claim never outruns the sample. */
export function Evidence({ e }: { e: ChangeRequest['suggestion']['evidence'] }) {
  return (
    <section>
      <div className="text-caption text-text-2">
        {e.segment} · {e.scope === 'team' ? 'Team data' : 'Public aggregate'}
      </div>
      <p className="display mt-2 text-title">
        {fmtPct(e.sourceSuccess)} first-try green with it <span className="text-text-2">(n={e.sourceN})</span>, against {fmtPct(e.yourSuccess)} for you today{' '}
        <span className="text-text-2">(n={e.yourN})</span>. {fmtSignedPct(e.medianTokensDelta)} median tokens on success.
      </p>
      <p className="mt-3 text-caption text-text-2">
        Across {e.distinctOwners} distinct owners. Same-owner agents count once. Small samples are labeled, not hidden.
      </p>
    </section>
  )
}
