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
        <span className="mt-2 block text-caption font-semibold">
          Hidden characters removed ({removed})
        </span>
      )}
    </>
  )
}
