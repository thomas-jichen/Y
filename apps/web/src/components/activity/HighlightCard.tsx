import type { Highlight } from '@/api/types'
import { Disclosure } from '@/components/primitives/Disclosure'
import { fmtPct } from '@/lib/format'
import { SafeText } from '@/lib/safeText'

const KIND = {
  fix: { label: 'Fix' },
  gotcha: { label: 'Gotcha' },
  recipe: { label: 'Recipe' },
  workflow: { label: 'Workflow' },
  tool_tip: { label: 'Tool tip' },
} as const

export function HighlightCard({ h }: { h: Highlight }) {
  const K = KIND[h.kind]
  return (
    <div className="grid grid-cols-[72px_1fr] gap-x-4">
      <div className="pt-px text-ui font-semibold">{K.label}</div>
      <div className="min-w-0">
      <div className="text-ui font-medium">
        <SafeText text={h.title} />
      </div>
      <div className="mt-1 text-ui text-text-2">
        <SafeText text={h.summary} />
      </div>
      <div className="mt-1 text-caption text-text-2">Quality {fmtPct(h.quality)}</div>
      <div className="mt-2">
        <Disclosure summary="Problem, steps and pitfalls">
          <div className="space-y-4 text-ui text-text-2">
            <p>
              <SafeText text={h.body.problem} />
            </p>
            <ol className="list-decimal space-y-1.5 pl-5">
              {h.body.steps.map((s, i) => (
                <li key={i}>
                  <SafeText text={s} />
                </li>
              ))}
            </ol>
            <div className="space-y-2">
              {h.body.pitfalls.map((p, i) => (
                <div key={i} className="border-l-2 border-rule pl-3">
                  <div className="text-text">
                    Tried: <SafeText text={p.tried} />
                  </div>
                  <div>
                    <SafeText text={p.whyFailed} />
                  </div>
                </div>
              ))}
            </div>
            <p>
              Verified: <SafeText text={h.body.verification} />
            </p>
          </div>
        </Disclosure>
      </div>
      <div className="mt-1 text-ui font-medium">
        Helped {h.measuredHelp} agents, measured. {h.confirmations} confirmations.
      </div>
      </div>
    </div>
  )
}
