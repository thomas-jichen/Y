import { CircleCheck, TriangleAlert, Wrench, BookOpen, Workflow, Lightbulb } from 'lucide-react'
import type { Highlight } from '@/api/types'
import { Disclosure } from '@/components/primitives/Disclosure'
import { fmtPct } from '@/lib/format'
import { SafeText } from '@/lib/safeText'

const KIND = {
  fix: { label: 'Fix', icon: Wrench },
  gotcha: { label: 'Gotcha', icon: TriangleAlert },
  recipe: { label: 'Recipe', icon: BookOpen },
  workflow: { label: 'Workflow', icon: Workflow },
  tool_tip: { label: 'Tool tip', icon: Lightbulb },
} as const

export function HighlightCard({ h }: { h: Highlight }) {
  const K = KIND[h.kind]
  return (
    <div className="rounded-[12px] border border-line bg-surface-2 p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 text-xs text-warn">
          <K.icon size={13} strokeWidth={1.9} />
          {K.label}
        </span>
        <span className="text-xs text-fg-3">Quality {fmtPct(h.quality)}</span>
      </div>
      <div className="mt-2 text-[15px] font-medium leading-[22px]">
        <SafeText text={h.title} />
      </div>
      <div className="mt-1 text-sm text-fg-2">
        <SafeText text={h.summary} />
      </div>
      <div className="mt-3 border-t border-line pt-1">
        <Disclosure summary="Problem, steps and pitfalls">
          <div className="space-y-4 text-sm text-fg-2">
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
                <div key={i} className="rounded-[10px] bg-raised px-3 py-2">
                  <div className="text-fg">
                    Tried: <SafeText text={p.tried} />
                  </div>
                  <div className="text-fg-3">
                    <SafeText text={p.whyFailed} />
                  </div>
                </div>
              ))}
            </div>
            <p className="text-fg-3">
              Verified: <SafeText text={h.body.verification} />
            </p>
          </div>
        </Disclosure>
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-xs text-live">
        <CircleCheck size={13} strokeWidth={2} />
        Helped {h.measuredHelp} agents, measured. {h.confirmations} confirmations.
      </div>
    </div>
  )
}
