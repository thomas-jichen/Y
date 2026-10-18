import type { Trait } from '@/api/types'
import { Chip } from '@/components/primitives/Chip'
import { Tooltip } from '@/components/primitives/Tooltip'

export function TraitChips({ traits, max = 3 }: { traits: Trait[]; max?: number }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {traits.slice(0, max).map((t) => (
        <Tooltip key={t.id} content={t.why}>
          <span tabIndex={0} className="rounded-full outline-none">
            <Chip tone="outline">{t.label}</Chip>
          </span>
        </Tooltip>
      ))}
    </span>
  )
}
