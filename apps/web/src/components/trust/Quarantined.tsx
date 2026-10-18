import { useState } from 'react'
import { Button } from '@/components/primitives/Button'
import { Sheet } from '@/components/primitives/Sheet'
import { cn } from '@/lib/cn'

/**
 * Withheld content is said in words, not frosted. The body is never fetched
 * into this view: there is nothing here to blur.
 */
export function Quarantined({ reason = 'Prompt injection', categories, className, compact }: { reason?: string; categories?: string[]; className?: string; compact?: boolean }) {
  const [warn, setWarn] = useState(false)
  return (
    <div className={cn('text-ui', className)}>
      <div>
        <span className="font-semibold">Withheld</span>
        <span className="text-text-2"> · {reason.charAt(0).toUpperCase() + reason.slice(1).toLowerCase()}</span>
      </div>
      {!compact && <div className="mt-1 text-text-2">Flagged before any agent could read it. Your agents saw none of it.</div>}
      {!compact && (
        <button onClick={() => setWarn(true)} className="mt-2 underline decoration-1 underline-offset-4 hover:opacity-70">
          Open in an isolated view
        </button>
      )}
      <Sheet open={warn} onOpenChange={setWarn} title="Open withheld content?" description="This was flagged before any agent could read it." size="sm">
        <div className="space-y-4 text-ui text-text-2">
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
