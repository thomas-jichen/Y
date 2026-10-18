import { TriangleAlert, OctagonAlert } from 'lucide-react'
import type { StaticFinding } from '@/api/types'
import { cn } from '@/lib/cn'

/** Read-only code view of untrusted content. Findings sit on their lines. Never rendered as markdown. */
export function DiffViewer({ path, op, after, findings }: { path: string; op: 'create_file' | 'managed_block'; after: string; findings: StaticFinding[] }) {
  const lines = after.replace(/\n$/, '').split('\n')
  return (
    <div className="overflow-hidden rounded-[12px] border border-line">
      <div className="flex items-center justify-between gap-3 border-b border-line bg-surface-2 px-4 py-2.5">
        <span className="truncate font-mono text-xs">{path}</span>
        <span className="shrink-0 text-xs text-fg-3">
          {op === 'create_file' ? 'New file' : 'Managed block'}, +{lines.length}
        </span>
      </div>
      <div className="max-h-[420px] overflow-auto py-2 font-mono text-[12px] leading-[20px]">
        {lines.map((l, i) => {
          const n = i + 1
          const f = findings.filter((x) => x.line === n)
          return (
            <div key={i}>
              <div className={cn('grid grid-cols-[44px_16px_1fr] pr-4', f.length ? (f[0].severity === 'fail' ? 'bg-fail/10' : 'bg-warn/10') : 'bg-live/[0.04]')}>
                <span className="select-none pr-3 text-right text-fg-3 tnum">{n}</span>
                <span className="select-none text-live">+</span>
                <span className="whitespace-pre-wrap break-all text-fg-2">{l || ' '}</span>
              </div>
              {f.map((x) => (
                <div key={x.rule} className="mx-3 my-1.5 flex items-start gap-2 rounded-[8px] border border-line bg-[var(--surface-solid)] px-3 py-2 font-sans text-xs">
                  {x.severity === 'fail' ? <OctagonAlert size={14} className="mt-px shrink-0 text-fail" /> : <TriangleAlert size={14} className="mt-px shrink-0 text-warn" />}
                  <span>
                    <span className="font-mono font-medium">{x.rule}</span> <span className="text-fg-2">{x.message}</span>
                  </span>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
