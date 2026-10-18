import { Link } from '@tanstack/react-router'
import { AnimatePresence, motion } from 'motion/react'
import { useState, type ReactNode } from 'react'
import type { BuilderReplyReview, ChangeReview, DraftReview, RequestReview, ReviewItem } from '@/api/types'
import { AgentAvatar } from '@/components/identity/AgentAvatar'
import { AgentName } from '@/components/identity/AgentName'
import { Button } from '@/components/primitives/Button'
import { HoldButton } from '@/components/primitives/HoldButton'
import { Spec } from '@/components/primitives/Spec'
import { Switch } from '@/components/primitives/Switch'
import { MessageItem } from '@/components/chats/MessageItem'
import { Quarantined } from '@/components/trust/Quarantined'
import { SCREEN } from '@/lib/trust'
import { useDecision } from '@/api/queries'
import { HttpError } from '@/api/client'
import { fmtAgo, fmtCountdown } from '@/lib/format'
import { uid } from '@/lib/hash'
import { countHidden, HiddenChip, SafeText } from '@/lib/safeText'
import { DiffViewer } from './DiffViewer'
import { Digest } from './Digest'
import { Evidence } from './Evidence'
import { REVIEW_KIND } from './kinds'
import { ReleaseAction, RequestIntro } from './RequestIntro'
import { Receipt } from './Receipt'

/** One decision per screen: the case on the page, the actions on a glass bar that floats over it. */
function Shell({ item, title, subtitle, children, actions }: { item: ReviewItem; title: ReactNode; subtitle: ReactNode; children: ReactNode; actions: ReactNode }) {
  const K = REVIEW_KIND[item.kind]
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-40 pt-8 md:px-10">
        <div className="max-w-[860px]">
          <Link to="/review" className="mb-6 inline-block text-ui text-text-2 md:hidden">
            ← Review
          </Link>
          <div className="text-caption text-text-2">
            {K.label}
            {item.agent && ` · from ${item.agent.displayName}`} · {fmtAgo(item.createdAt)}
          </div>
          <h1 className="display mt-2 text-title">{title}</h1>
          <p className="mt-2 text-body text-text-2">{subtitle}</p>
          <div className="mt-10">{children}</div>
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 px-4 pb-4 md:px-10">
        <div className="glass pointer-events-auto max-w-[860px] rounded-[28px] px-5 py-3">{actions}</div>
      </div>
    </div>
  )
}

function Decided({ item, approved = 'Approved' }: { item: ReviewItem; approved?: string }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex h-10 items-center justify-between gap-3 text-ui">
      <span className="font-medium">{item.state === 'approved' ? approved : item.state === 'rejected' ? 'Declined' : 'Expired'}</span>
      <Link to="/review" className="underline decoration-1 underline-offset-4">
        Back to queue
      </Link>
    </motion.div>
  )
}

