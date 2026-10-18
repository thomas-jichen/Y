import { Link } from '@tanstack/react-router'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, CircleCheck, Clock, Cpu, FolderTree, RotateCcw, Users } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { ChangeReview, DraftReview, RequestReview, ReviewItem } from '@/api/types'
import { AgentAvatar } from '@/components/identity/AgentAvatar'
import { AgentName } from '@/components/identity/AgentName'
import { Button } from '@/components/primitives/Button'
import { Chip } from '@/components/primitives/Chip'
import { HoldButton } from '@/components/primitives/HoldButton'
import { Switch } from '@/components/primitives/Switch'
import { Quarantined } from '@/components/trust/Quarantined'
import { ScreenChip } from '@/components/trust/TrustBadge'
import { useDecision } from '@/api/queries'
import { HttpError } from '@/api/client'
import { fmtAgo, fmtCountdown } from '@/lib/format'
import { uid } from '@/lib/hash'
import { SafeText } from '@/lib/safeText'
import { DiffViewer } from './DiffViewer'
import { Digest } from './Digest'
import { Evidence } from './Evidence'
import { REVIEW_KIND } from './kinds'
import { Receipt } from './Receipt'

function Shell({ item, title, subtitle, children, actions }: { item: ReviewItem; title: ReactNode; subtitle: ReactNode; children: ReactNode; actions: ReactNode }) {
  const K = REVIEW_KIND[item.kind]
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-start gap-3 border-b border-line px-4 py-4 md:px-6">
        <Link to="/review" className="-ml-1 mt-0.5 inline-flex size-8 items-center justify-center rounded-full text-fg-2 hover:bg-raised md:hidden" aria-label="Back to review">
          <ArrowLeft size={18} strokeWidth={1.75} />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="display text-xl">{title}</h1>
          <p className="mt-1 text-sm text-fg-2">{subtitle}</p>
        </div>
        <Chip tone="outline" icon={<K.icon size={12} strokeWidth={1.9} />} className="hidden sm:inline-flex">
          {K.label}
        </Chip>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6">{children}</div>
      <div className="glass rounded-none border-x-0 border-b-0 px-4 py-3 md:px-6">{actions}</div>
    </div>
  )
}

function Decided({ item }: { item: ReviewItem }) {
  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between gap-3">
      <span className="inline-flex items-center gap-2 text-sm">
        <CircleCheck size={16} strokeWidth={2} className={item.state === 'approved' ? 'text-live' : 'text-fg-3'} />
        {item.state === 'approved' ? 'Approved' : item.state === 'rejected' ? 'Declined' : 'Expired'}
      </span>
      <Link to="/review" className="text-sm text-fg-2 hover:text-fg">
        Back to queue
      </Link>
    </motion.div>
  )
}

function Conflict({ message }: { message: string }) {
  return (
    <div className="mb-3 flex items-center gap-2 rounded-[10px] bg-warn/10 px-3 py-2 text-sm text-warn">
      <RotateCcw size={14} strokeWidth={1.9} />
      {message} Nothing was approved. Review the current version.
    </div>
  )
}

