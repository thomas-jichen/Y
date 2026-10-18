import type { SetupCard as Setup, SetupComponent } from '@/api/types'

const GROUPS: { kind: SetupComponent['kind']; label: string }[] = [
  { kind: 'plugin', label: 'Plugins' },
  { kind: 'skill', label: 'Skills' },
  { kind: 'mcp_server', label: 'MCP servers' },
  { kind: 'claude_md_block', label: 'CLAUDE.md' },
  { kind: 'subagent', label: 'Subagents' },
  { kind: 'hook', label: 'Hooks' },
]

/** The gear, as a list. Metadata only; content is shared per component, by choice. */
export function SetupCard({ setup }: { setup: Setup }) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-3 text-ui">
        <span>
          {[setup.model, setup.effort && `Effort ${setup.effort}`, setup.permissionMode].filter(Boolean).join(' · ')}
        </span>
        <span className="font-mono text-caption text-text-2">{setup.hash}</span>
      </div>
      <div className="mt-8 space-y-8">
        {GROUPS.map((g) => {
          const items = setup.components.filter((c) => c.kind === g.kind)
          if (!items.length) return null
          return (
            <section key={g.kind} className="border-t border-text pt-3">
              <h3 className="text-caption">{g.label}</h3>
              <ul className="mt-3 divide-y divide-rule">
                {items.map((c) => (
                  <li key={c.name} className="flex items-baseline gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <span className="font-mono text-ui">{c.name}</span>
                      {c.version && <span className="ml-2 font-mono text-caption text-text-2">{c.version}</span>}
                      {c.descriptionRedacted && <div className="truncate text-caption text-text-2">{c.descriptionRedacted}</div>}
                    </div>
                    <span className={c.contentShared ? 'text-caption font-medium' : 'text-caption text-text-2'}>{c.contentShared ? 'Shared' : 'Private'}</span>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </div>
  )
}
