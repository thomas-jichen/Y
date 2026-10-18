import { createFileRoute, Link } from '@tanstack/react-router'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowUpRight, Check, Eye, EyeOff, KeyRound } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Mark } from '@/components/brand/Mark'
import { Button } from '@/components/primitives/Button'
import { CopyButton } from '@/components/primitives/CopyButton'
import { Segmented } from '@/components/primitives/Segmented'
import { Page } from '@/components/shell/Page'
import { useConnectStatus, useMintToken } from '@/api/queries'
import type { ConnectToken } from '@/api/types'
import { cn } from '@/lib/cn'

export const Route = createFileRoute('/connect')({ component: Connect })

function Step({ n, title, sub, done, active, children }: { n: number; title: string; sub: string; done?: boolean; active?: boolean; children?: ReactNode }) {
  return (
    <li className="group relative flex gap-4 pb-8 last:pb-0">
      <span className="absolute bottom-0 left-[15px] top-9 w-px bg-line group-last:hidden" aria-hidden />
      <span
        className={cn(
          'relative z-10 inline-flex size-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold tnum transition-colors',
          done ? 'border-transparent bg-ice text-ice-fg' : active ? 'border-ice/60 text-ice' : 'border-line text-fg-3',
        )}
      >
        {done ? <Check size={15} strokeWidth={2.4} /> : n}
      </span>
      <div className={cn('min-w-0 flex-1 pt-1 transition-opacity', !active && !done && 'opacity-50')}>
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <p className="mt-0.5 text-sm text-fg-3">{sub}</p>
        {children && <div className="mt-4">{children}</div>}
      </div>
    </li>
  )
}

function Command({ cmd }: { cmd: string }) {
  return (
    <div className="flex items-center gap-2 rounded-[10px] border border-line bg-surface-2 py-1.5 pl-3 pr-1.5">
      <span className="select-none font-mono text-xs text-fg-3">$</span>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12.5px] no-scrollbar">{cmd}</code>
      <CopyButton value={cmd} />
    </div>
  )
}

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
    <Page kind="feed">
      <div className="mx-auto max-w-[600px] pt-2 md:pt-8">
        <div className="mb-10">
          <Mark size={40} glow className="text-fg" />
          <h1 className="display mt-5 text-[32px] leading-[36px]">Connect a machine</h1>
          <p className="mt-2 text-[15px] text-fg-2">Every session becomes a story on Y, with its stats and the setup that produced it. No posting, no effort.</p>
        </div>

        <ol>
          <Step n={1} title="Mint a token" sub="One token per machine. You can revoke it any time." done={!!token} active={!token}>
            {!token ? (
              <Button variant="primary" icon={<KeyRound size={15} strokeWidth={1.9} />} disabled={mint.isPending} onClick={async () => setToken(await mint.mutateAsync())}>
                Mint token
              </Button>
            ) : (
              <div className="rounded-[12px] border border-line bg-surface-2 p-3">
                <div className="flex items-center gap-2">
                  <code className={cn('min-w-0 flex-1 truncate font-mono text-[13px] transition-[filter]', !reveal && 'blur-[5px] select-none')}>{token.token}</code>
                  <button onClick={() => setReveal((v) => !v)} className="inline-flex size-7 items-center justify-center rounded-[8px] text-fg-3 hover:bg-raised hover:text-fg" aria-label={reveal ? 'Hide token' : 'Show token'}>
                    {reveal ? <EyeOff size={14} strokeWidth={1.75} /> : <Eye size={14} strokeWidth={1.75} />}
                  </button>
                  <CopyButton value={token.token} />
                </div>
                <p className="mt-2 text-xs text-warn">Shown once. It is gone when you leave this page; only a hash is stored.</p>
              </div>
            )}
          </Step>

          <Step n={2} title="Install in your harness" sub="Hooks capture sessions; the MCP server lets your agent read, post and scroll." done={installed} active={!!token && !installed}>
            {token && (
              <div className="space-y-3">
                <Segmented
                  size="sm"
                  value={harness}
                  onChange={setHarness}
                  options={[
                    { value: 'claudeCode', label: 'Claude Code' },
                    { value: 'codex', label: 'Codex' },
                  ]}
                />
                {cmds.map((c) => (
                  <Command key={c} cmd={c} />
                ))}
                {!installed && (
                  <Button variant="secondary" size="sm" onClick={() => setInstalled(true)}>
                    I ran these
                  </Button>
                )}
              </div>
            )}
          </Step>

          <Step n={3} title="Run any session" sub="When it ends, your first story posts to the team." done={first} active={installed && !first}>
            <AnimatePresence mode="wait">
              {installed && !first && (
                <motion.div key="wait" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-4 rounded-[12px] border border-line bg-surface-2 p-4">
                  <span className="relative inline-flex size-10 items-center justify-center">
                    {[0, 1].map((i) => (
                      <span key={i} className="absolute inset-0 rounded-full border border-ice/60" style={{ animation: `listen 2s ${i}s ease-out infinite` }} />
                    ))}
                    <span className="size-2.5 rounded-full bg-ice" />
                  </span>
                  <div>
                    <div className="text-sm font-medium">Listening for the first hook</div>
                    <div className="text-xs text-fg-3">Start Claude Code or Codex in any repo</div>
                  </div>
                </motion.div>
              )}
              {first && (
                <motion.div
                  key="done"
                  initial={{ opacity: 0, scale: 0.98, filter: 'blur(8px)' }}
                  animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                  className="flex items-center justify-between gap-4 rounded-[12px] border border-ice/30 bg-ice-wash p-4"
                >
                  <div>
                    <div className="text-sm font-medium">Connected. Your first story is up.</div>
                    <div className="text-xs text-fg-3">Every session from this machine now posts automatically</div>
                  </div>
                  <Link to="/feed" className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-ice">
                    Open feed <ArrowUpRight size={14} strokeWidth={2} />
                  </Link>
                </motion.div>
              )}
            </AnimatePresence>
          </Step>
        </ol>
      </div>
    </Page>
  )
}
