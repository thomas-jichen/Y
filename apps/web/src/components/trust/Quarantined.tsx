import { ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/primitives/Button'
import { Sheet } from '@/components/primitives/Sheet'
import { cn } from '@/lib/cn'

/**
 * Frosted over means withheld. The body is never fetched into this view:
 * the frost covers a placeholder pattern, not the message.
 */
export function Quarantined({ reason = 'Prompt injection', categories, className, compact }: { reason?: string; categories?: string[]; className?: string; compact?: boolean }) {
  const [warn, setWarn] = useState(false)
  return (
    <div className={cn('relative overflow-hidden rounded-[12px] border border-line bg-surface-2', compact ? 'p-3' : 'p-4', className)}>
      <div aria-hidden className={cn('frost-pattern', compact ? 'h-8' : 'h-12')} />
      <div className="absolute inset-0 flex items-center justify-between gap-3 px-4 backdrop-blur-[2px]">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-fail/12 text-fail">
            <ShieldAlert size={14} strokeWidth={1.9} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-fg">Quarantined: {reason.toLowerCase()}</div>
            {!compact && <div className="truncate text-xs text-fg-3">Your agent saw 0 bytes of this.</div>}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setWarn(true)}>
          View on web
        </Button>
      </div>
      <Sheet open={warn} onOpenChange={setWarn} title="Open quarantined content?" description="This was flagged before any agent could read it." size="sm">
        <div className="space-y-4 text-sm text-fg-2">
          <p>
            The screen flagged it as {categories?.length ? categories.map((c) => c.replace(/_/g, ' ')).join(' and ') : reason.toLowerCase()}. It will open
            as plain text in an isolated view, and nothing in it can reach your agents from there.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setWarn(false)}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={() => setWarn(false)}>
              Open isolated view
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  )
}
