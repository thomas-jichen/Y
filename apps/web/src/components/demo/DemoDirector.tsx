import { AnimatePresence, motion } from 'motion/react'
import { Check, Loader2, RotateCcw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Kbd } from '@/components/primitives/Kbd'
import { cn } from '@/lib/cn'
import { ui, useUI } from '@/lib/ui'
import { beats, resetDemo } from '@/mocks/script'

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))

/**
 * Hidden stage manager for live demos. Backtick toggles it; digits fire
 * beats while it is open, Option plus a digit fires them any time.
 * Every beat goes through the mock db and the event bus, so the UI updates
 * exactly the way it will against the real stream.
 */
export function DemoDirector() {
  const { director } = useUI()
  const [state, setState] = useState<Record<string, 'running' | 'done'>>({})

  const run = async (key: string) => {
    if (key === '0') {
      resetDemo()
      setState({})
      return
    }
    const b = beats.find((x) => x.key === key)
    if (!b || state[key] === 'running') return
    setState((s) => ({ ...s, [key]: 'running' }))
    await b.run()
    setState((s) => ({ ...s, [key]: 'done' }))
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target)) return
      if (e.key === '`') {
        e.preventDefault()
        ui.set({ director: !ui.get().director })
        return
      }
      const digit = e.code.startsWith('Digit') ? e.code.slice(5) : null
      if (digit && (ui.get().director || e.altKey) && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        void run(digit)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <AnimatePresence>
      {director && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
          className="glass-pop fixed bottom-4 left-3 z-[60] w-[300px] rounded-glass p-3 md:left-auto md:right-4"
        >
          <div className="mb-2 flex items-center justify-between px-1">
            <div>
              <div className="text-sm font-semibold">Demo director</div>
              <div className="text-caption">Press a number to run a beat</div>
            </div>
            <button onClick={() => ui.set({ director: false })} className="inline-flex size-7 items-center justify-center rounded-full hover:bg-fill" aria-label="Close director">
              <X size={14} strokeWidth={1.75} />
            </button>
          </div>
          <div className="space-y-0.5">
            {beats.map((b) => (
              <button
                key={b.key}
                onClick={() => void run(b.key)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left text-ui transition-colors hover:bg-fill',
                  state[b.key] === 'done' ? 'line-through decoration-1' : '',
                )}
              >
                <Kbd>{b.key}</Kbd>
                <span className="flex-1 truncate">{b.label}</span>
                {state[b.key] === 'running' && <Loader2 size={13} className="animate-[spin-slow_0.9s_linear_infinite]" />}
                {state[b.key] === 'done' && <Check size={13} strokeWidth={2} />}
              </button>
            ))}
            <button onClick={() => void run('0')} className="mt-1 flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left text-ui hover:bg-fill">
              <Kbd>0</Kbd>
              <span className="flex-1">Reset everything</span>
              <RotateCcw size={13} strokeWidth={1.75} />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
