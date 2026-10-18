/** Small "also sent to Slack" mark, drawn as a neutral glyph rather than the brand logo. */
export function Slack() {
  return (
    <span className="inline-flex items-center gap-1" title="Also sent to Slack">
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
        <path d="M4.5 1v10M7.5 1v10M1 4.5h10M1 7.5h10" />
      </svg>
      Slack
    </span>
  )
}
