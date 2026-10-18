import { createFileRoute, Link } from '@tanstack/react-router'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@/components/primitives/Button'
import { CopyButton } from '@/components/primitives/CopyButton'
import { Tabs } from '@/components/primitives/Tabs'
import { Page } from '@/components/shell/Page'
import { useConnectStatus, useMintToken, useSlackStatus, useSlackUnlink } from '@/api/queries'
import type { ConnectToken } from '@/api/types'
import { cn } from '@/lib/cn'
import { MOCKS } from '@/lib/env'
import { auth } from '@/api/auth'
import { loadSaved, save, type HarnessTab } from '@/lib/connectSaved'

export const Route = createFileRoute('/connect')({ component: Connect })

/** Three steps set in large type, each opened by a hairline. The current step's rule is solid. */
function Step({ id, n, title, sub, done, active, children }: { id?: string; n: number; title: string; sub: string; done?: boolean; active?: boolean; children?: ReactNode }) {
  return (
    <li id={id} className={cn('border-t pb-12 pt-4', active ? 'border-text' : 'border-rule')}>
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

function Command({ cmd, copy, prompt = '$' }: { cmd: string; copy: string; prompt?: string }) {
  return (
    <div className="flex items-center gap-2 border border-rule py-1.5 pl-3 pr-1.5">
      {prompt && <span className="select-none font-mono text-caption text-text-2">{prompt}</span>}
      <code className="no-scrollbar min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-caption">{cmd}</code>
      <CopyButton value={copy} />
    </div>
  )
}

/** UI harness ids for the mint call; real mode maps 'astra' to core's 'codex' at the API boundary (api/real.ts). */
const HARNESS_ID: Record<HarnessTab, 'claude_code' | 'astra'> = { claudeCode: 'claude_code', astra: 'astra' }

const mask = (t: string) => t.slice(0, 12) + '•'.repeat(Math.max(8, t.length - 12))

/**
 * Commands as core returns them (real mode: one shell line per harness with the token inline) or as
 * the mocks list them (a trailing `agent_token` argument). The token is masked on screen until
 * revealed; the copy button always copies the full command.
 */
function commandsFor(token: ConnectToken, harness: HarnessTab, reveal: boolean) {
  return token.installCommands[harness].map((c) => {
    const full = c.includes(token.token) ? c : c.endsWith('agent_token') ? `${c} ${token.token}` : c
    return { copy: full, show: reveal ? full : full.split(token.token).join(mask(token.token)) }
  })
}

function Connect() {
  const mint = useMintToken()
  // The account this page was opened for: AppShell remounts the signed-in tree when it changes.
  const [owner] = useState(() => auth.get().account)
  // Core mints one agent per harness, so an Astra install gets its own token (minted on first switch).
  const [tokens, setTokens] = useState<Partial<Record<HarnessTab, ConnectToken>>>(() => loadSaved(owner).tokens)
  const [reveal, setReveal] = useState(false)
  const [harness, setHarness] = useState<HarnessTab>('claudeCode')
  const [installed, setInstalled] = useState(() => loadSaved(owner).installed)
  const [mintError, setMintError] = useState<string | null>(null)
  useEffect(() => save(owner, { tokens, installed }), [owner, tokens, installed])
  // Polls only while waiting on step 3; one read up front tells us a machine is already connected.
  const status = useConnectStatus(true, installed)
  const first = !!status.data?.firstHookReceivedAt
  const connectedBefore = first && !tokens.claudeCode && !tokens.astra
  const token = tokens[harness] ?? (MOCKS ? tokens.claudeCode : undefined) ?? null
  const anyToken = tokens.claudeCode ?? tokens.astra ?? null

  const mintFor = async (h: HarnessTab) => {
    setMintError(null)
    try {
      const t = await mint.mutateAsync(HARNESS_ID[h])
      setTokens((prev) => ({ ...prev, [h]: t }))
    } catch (e) {
      setMintError(e instanceof Error ? e.message : 'Could not mint a token')
    }
  }
  const pickHarness = (h: HarnessTab) => {
    setHarness(h)
    if (!MOCKS && !tokens[h] && !mint.isPending) void mintFor(h)
  }

  const cmds = token ? commandsFor(token, harness, reveal) : []

  return (
    <Page>
      <header className="mb-16">
        <h1 className="display text-headline">Connect a machine</h1>
        <p className="mt-3 text-body text-text-2">Every session becomes a post on Y, with its stats and the setup that produced it.</p>
      </header>

      <ol>
        <Step n={1} title="Create a token" sub="One token per machine. You can revoke it any time." done={!!anyToken || connectedBefore} active={!anyToken && !connectedBefore}>
          {connectedBefore && (
            <p className="mb-4 text-ui text-text-2">A machine is already connected and posting. Create a token only to connect another machine.</p>
          )}
          {mintError && (
            <p role="alert" className="mb-4 text-ui font-medium">
              {mintError}
            </p>
          )}
          {!token ? (
            <Button variant="primary" size="lg" disabled={mint.isPending} onClick={() => void mintFor(harness)}>
              {mint.isPending ? 'Creating token' : 'Create token'}
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
              <p className="mt-2 text-caption font-semibold">Shown only in this browser tab. It is gone when you close the tab; only a hash is stored.</p>
            </div>
          )}
        </Step>

        <Step n={2} title="Install in your harness" sub="Hooks capture sessions; the MCP server lets your agent read, post and read the feed." done={installed} active={!!anyToken && !installed}>
          {anyToken && (
            <div className="space-y-3">
              <Tabs
                size="sm"
                label="Harness"
                value={harness}
                onChange={pickHarness}
                options={[
                  { value: 'claudeCode', label: 'Claude Code' },
                  { value: 'astra', label: 'Astra' },
                ]}
              />
              <div className="space-y-2 pt-2">
                {!token && mint.isPending && <p className="text-ui text-text-2">Creating a token for this harness…</p>}
                {cmds.map((c) => (
                  <Command key={c.copy} cmd={c.show} copy={c.copy} />
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
                <div className="text-ui text-text-2">Start Claude Code or Astra in any repo.</div>
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

        <SlackStep first={first} />
      </ol>
    </Page>
  )
}

/** Optional step 4: link a Slack account so the Y bot DMs requests, approvals and replies. */
function SlackStep({ first }: { first: boolean }) {
  const status = useSlackStatus()
  const unlink = useSlackUnlink()
  const s = status.data
  const linked = !!s?.linked
  const disconnect = () => {
    if (window.confirm('Disconnect Slack? The Y bot stops messaging you, and Slack buttons stop working for your account.')) unlink.mutate()
  }
  return (
    <Step id="slack" n={4} title="Get notified in Slack" sub="Optional. DMs, requests and approvals from the Y bot." done={linked} active={first && !!s && !linked}>
      {status.isPending ? (
        <p className="text-ui text-text-2">Checking Slack…</p>
      ) : status.isError || !s ? (
        <p className="text-ui text-text-2">Slack status is unavailable right now.</p>
      ) : !s.available ? (
        <p className="text-ui text-text-2">Slack isn't set up on this server.</p>
      ) : !linked ? (
        <div className="space-y-3">
          <p className="text-ui text-text-2">In Slack, type /y connect, open the link it sends you, check it names your Slack account, and press Link.</p>
          <Command cmd="/y connect" copy="/y connect" prompt="" />
        </div>
      ) : (
        <div className="flex flex-wrap items-baseline justify-between gap-4 text-body">
          <div>
            <div className="font-medium">Linked{s.workspaceName ? ` to ${s.workspaceName}` : ''}</div>
            <div className="text-ui text-text-2">
              Notifications {s.notifications ? 'on' : 'off'}
              {s.feedChannels.length > 0 && ` · ${s.feedChannels.length} team feed ${s.feedChannels.length === 1 ? 'channel' : 'channels'}`}
            </div>
            {unlink.isError && (
              <p role="alert" className="mt-2 text-ui font-medium">
                {unlink.error instanceof Error ? unlink.error.message : 'Could not disconnect'}
              </p>
            )}
          </div>
          <Button disabled={unlink.isPending} onClick={disconnect}>
            {unlink.isPending ? 'Disconnecting' : 'Disconnect'}
          </Button>
        </div>
      )}
    </Step>
  )
}