function Conflict({ message }: { message: string }) {
  return <div className="mb-2 text-ui font-semibold">{message} Nothing was approved. Review the current version.</div>
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="border-t border-text pt-3">
      <h2 className="text-caption">{title}</h2>
      {note && <p className="mt-1 text-caption text-text-2">{note}</p>}
      <div className="mt-5">{children}</div>
    </section>
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
          <div className="flex items-center justify-end gap-5">
            <button className="text-ui underline-offset-4 hover:underline" onClick={() => decide.mutate({ decision: 'reject', idempotencyKey: uid('idem') })}>
              Keep private
            </button>
            <Button variant="primary" className="rounded-full" disabled={decide.isPending} onClick={() => decide.mutate({ decision: 'publish', idempotencyKey: uid('idem') })}>
              Publish to team
            </Button>
          </div>
        )
      }
    >
      <div className="grid gap-12 xl:grid-cols-2">
        <Section title="What will be posted" note="Turn off anything you would rather keep">
          <div className="border border-rule p-5 text-body">
            {fields.title && <div className="font-medium">{d.activity.title}</div>}
            {fields.summary && d.activity.summary && (
              <div className="mt-1 text-text-2">
                <SafeText text={d.activity.summary} />
              </div>
            )}
            {fields.highlight && h && (
              <div className="mt-4 grid grid-cols-[72px_1fr] gap-x-4 text-ui">
                <span className="font-semibold">Gotcha</span>
                <SafeText text={h.title} />
              </div>
            )}
            {fields.repoLabel && <div className="mt-3 text-caption text-text-2">in {d.activity.repoLabel}</div>}
            {!fields.title && !fields.summary && !fields.highlight && <div className="text-ui text-text-2">Only stats and the setup card will post.</div>}
          </div>
          <div className="mt-6 divide-y divide-rule border-y border-rule">
            {Object.entries(fields).map(([k, v]) => (
              <label key={k} className="flex items-center justify-between py-3 text-ui">
                {FIELD[k] ?? k}
                <Switch checked={v} onCheckedChange={(x) => setFields({ ...fields, [k]: x })} label={FIELD[k] ?? k} />
              </label>
            ))}
          </div>
          <h3 className="mb-1 mt-8 text-caption text-text-2">Share component content</h3>
          <div className="divide-y divide-rule border-y border-rule">
            {Object.entries(share).map(([k, v]) => (
              <label key={k} className="flex items-center justify-between py-3">
                <span className="font-mono text-ui">{k}</span>
                <Switch checked={v} onCheckedChange={(x) => setShare({ ...share, [k]: x })} label={`Share ${k}`} />
              </label>
            ))}
          </div>
        </Section>
        <Section title="What left your machine" note="Redacted on device before upload, then checked again on the server">
          {d.redactedDigest ? (
            <Digest text={d.redactedDigest} />
          ) : (
            <p className="border border-rule p-5 text-body text-text-2">
              The digest was deleted after distilling (it is never kept past 24 hours). The receipt below shows what was uploaded.
            </p>
          )}
          <div className="mt-6">
            <Receipt r={d.receipt} />
          </div>
        </Section>
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
          Proposed by {cr.agent.displayName} after reading the feed. Written by {s.component.author.displayName}.
        </>
      }
      actions={
        c.item.state !== 'pending' ? (
          <Decided item={c.item} />
        ) : (
          <div>
            <AnimatePresence>{conflict && <Conflict message={conflict} />}</AnimatePresence>
            <div className="flex items-center gap-5">
              <HoldButton label="Hold to approve exactly this" onComplete={approve} className="flex-1" />
              <button onClick={() => decide.mutate({ decision: 'reject', idempotencyKey: uid('idem') })} className="shrink-0 text-ui underline-offset-4 hover:underline">
                Decline
              </button>
            </div>
            <div className="mt-1.5 truncate px-1 font-mono text-caption">Sends {cr.patchHash.slice(0, 23)}</div>
          </div>
        )
      }
    >
      <div className="space-y-12">
        <Evidence e={s.evidence} />
        <Spec
          rows={[
            ['Changes', <span key="f" className="break-all font-mono font-normal">{cr.files.map((f) => f.path).join(', ')}</span>],
            ['Takes effect', EFFECT[cr.takesEffect]],
            ['Affects', cr.target === 'project_pr' ? `${cr.affects.teammates} teammates and CI, as a PR` : 'Only this machine'],
            ['Written by', <AgentName key="a" agent={s.component.author} className="font-medium" />],
            ['Version', <span key="v" className="font-mono font-normal">{s.component.versionHash}</span>],
            ['Capabilities', s.component.capabilityTags.join(', ')],
            ['Screen', `${SCREEN[cr.screen.label].label}. ${cr.staticFindings.length} static ${cr.staticFindings.length === 1 ? 'finding' : 'findings'}.`],
          ]}
        />
        {cr.files.map((f) => (
          <DiffViewer key={f.path} path={f.path} op={f.op} after={f.after} findings={cr.staticFindings} />
        ))}
        <p className="text-caption text-text-2">Applied by signed, deterministic code on your machine, never by the model. Rollback restores the exact bytes.</p>
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
          <ReleaseAction
            screen={r.screen}
            onRelease={() => decide.mutate({ decision: 'release', idempotencyKey: uid('idem') })}
            onReject={() => decide.mutate({ decision: 'reject', idempotencyKey: uid('idem') })}
          />
        )
      }
    >
      <div className="max-w-[640px] space-y-8">
        <div className="flex items-center gap-4">
          <AgentAvatar agent={r.from} size={48} presence={false} />
          <div>
            <div className="text-ui font-medium">{r.from.displayName}</div>
            <div className="text-caption text-text-2">
              Unverified, first contact {fmtAgo(r.item.createdAt)}
              {r.item.expiresAt && `, expires in ${fmtCountdown(r.item.expiresAt)}`}
            </div>
          </div>
        </div>
        {r.quarantined ? (
          <Quarantined reason={r.reason} categories={r.screen.categories} />
        ) : (
          <RequestIntro intro={r.intro ?? ''} screen={r.screen} />
        )}
        <div className="space-y-2 text-ui text-text-2">
          <p>Unverified agents can only send a short intro, and it goes to you, never to your agent.</p>
          <p>Declining blocks future requests from this agent and flags it for review.</p>
        </div>
      </div>
    </Shell>
  )
}

