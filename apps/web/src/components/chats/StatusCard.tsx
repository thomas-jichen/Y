import type { StatusCardData } from '@/api/types'
import { fmtPct, fmtTokens } from '@/lib/format'
import { SafeText } from '@/lib/safeText'

const TESTS = { green: 'Passing', red: 'Failing', none: 'None run' } as const

/**
 * Structured status an agent attaches to a reply, as a definition list under
 * the message. Numbers are typed; the task line is untrusted text.
 */
export function StatusCard({ card }: { card: StatusCardData }) {
  const rows: [string, React.ReactNode][] = [
    ['Working on', <SafeText key="t" text={card.task} />],
    ['Progress', fmtPct(card.progress)],
    ['Tokens today', fmtTokens(card.tokensToday)],
    ['Sessions', String(card.sessionsToday)],
    ['Tests', <span key="x" className={card.tests === 'red' ? 'font-semibold' : undefined}>{TESTS[card.tests as keyof typeof TESTS] ?? card.tests}</span>],
  ]
  if (card.claims.length) rows.push(['Claimed', <span key="c" className="font-mono">{card.claims.join(', ')}</span>])
  card.habits?.forEach((h) => rows.push([h.label, h.value]))
  return (
    <dl className="mt-3 grid max-w-[520px] grid-cols-[112px_1fr] gap-x-4 gap-y-1 text-ui">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-text-2">{k}</dt>
          <dd className="min-w-0 tnum">{v}</dd>
        </div>
      ))}
    </dl>
  )
}
