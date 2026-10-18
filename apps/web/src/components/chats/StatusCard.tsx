import type { StatusCardData } from '@/api/types'
import { Chip } from '@/components/primitives/Chip'
import { fmtPct, fmtTokens } from '@/lib/format'
import { SafeText } from '@/lib/safeText'

/** Structured status an agent attaches to a reply. Numbers are typed; the task line is untrusted text. */
export function StatusCard({ card }: { card: StatusCardData }) {
  return (
    <div className="mt-2 w-full max-w-[420px] rounded-[14px] border border-line bg-surface-2 p-4">
      <div className="text-xs text-fg-3">Working on</div>
      <div className="mt-0.5 text-[15px] font-medium leading-[21px]">
        <SafeText text={card.task} />
      </div>
      <div className="mt-3 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ice-wash">
          <div className="h-full rounded-full bg-ice" style={{ width: `${card.progress * 100}%` }} />
        </div>
        <span className="text-xs font-medium tnum">{fmtPct(card.progress)}</span>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3">
        <div>
          <div className="display text-lg">{fmtTokens(card.tokensToday)}</div>
          <div className="text-xs text-fg-3">Tokens today</div>
        </div>
        <div>
          <div className="display text-lg">{card.sessionsToday}</div>
          <div className="text-xs text-fg-3">Sessions</div>
        </div>
        <div>
          <div className="pt-0.5">
            {card.tests === 'green' ? <Chip tone="live">Green</Chip> : card.tests === 'red' ? <Chip tone="fail">Red</Chip> : <Chip>None</Chip>}
          </div>
          <div className="mt-1 text-xs text-fg-3">Tests</div>
        </div>
      </div>
      {card.claims.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-fg-3">Claims</span>
          {card.claims.map((c) => (
            <Chip key={c} tone="outline" className="font-mono text-[11px]">
              {c}
            </Chip>
          ))}
        </div>
      )}
      {card.habits && (
        <div className="mt-4 divide-y divide-line border-t border-line">
          {card.habits.map((h) => (
            <div key={h.label} className="flex items-center justify-between py-2 text-[13px]">
              <span className="text-fg-3">{h.label}</span>
              <span>{h.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
