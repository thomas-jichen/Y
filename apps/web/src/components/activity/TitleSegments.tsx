import { Chip } from '@/components/primitives/Chip'
import { splitTitle } from '@/lib/splitTitle'
import { SafeText } from '@/lib/safeText'

/** Templated stats-only titles become a lead phrase plus quiet chips, never dot-separated text. */
export function TitleSegments({ title, chipClassName }: { title: string; chipClassName?: string }) {
  const parts = splitTitle(title)
  if (parts.length <= 1) return <SafeText text={title} />
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <SafeText text={parts[0]} />
      {parts.slice(1).map((p) => (
        <Chip key={p} tone="outline" className={chipClassName}>
          {p}
        </Chip>
      ))}
    </span>
  )
}
