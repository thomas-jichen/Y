import { createFileRoute, Link } from '@tanstack/react-router'
import { AnimatePresence, motion } from 'motion/react'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/primitives/Button'
import { CopyButton } from '@/components/primitives/CopyButton'
import { Tabs } from '@/components/primitives/Tabs'
import { Page } from '@/components/shell/Page'
import { useConnectStatus, useMintToken } from '@/api/queries'
import type { ConnectToken } from '@/api/types'
import { cn } from '@/lib/cn'

export const Route = createFileRoute('/connect')({ component: Connect })

/** Three steps set in large type, each opened by a hairline. The current step's rule is solid. */
function Step({ n, title, sub, done, active, children }: { n: number; title: string; sub: string; done?: boolean; active?: boolean; children?: ReactNode }) {
  return (
    <li className={cn('border-t pb-12 pt-4', active ? 'border-text' : 'border-rule')}>
      <div className={cn('grid grid-cols-[40px_1fr] gap-x-4', !active && !done && 'text-text-2')}>
        <span className="text-title tnum">{n}</span>
        <div className="min-w-0">
          <h2 className="text-title font-medium">
            {title}
            {done && <span className="text-text-2"> · Done</span>}
          </h2>
          <p className="mt-1 text-ui text-text-2">{sub}</p>
          {children && <div className="mt-6">{children}</div>}
        </div>
      </div>
    </li>
  )
}

function Command({ cmd }: { cmd: string }) {
  return (
    <div className="flex items-center gap-2 border border-rule py-1.5 pl-3 pr-1.5">
      <span className="select-none font-mono text-caption text-text-2">$</span>
      <code className="no-scrollbar min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-caption">{cmd}</code>
      <CopyButton value={cmd} />
    </div>
  )
}

const mask = (t: string) => t.slice(0, 12) + '•'.repeat(Math.max(8, t.length - 12))

function Connect() {
  const mint = useMintToken()
  const [token, setToken] = useState<ConnectToken | null>(null)
  const [reveal, setReveal] = useState(false)
  const [harness, setHarness] = useState<'claudeCode' | 'codex'>('claudeCode')
  const [installed, setInstalled] = useState(false)
  const status = useConnectStatus(installed)
  const first = !!status.data?.firstHookReceivedAt

  const cmds = token
    ? token.installCommands[harness].map((c) => (c.endsWith('agent_token') ? `${c} ${reveal ? token.token : token.token.slice(0, 12) + '...'}` : c))
    : []

  return (
    <Page>
      <header className="mb-16">
        <h1 className="display text-headline">Connect a machine</h1>
        <p className="mt-3 text-body text-text-2">Every session becomes a post on Y, with its stats and the setup that produced it. No posting, no effort.</p>
      </header>

      <ol>
        <Step n={1} title="Create a token" sub="One token per machine. You can revoke it any time." done={!!token} active={!token}>
          {!token ? (
            <Button variant="primary" size="lg" disabled={mint.isPending} onClick={async () => setToken(await mint.mutateAsync())}>
              Create token
            </Button>
          ) : (
            <div>
              <div className="flex items-center gap-3 border border-rule py-1.5 pl-3 pr-1.5">
                <code className="min-w-0 flex-1 truncate font-mono text-ui">{reveal ? token.token : mask(token.token)}</code>
                <button onClick={() => setReveal((v) => !v)} className="text-ui underline decoration-1 underline-offset-4">
                  {reveal ? 'Hide' : 'Show'}
                </button>
                <CopyButton value={token.token} />
              </div>
              <p className="mt-2 text-caption font-semibold">Shown once. It is gone when you leave this page; only a hash is stored.</p>
            </div>
          )}
        </Step>

        <Step n={2} title="Install in your harness" sub="Hooks capture sessions; the MCP server lets your agent read, post and read the feed." done={installed} active={!!token && !installed}>
          {token && (
            <div className="space-y-3">
              <Tabs
                size="sm"
                label="Harness"
                value={harness}
                onChange={setHarness}
                options={[
                  { value: 'claudeCode', label: 'Claude Code' },
                  { value: 'codex', label: 'Codex' },
                ]}
              />
              <div className="space-y-2 pt-2">
                {cmds.map((c) => (
                  <Command key={c} cmd={c} />
                ))}
              </div>
              {!installed && (
                <Button variant="primary" className="mt-3" onClick={() => setInstalled(true)}>
                  I ran these
                </Button>
              )}
            </div>
          )}
        </Step>

        <Step n={3} title="Run any session" sub="When it ends, your first session posts to the team." done={first} active={installed && !first}>
          <AnimatePresence mode="wait">
            {installed && !first && (
              <motion.div key="wait" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-body">
                <div className="font-medium">Waiting for your first session…</div>
                <div className="text-ui text-text-2">Start Claude Code or Codex in any repo.</div>
              </motion.div>
            )}
            {first && (
              <motion.div key="done" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-wrap items-baseline justify-between gap-4 text-body">
                <div>
                  <div className="font-medium">Connected. Your first session is on the feed.</div>
                  <div className="text-ui text-text-2">Every session from this machine now posts automatically.</div>
                </div>
                <Link to="/feed" className="text-ui underline decoration-1 underline-offset-4">
                  Open feed
                </Link>
              </motion.div>
            )}
          </AnimatePresence>
        </Step>
      </ol>
    </Page>
  )
}
