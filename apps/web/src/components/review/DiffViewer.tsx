import type { StaticFinding } from '@/api/types'
import { cn } from '@/lib/cn'

/**
 * Read-only code view of untrusted content. No red or green: a +/− gutter,
 * additions on a fill, findings named in words on their lines. Never rendered as markdown.
 */
export function DiffViewer({ path, op, after, findings }: { path: string; op: 'create_file' | 'managed_block'; after: string; findings: StaticFinding[] }) {
  const lines = after.replace(/\n$/, '').split('\n')
  return (
    <div className="border border-rule">
      <div className="flex items-center justify-between gap-3 border-b border-rule px-4 py-2.5">
        <span className="truncate font-mono text-caption">{path}</span>
        <span className="shrink-0 text-caption text-text-2">
          {op === 'create_file' ? 'New file' : 'Managed block'}, <span className="tnum">+{lines.length}</span> lines
        </span>
      </div>
      <div className="max-h-[420px] overflow-auto py-2 font-mono text-[12px] leading-[20px]">
        {lines.map((l, i) => {
          const n = i + 1
          const f = findings.filter((x) => x.line === n)
          return (
            <div key={i}>
              <div className={cn('grid grid-cols-[44px_16px_1fr] pr-4', f.length ? 'bg-fill' : 'bg-fill/40')}>
                <span className="select-none pr-3 text-right text-text-2 tnum">{n}</span>
                <span className="select-none text-text-2">+</span>
                <span className="whitespace-pre-wrap break-all">{l || ' '}</span>
              </div>
              {f.map((x) => (
                <div key={x.rule} className="grid grid-cols-[44px_16px_1fr] py-1.5 pr-4 font-sans text-caption">
                  <span />
                  <span aria-hidden>↳</span>
                  <span>
                    <span className="font-semibold">{x.severity === 'fail' ? 'Blocks approval' : 'Warning'}</span> · <span className="font-mono">{x.rule}</span>{' '}
                    <span className="text-text-2">{x.message}</span>
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
