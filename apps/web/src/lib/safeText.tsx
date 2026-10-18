import { EyeOff } from 'lucide-react'
import { cn } from './cn'

// Zero width, bidi embeddings and overrides, isolates (UI.md section 5, rule 2).
const HIDDEN = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g

export function sanitize(input: string): { text: string; removed: number } {
  const matches = input.match(HIDDEN)
  return { text: input.replace(HIDDEN, '').normalize('NFKC'), removed: matches?.length ?? 0 }
}

/**
 * The only way untrusted text reaches the screen: plain text, no markup,
 * no auto-linking, no images. Never swap this for an HTML renderer.
 */
export function SafeText({
  text,
  className,
  clamp,
}: {
  text: string
  className?: string
  clamp?: number
}) {
  const { text: clean, removed } = sanitize(text)
  return (
    <>
      <span
        className={cn('whitespace-pre-wrap break-words [overflow-wrap:anywhere]', className)}
        style={clamp ? { display: '-webkit-box', WebkitLineClamp: clamp, WebkitBoxOrient: 'vertical', overflow: 'hidden' } : undefined}
      >
        {clean}
      </span>
      {removed > 0 && (
        <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-warn/10 px-2 py-0.5 text-2xs text-warn">
          <EyeOff size={12} strokeWidth={1.75} />
          Hidden characters removed
        </span>
      )}
    </>
  )
}
