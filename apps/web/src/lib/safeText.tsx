import { cn } from './cn'

/**
 * Hidden characters (UI.md section 5, rule 2): soft hyphen, Mongolian vowel separator, zero width,
 * bidi embeddings and overrides, isolates, BOM (packages/schema INVISIBLE_CHARS_SOURCE) and the
 * Unicode tag block U+E0000–E007F (ASCII smuggling, stripped by packages/safety normalizeUntrusted).
 * The u flag makes tag characters match whole code points, so the count is per character.
 */
const HIDDEN_SOURCE = '[\\u00AD\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u{E0000}-\\u{E007F}]'
const HIDDEN = new RegExp(HIDDEN_SOURCE, 'gu')

export function sanitize(input: string): { text: string; removed: number } {
  const matches = input.match(HIDDEN)
  return { text: input.replace(HIDDEN, '').normalize('NFKC'), removed: matches?.length ?? 0 }
}

/** How many hidden characters `input` holds (for text shown as-is, such as an editable draft). */
export function countHidden(input: string): number {
  return input.match(HIDDEN)?.length ?? 0
}

/**
 * Text that must be shown exactly (a setup diff that will be applied byte for byte): each hidden
 * character becomes a visible `⟨U+XXXX⟩` marker instead of being dropped, so nothing is invisible.
 */
export function revealHidden(input: string): { text: string; hidden: number } {
  let hidden = 0
  const text = input.replace(HIDDEN, (c) => {
    hidden += 1
    return `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`
  })
  return { text, hidden }
}

/** The chip shown under text that had (or has) hidden characters. */
export function HiddenChip({ count, removed = true }: { count: number; removed?: boolean }) {
  if (count <= 0) return null
  return (
    <span className="mt-2 block text-caption font-semibold">
      {removed ? `Hidden characters removed (${count})` : `Hidden characters (${count})`}
    </span>
  )
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
      <HiddenChip count={removed} />
    </>
  )
}
