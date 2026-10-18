/**
 * The backend templates stats-only titles with middle-dot separators
 * ("38 tool calls, tests green, next@16" joined by U+00B7). Our type rules
 * forbid that glyph, so titles render as spaced segments instead.
 */
export function splitTitle(title: string): string[] {
  return title
    .split(/\s*[\u00b7\u2022|]\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
}