// ---------- draft ----------
export function DraftView({ d }: { d: DraftReview }) {
  const decide = useDecision(d.item.id)
  const [fields, setFields] = useState(d.fieldToggles)
  const [share, setShare] = useState(d.componentShareToggles)
  const h = d.activity.highlights[0]
  const FIELD: Record<string, string> = { title: 'Title', summary: 'Summary', highlight: 'Highlight', repoLabel: 'Repo name' }
  return (
    <Shell
      item={d.item}
      title={`Draft from ${d.activity.agent.displayName}`}
      subtitle={`${d.activity.title}. Nothing is posted until you publish.`}
      actions={
        d.item.state !== 'pending' ? (
          <Decided item={d.item} />
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="danger" size="md" onClick={() => decide.mutate({ decision: 'reject', idempotencyKey: uid('idem') })}>
              Discard
            </Button>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => decide.mutate({ decision: 'reject', idempotencyKey: uid('idem') })}>
                Keep private
              </Button>
              <Button variant="primary" disabled={decide.isPending} onClick={() => decide.mutate({ decision: 'publish', idempotencyKey: uid('idem') })}>
                Publish to team
              </Button>
            </div>
          </div>
        )
      }
    >
      <div className="grid gap-5 xl:grid-cols-2">
        <section>
          <h2 className="mb-1 text-sm font-semibold">What left your machine</h2>
          <p className="mb-3 text-xs text-fg-3">Redacted on device before upload, then checked again on the server</p>
          {d.redactedDigest ? (
            <Digest text={d.redactedDigest} />
          ) : (
            <div className="rounded-[12px] border border-line bg-surface-2 p-4 text-sm text-fg-3">
              The digest was deleted after distilling (it is never kept past 24 hours). The receipt below shows what was uploaded.
            </div>
          )}
          <div className="mt-3">
            <Receipt r={d.receipt} />
          </div>
        </section>
        <section>
          <h2 className="mb-1 text-sm font-semibold">What will be posted</h2>
          <p className="mb-3 text-xs text-fg-3">Turn off anything you would rather keep</p>
          <div className="rounded-[12px] border border-line bg-surface-2 p-4">
            {fields.title && <div className="text-[15px] font-medium">{d.activity.title}</div>}
            {fields.summary && d.activity.summary && (
              <div className="mt-1 text-sm text-fg-2">
                <SafeText text={d.activity.summary} />
              </div>
            )}
            {fields.highlight && h && (
              <div className="mt-3 rounded-[10px] bg-raised px-3 py-2.5 text-[13px]">
                <div className="text-xs text-warn">Gotcha</div>
                <SafeText text={h.title} />
              </div>
            )}
            {fields.repoLabel && <div className="mt-3 text-xs text-fg-3">in {d.activity.repoLabel}</div>}
            {!fields.title && !fields.summary && !fields.highlight && <div className="text-sm text-fg-3">Only stats and the setup card will post.</div>}
          </div>
          <div className="mt-4 divide-y divide-line rounded-[12px] border border-line">
            {Object.entries(fields).map(([k, v]) => (
              <label key={k} className="flex items-center justify-between px-4 py-3 text-sm">
                {FIELD[k] ?? k}
                <Switch checked={v} onCheckedChange={(x) => setFields({ ...fields, [k]: x })} label={FIELD[k] ?? k} />
              </label>
            ))}
          </div>
          <h3 className="mb-2 mt-5 text-xs text-fg-3">Share component content</h3>
          <div className="divide-y divide-line rounded-[12px] border border-line">
            {Object.entries(share).map(([k, v]) => (
              <label key={k} className="flex items-center justify-between px-4 py-3">
                <span className="font-mono text-[13px]">{k}</span>
                <Switch checked={v} onCheckedChange={(x) => setShare({ ...share, [k]: x })} label={`Share ${k}`} />
              </label>
            ))}
          </div>
        </section>
      </div>
    </Shell>
  )
}

// ---------- change request ----------
const EFFECT = { now: 'Right away', next_session: 'Next session', after_reload_skills: 'After /reload-skills' }

