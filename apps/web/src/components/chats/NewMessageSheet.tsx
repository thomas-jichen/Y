import { useNavigate } from '@tanstack/react-router'
import { Check } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { HttpError } from '@/api/client'
import type { AgentRef } from '@/api/types'
import { useMe, useStartThread, useTeam } from '@/api/queries'
import { AgentAvatar } from '@/components/identity/AgentAvatar'
import { Button } from '@/components/primitives/Button'
import { Sheet } from '@/components/primitives/Sheet'
import { cn } from '@/lib/cn'
import { ui, useUI } from '@/lib/ui'

const MAX = 4000

function errorText(e: unknown): string {
  if (e instanceof HttpError) {
    if (e.code === 'DM_NOT_PERMITTED') return 'You can message your own agents and your teammates’ agents only.'
    if (e.code === 'NOT_FOUND') return 'That agent is not on Y any more.'
    return e.message || 'Could not send. Try again.'
  }
  return 'Could not send. Try again.'
}

/**
 * Start a conversation with one of your team's agents, or your own. The message reaches the
 * agent as a comment, which it reads as data, never as an instruction. Opened from anywhere
 * with `ui.set({ compose: { to?: handle } })`.
 */
export function NewMessageSheet() {
  const { compose } = useUI()
  const open = !!compose
  const { data: me } = useMe()
  const { data: team } = useTeam()
  const start = useStartThread()
  const nav = useNavigate()
  const [to, setTo] = useState<string | undefined>()
  const [text, setText] = useState('')
  const [filter, setFilter] = useState('')

  // Your agents first, then teammates'. Strangers never appear here (DMs to them stay default-deny).
  const candidates = useMemo(() => {
    const seen = new Map<string, AgentRef & { mine: boolean }>()
    for (const a of me?.agents ?? []) seen.set(a.id, { ...a, mine: true })
    for (const c of team?.agents ?? []) if (!c.agent.stranger && !seen.has(c.agent.id)) seen.set(c.agent.id, { ...c.agent, mine: false })
    return [...seen.values()].sort((x, y) => Number(x.mine) - Number(y.mine) || x.displayName.localeCompare(y.displayName))
  }, [me, team])

  useEffect(() => {
    if (!open) return
    setTo(compose?.to?.replace(/^@/, ''))
    setText('')
    setFilter('')
    start.reset()
  }, [open, compose?.to])

  const q = filter.trim().toLowerCase().replace(/^@/, '')
  const shown = q ? candidates.filter((a) => a.handle.toLowerCase().includes(q) || a.displayName.toLowerCase().includes(q) || a.owner.name.toLowerCase().includes(q)) : candidates
  const target = candidates.find((a) => a.handle === to)
  const body = text.trim()
  const canSend = !!to && !!body && !start.isPending

  const send = async () => {
    if (!canSend || !to) return
    try {
      const d = await start.mutateAsync({ to, body })
      ui.set({ compose: null })
      void nav({ to: '/chats/$id', params: { id: d.thread.id } })
    } catch {
      // shown below from start.error
    }
  }

  return (
    <Sheet open={open} onOpenChange={(v) => ui.set({ compose: v ? (compose ?? {}) : null })} title="New message" description="Message one of your agents or a teammate’s. It arrives as a comment: the agent reads it as data, not as instructions." size="sm">
      <div className="text-caption text-text-2">To</div>
      {candidates.length > 8 && (
        <div className="mt-1 border-b border-rule focus-within:border-text">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            spellCheck={false}
            placeholder="Find an agent"
            aria-label="Find an agent"
            className="h-10 w-full bg-transparent text-body text-text outline-none placeholder:text-text placeholder:opacity-60"
          />
        </div>
      )}
      <div role="radiogroup" aria-label="Agent" className="-mx-3 mt-1 max-h-60 overflow-y-auto">
        {to && !target && (
          <div role="radio" aria-checked className="flex items-center gap-3 bg-fill px-3 py-2 text-ui font-medium">
            <span className="min-w-0 flex-1 truncate">@{to}</span>
            <Check size={16} strokeWidth={1.8} aria-hidden />
          </div>
        )}
        {!me && !team && Array.from({ length: 3 }, (_, i) => <div key={i} className="skeleton mx-3 my-2 h-8" />)}
        {(me || team) && shown.length === 0 && <p className="px-3 py-2 text-ui text-text-2">{q ? 'No agent matches.' : 'No agents on your team yet.'}</p>}
        {shown.map((a) => {
          const on = a.handle === to
          return (
            <button
              key={a.id}
              role="radio"
              aria-checked={on}
              onClick={() => setTo(a.handle)}
              className={cn('flex w-full items-center gap-3 px-3 py-2 text-left', on ? 'bg-fill' : 'hover:bg-fill/60')}
            >
              <AgentAvatar agent={a} size={28} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui font-medium">{a.displayName}</span>
                <span className="block truncate text-caption text-text-2">
                  @{a.handle}, {a.mine ? 'yours' : a.owner.name}
                </span>
              </span>
              {on && <Check size={16} strokeWidth={1.8} aria-hidden />}
            </button>
          )
        })}
      </div>

      <div className="mt-5 border-b border-rule focus-within:border-text">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void send()
            }
          }}
          rows={3}
          maxLength={MAX}
          aria-label={target ? `Message to ${target.displayName}` : 'Message'}
          placeholder={target ? `Write to ${target.displayName}` : 'Pick an agent, then write'}
          className="max-h-60 min-h-20 w-full resize-none bg-transparent py-2.5 text-body text-text outline-none placeholder:text-text [field-sizing:content] placeholder:opacity-60"
        />
      </div>
      {start.isError && (
        <p role="alert" className="mt-3 text-ui font-medium">
          {errorText(start.error)}
        </p>
      )}
      <div className="mt-6 flex items-center justify-end gap-5">
        <Button variant="ghost" onClick={() => ui.set({ compose: null })}>
          Cancel
        </Button>
        <Button variant="primary" className="rounded-full" disabled={!canSend} onClick={() => void send()}>
          {start.isPending ? 'Sending' : target ? `Send to ${target.displayName}` : 'Send'}
        </Button>
      </div>
    </Sheet>
  )
}
