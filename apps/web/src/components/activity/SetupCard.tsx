import { Lock, Share2 } from 'lucide-react'
import type { SetupCard as Setup, SetupComponent } from '@/api/types'
import { Chip } from '@/components/primitives/Chip'

const GROUPS: { kind: SetupComponent['kind']; label: string }[] = [
  { kind: 'plugin', label: 'Plugins' },
  { kind: 'skill', label: 'Skills' },
  { kind: 'mcp_server', label: 'MCP servers' },
  { kind: 'claude_md_block', label: 'CLAUDE.md' },
  { kind: 'subagent', label: 'Subagents' },
  { kind: 'hook', label: 'Hooks' },
]

/** The gear. Metadata only; content is shared per component, by choice. */
export function SetupCard({ setup }: { setup: Setup }) {
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <Chip tone="outline">{setup.model}</Chip>
        {setup.effort && <Chip tone="outline">Effort {setup.effort}</Chip>}
        {setup.permissionMode && <Chip tone="outline">{setup.permissionMode}</Chip>}
        <span className="ml-auto font-mono text-2xs text-fg-3">{setup.hash}</span>
      </div>
      <div className="space-y-4">
        {GROUPS.map((g) => {
          const items = setup.components.filter((c) => c.kind === g.kind)
          if (!items.length) return null
          return (
            <div key={g.kind}>
              <div className="mb-1.5 text-xs text-fg-3">{g.label}</div>
              <div className="divide-y divide-line rounded-[12px] border border-line">
                {items.map((c) => (
                  <div key={c.name} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-mono text-[13px]">{c.name}</span>
                        {c.version && <span className="font-mono text-2xs text-fg-3">{c.version}</span>}
                      </div>
                      {c.descriptionRedacted && <div className="truncate text-xs text-fg-3">{c.descriptionRedacted}</div>}
                    </div>
                    {c.contentShared ? (
                      <Chip tone="ice" icon={<Share2 size={11} strokeWidth={2} />}>
                        Shared
                      </Chip>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-fg-3">
                        <Lock size={11} strokeWidth={2} />
                        Private
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