// ---------- builder reply ----------
// Core's cross-owner limit (CROSS_OWNER_BODY_MAX): a longer reply could never reach the customer.
const MAX_REPLY = 1000

export function BuilderReplyView({ b }: { b: BuilderReplyReview }) {
  const decide = useDecision(b.item.id)
  const [body, setBody] = useState(b.draft.body)
  const [refused, setRefused] = useState<string | null>(null)
  const text = body.trim()
  const edited = text !== b.draft.body.trim()
  const send = async () => {
    setRefused(null)
    try {
      await decide.mutateAsync({ decision: 'approve', ...(edited ? { edits: { body: text } } : {}), idempotencyKey: uid('idem') })
    } catch (e) {
      // Core refuses, before deciding, a reply it would not send (too long, code or a secret, product no longer live).
      if (e instanceof HttpError && e.status === 400) setRefused(e.body.error.message + '.')
      else throw e
    }
  }
  const product = b.thread.product?.name ?? 'your product'
  const builder = b.draft.sender.agent
  const customer = b.question.sender.agent
  return (
    <Shell
      item={b.item}
      title={`Reply to a customer of ${product}`}
      subtitle={`${builder?.displayName ?? 'Your agent'} drafted this answer. Nothing reaches the customer’s agent until you send it.`}
      actions={
        b.item.state !== 'pending' ? (
          <Decided item={b.item} approved="Sent" />
        ) : (
          <div className="flex items-center justify-end gap-5">
            <button className="text-ui underline-offset-4 hover:underline" onClick={() => decide.mutate({ decision: 'reject', idempotencyKey: uid('idem') })}>
              Don’t send
            </button>
            <Button
              variant="primary"
              className="rounded-full"
              disabled={!text || text.length > MAX_REPLY || decide.isPending}
              onClick={() => void send()}
            >
              {edited ? 'Send edited reply' : 'Send reply'}
            </Button>
          </div>
        )
      }
    >
      <div className="max-w-[640px] space-y-12">
        <Section title="The customer asked" note={`${customer ? `From ${customer.displayName}, ` : ''}an agent outside your team. Shown as data.`}>
          <MessageItem m={b.question} />
        </Section>
        <Section title="Your agent’s draft" note="Edit it before sending. Edits are screened again: a reply that looks like it holds a secret or code is held, not sent.">
          <div className="border-b border-rule focus-within:border-text">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              readOnly={b.item.state !== 'pending'}
              rows={6}
              maxLength={MAX_REPLY}
              aria-label="Reply to the customer"
              className="max-h-[60vh] min-h-32 w-full resize-none bg-transparent py-2.5 text-body text-text outline-none [field-sizing:content]"
            />
          </div>
          {b.item.state === 'pending' && (
            <div className="mt-2 flex items-center justify-between gap-4 text-caption text-text-2">
              {edited ? (
                <button className="underline-offset-4 hover:underline" onClick={() => setBody(b.draft.body)}>
                  Restore the draft
                </button>
              ) : (
                <span />
              )}
              <span className="tabular-nums">{body.length} / {MAX_REPLY}</span>
            </div>
          )}
          <HiddenChip count={countHidden(body)} removed={false} />
          {refused && <p className="mt-2 text-caption text-text">{refused}</p>}
        </Section>
        <p className="text-caption text-text-2">The customer only sees replies you send. Declining sends nothing to the customer.</p>
      </div>
    </Shell>
  )
}
