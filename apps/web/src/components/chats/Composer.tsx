import { useState } from 'react'
import { Button } from '@/components/primitives/Button'
import { Tabs } from '@/components/primitives/Tabs'
import { ui } from '@/lib/ui'

export type ComposerMode = 'comment' | 'ask'

/**
 * Two composers in one: a comment is data for everyone; asking goes only to
 * your own agent, is off by default, and needs a fresh GitHub confirm.
 * It floats as glass at the bottom of the screen, over the content it answers.
 * The send button says which one you are doing, in words.
 */
export function Composer({
  agentName,
  remoteOn,
  onSubmit,
  suggestions = [],
  commentLabel = 'Comment',
  askLabel,
  placeholder,
  busy,
  defaultMode = 'comment',
  initialText = '',
}: {
  agentName: string
  remoteOn: boolean
  onSubmit: (mode: ComposerMode, text: string) => Promise<unknown> | void
  suggestions?: string[]
  commentLabel?: string
  askLabel?: string
  placeholder?: { comment: string; ask: string }
  busy?: boolean
  defaultMode?: ComposerMode
  initialText?: string
}) {
  const [mode, setMode] = useState<ComposerMode>(defaultMode)
  const [text, setText] = useState(initialText)
  const [error, setError] = useState<string | null>(null)
  const locked = mode === 'ask' && !remoteOn
  // The text clears only once the send lands. A gated send that opened the explain sheet
  // resolves to undefined and keeps the text; a failed one keeps it and says why.
  const submit = async (value = text) => {
    const v = value.trim()
    if (!v || locked || busy) return
    setError(null)
    try {
      const p = onSubmit(mode, v)
      const r = await p
      if (!(p instanceof Promise) || r !== undefined) setText((cur) => (cur.trim() === v ? '' : cur))
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not send. Try again.')
    }
  }
  return (
    <div className="glass rounded-[24px] px-5 pb-3 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <Tabs<ComposerMode>
          size="sm"
          label="Reply as"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'comment', label: commentLabel },
            { value: 'ask', label: askLabel ?? `Ask through ${agentName}` },
          ]}
        />
        {mode === 'ask' && remoteOn && <span className="hidden text-caption sm:block">Signed by Y, delivered to {agentName} only</span>}
      </div>
      {locked ? (
        <div className="flex flex-wrap items-center justify-between gap-3 py-2">
          <p className="min-w-0 text-ui">
            Instructing {agentName} from the web is off. It stays off until you turn it on and confirm with GitHub.
          </p>
          <Button size="sm" variant="primary" className="rounded-full" onClick={() => ui.set({ remoteSheet: true })}>
            Turn on
          </Button>
        </div>
      ) : (
        <>
          {mode === 'ask' && suggestions.length > 0 && (
            <div className="no-scrollbar mt-2 flex gap-4 overflow-x-auto">
              {suggestions.map((s) => (
                <button key={s} onClick={() => void submit(s)} className="shrink-0 text-ui underline decoration-1 underline-offset-4 hover:opacity-70">
                  {s}
                </button>
              ))}
            </div>
          )}
          <div className="mt-1 flex items-end gap-3">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void submit()
                }
              }}
              rows={1}
              maxLength={1000}
              aria-label={mode === 'ask' ? `Message to ${agentName}` : 'Comment'}
              placeholder={mode === 'ask' ? (placeholder?.ask ?? `Tell ${agentName} what to do`) : (placeholder?.comment ?? 'Add a comment')}
              className="max-h-40 min-h-10 flex-1 resize-none bg-transparent py-2.5 text-body text-text outline-none placeholder:text-text [field-sizing:content] placeholder:opacity-60"
            />
            <Button size="md" variant="primary" className="mb-0.5 rounded-full" onClick={() => void submit()} disabled={!text.trim() || busy}>
              {mode === 'ask' ? `Send to ${agentName}` : 'Send comment'}
            </Button>
          </div>
          {error && (
            <p role="alert" className="pb-1 text-caption text-text">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  )
}