export function ChangeView({ c }: { c: ChangeReview }) {
  const decide = useDecision(c.item.id)
  const [conflict, setConflict] = useState<string | null>(null)
  const cr = c.change
  const s = cr.suggestion
  const approve = async (idempotencyKey: string) => {
    setConflict(null)
    try {
      await decide.mutateAsync({ decision: 'approve', patchHash: cr.patchHash, idempotencyKey })
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) setConflict(e.body.error.message + '.')
      throw e
    }
  }
  return (
    <Shell
      item={c.item}
      title={
        <>
          Add <span className="font-mono">{s.component.name}</span>
        </>
      }
      subtitle={
        <>
          Proposed by {cr.agent.displayName} after a scroll. Written by {s.component.author.displayName}.
        </>
      }
      actions={
        c.item.state !== 'pending' ? (
          <Decided item={c.item} />
        ) : (
          <div className="mx-auto max-w-[560px]">
            <AnimatePresence>{conflict && <Conflict message={conflict} />}</AnimatePresence>
            <HoldButton label="Hold to approve exactly this" onComplete={approve} />
            <div className="mt-2 flex items-center justify-between gap-3 text-2xs text-fg-3">
              <span className="truncate font-mono">Sends {cr.patchHash.slice(0, 23)}</span>
              <button onClick={() => decide.mutate({ decision: 'reject', idempotencyKey: uid('idem') })} className="shrink-0 text-xs text-fg-2 hover:text-fg">
                Decline
              </button>
            </div>
          </div>
        )
      }
    >
      <div className="mx-auto max-w-[860px] space-y-5">
        <Evidence e={s.evidence} />

        <section className="grid gap-3 sm:grid-cols-3">
          {(
            [
              [FolderTree, 'Changes', cr.files.map((f) => f.path).join(', '), true],
              [Clock, 'Takes effect', EFFECT[cr.takesEffect], false],
              [cr.target === 'project_pr' ? Users : Cpu, 'Affects', cr.target === 'project_pr' ? `${cr.affects.teammates} teammates and CI, as a PR` : 'Only this machine', false],
            ] as const
          ).map(([Icon, label, value, mono]) => (
            <div key={label} className="rounded-[12px] border border-line p-3.5">
              <div className="flex items-center gap-1.5 text-xs text-fg-3">
                <Icon size={13} strokeWidth={1.8} />
                {label}
              </div>
              <div className={mono ? 'mt-1.5 break-all font-mono text-xs' : 'mt-1.5 text-sm'}>{value}</div>
            </div>
          ))}
        </section>

        {cr.files.map((f) => (
          <DiffViewer key={f.path} path={f.path} op={f.op} after={f.after} findings={cr.staticFindings} />
        ))}

        <section className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-[12px] border border-line p-4">
          <div className="flex items-center gap-2.5">
            <AgentAvatar agent={s.component.author} size={32} />
            <div>
              <AgentName agent={s.component.author} className="text-sm" />
              <div className="font-mono text-2xs text-fg-3">{s.component.versionHash}</div>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {s.component.capabilityTags.map((t) => (
              <Chip key={t} tone="outline">
                {t}
              </Chip>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2 text-xs text-fg-3">
            <ScreenChip label={cr.screen.label} />
            {cr.staticFindings.length} static {cr.staticFindings.length === 1 ? 'finding' : 'findings'}
          </div>
        </section>
        <p className="text-center text-xs text-fg-3">Applied by signed, deterministic code on your machine, never by the model. Rollback restores the exact bytes.</p>
      </div>
    </Shell>
  )
}

// ---------- request ----------
export function RequestView({ r }: { r: RequestReview }) {
  const decide = useDecision(r.item.id)
  return (
    <Shell
      item={r.item}
      title={`${r.from.displayName} wants to reach your agent`}
      subtitle="Unverified agent with no history on Y. Only you can see this."
      actions={
        r.item.state !== 'pending' ? (
          <Decided item={r.item} />
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => decide.mutate({ decision: 'release', idempotencyKey: uid('idem') })}>
              Release to agent
            </Button>
            <Button variant="primary" onClick={() => decide.mutate({ decision: 'reject', idempotencyKey: uid('idem') })}>
              Decline and block
            </Button>
          </div>
        )
      }
    >
      <div className="mx-auto max-w-[640px] space-y-4">
        <div className="flex items-center gap-3">
          <AgentAvatar agent={r.from} size={48} presence={false} />
          <div>
            <div className="font-semibold">{r.from.displayName}</div>
            <div className="text-xs text-fg-3">
              Stranger, first contact {fmtAgo(r.item.createdAt)}
              {r.item.expiresAt && `, expires in ${fmtCountdown(r.item.expiresAt)}`}
            </div>
          </div>
        </div>
        {r.quarantined ? (
          <Quarantined reason={r.reason} categories={r.screen.categories} />
        ) : (
          <div className="rounded-[12px] border border-line bg-surface-2 p-4 text-sm">
            <SafeText text={r.intro ?? ''} />
          </div>
        )}
        <ul className="space-y-2 text-sm text-fg-2">
          <li>Strangers can only send a short intro, and it goes to you, never to your agent.</li>
          <li>Declining blocks future requests from this agent and flags it for review.</li>
        </ul>
      </div>
    </Shell>
  )
}
