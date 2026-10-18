import { ArrowUp, Lock } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/primitives/Button'
import { Segmented } from '@/components/primitives/Segmented'
import { cn } from '@/lib/cn'
import { ui } from '@/lib/ui'

export type ComposerMode = 'comment' | 'ask'

/**
 * Two composers in one: a comment is data for everyone; asking goes only to
 * your own agent, is off by default, and needs a fresh GitHub confirm.
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
}) {
  const [mode, setMode] = useState<ComposerMode>(defaultMode)
  const [text, setText] = useState('')
  const locked = mode === 'ask' && !remoteOn
  const submit = async (value = text) => {
    const v = value.trim()
    if (!v || locked || busy) return
    setText('')
    await onSubmit(mode, v)
  }
  return (
    <div className="glass rounded-[16px] p-2">
      <div className="flex items-center justify-between gap-2 px-1 pb-2">
        <Segmented<ComposerMode>
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'comment', label: commentLabel },
            { value: 'ask', label: askLabel ?? `Ask through ${agentName}` },
          ]}
        />
        {mode === 'ask' && remoteOn && <span className="hidden text-xs text-fg-3 sm:block">Signed by Y, delivered to {agentName} only</span>}
      </div>
      {locked ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-dashed border-line-strong px-4 py-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <Lock size={15} strokeWidth={1.75} className="mt-0.5 shrink-0 text-fg-3" />
            <div className="text-sm text-fg-2">
              Instructing {agentName} from the web is off.
              <span className="block text-xs text-fg-3">It stays off until you turn it on and confirm with GitHub.</span>
            </div>
          </div>
          <Button size="sm" variant="secondary" onClick={() => ui.set({ remoteSheet: true })}>
            Turn on
          </Button>
        </div>
      ) : (
        <>
          {mode === 'ask' && suggestions.length > 0 && (
            <div className="no-scrollbar flex gap-1.5 overflow-x-auto px-1 pb-2">
              {suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => void submit(s)}
                  className="shrink-0 rounded-full border border-line bg-surface-2 px-3 py-1 text-xs text-fg-2 transition-colors hover:border-line-strong hover:text-fg"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2 rounded-[12px] bg-surface-2 p-1.5 pl-3">
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
              placeholder={mode === 'ask' ? (placeholder?.ask ?? `Tell ${agentName} what to do`) : (placeholder?.comment ?? 'Add a comment')}
              className="max-h-40 min-h-9 flex-1 resize-none bg-transparent py-2 text-[15px] leading-5 text-fg outline-none placeholder:text-fg-3 [field-sizing:content]"
            />
            <button
              onClick={() => void submit()}
              disabled={!text.trim() || busy}
              aria-label="Send"
              className={cn(
                'inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] transition-colors disabled:opacity-30',
                mode === 'ask' ? 'bg-inverse text-inverse-fg' : 'bg-ice text-ice-fg',
              )}
            >
              <ArrowUp size={17} strokeWidth={2.2} />
            </button>
          </div>
        </>
      )}
    </div>
  )
}
