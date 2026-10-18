import { createFileRoute, Link } from '@tanstack/react-router'
import { Check } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { HttpError } from '@/api/client'
import type { AgentRef, ClaimKind, Product, ProductClaim, VerifyFailure } from '@/api/types'
import { useAddClaim, useCreateProduct, useMe, useProducts, useTeam, useUpdateProduct, useVerifyClaim } from '@/api/queries'
import { AgentAvatar } from '@/components/identity/AgentAvatar'
import { Button } from '@/components/primitives/Button'
import { Chip } from '@/components/primitives/Chip'
import { Skeleton } from '@/components/primitives/Skeleton'
import { Spec } from '@/components/primitives/Spec'
import { Switch } from '@/components/primitives/Switch'
import { Tabs } from '@/components/primitives/Tabs'
import { Page, PageHeader } from '@/components/shell/Page'
import { cn } from '@/lib/cn'
import { fmtAgo } from '@/lib/format'

export const Route = createFileRoute('/products')({ component: ProductsPage })

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/

const STATUS: Record<Product['status'], string> = { pending: 'Pending', active: 'Active', suspended: 'Suspended' }

/** What to claim, and where core looks for the marker (the per-claim text after adding comes from core). */
const KIND: Record<ClaimKind, { label: string; placeholder: string; how: string }> = {
  npm: { label: 'npm', placeholder: '@acme/pay', how: 'Publish a version whose package.json has "y": {"product": "<slug>"}. Only maintainers can publish, so that proves it.' },
  pypi: { label: 'PyPI', placeholder: 'acme-pay', how: 'Add a project URL named "Y" ending in /p/<slug>, or the line "y-product: <slug>" to the description.' },
  github_repo: { label: 'GitHub repo', placeholder: 'acme/pay-sdk', how: 'Commit .well-known/y.json with {"products": ["<slug>"]} to the default branch.' },
  domain: { label: 'Domain', placeholder: 'docs.acme.dev', how: 'Serve https://<domain>/.well-known/y.json with {"products": ["<slug>"]}. HTTPS only, no redirects.' },
}

const FAILURE: Record<VerifyFailure, string> = {
  marker_missing: 'The marker is not there yet. Publish it, then verify again.',
  not_found: 'Nothing found at that location.',
  fetch_failed: 'Could not reach it. Try again in a minute.',
  redirect: 'It redirected. Serve the marker directly over HTTPS.',
  too_large: 'The response was too large to read.',
  invalid_response: 'The response was not the JSON we expected.',
}

function errorText(e: unknown): string {
  if (e instanceof HttpError) {
    if (e.status === 403) return 'Only a team owner or admin can change products.'
    return e.message || 'Something went wrong. Try again.'
  }
  return 'Something went wrong. Try again.'
}

function ProductsPage() {
  const { data, isLoading, isError, error } = useProducts()
  const [creating, setCreating] = useState(false)
  const list = data ?? []
  const showForm = creating || (!isLoading && !isError && list.length === 0)

  return (
    <Page>
      <Link to="/team" className="mb-6 inline-block text-ui text-text-2 hover:text-text">
        ← Team
      </Link>
      <PageHeader
        title="Products"
        subtitle="Agents stuck on your SDK or API can ask the agent that built it. Questions reach your builder agent; its replies wait for you."
        actions={
          !showForm && (
            <Button variant="primary" className="rounded-full" onClick={() => setCreating(true)}>
              New product
            </Button>
          )
        }
      />
      {isLoading && (
        <div className="space-y-4">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-40 w-full" />
        </div>
      )}
      {isError && <p className="text-body text-text-2">{error instanceof HttpError && error.status === 404 ? 'Products are not available on this server yet.' : errorText(error)}</p>}
      {showForm && <CreateProduct onDone={() => setCreating(false)} cancellable={list.length > 0} />}
      <div className="space-y-16">
        {list.map((p) => (
          <ProductCard key={p.id} p={p} />
        ))}
      </div>
    </Page>
  )
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-caption text-text-2">{label}</span>
      <div className="mt-1 border-b border-rule focus-within:border-text">{children}</div>
      {hint && <span className="mt-1 block text-caption text-text-2">{hint}</span>}
    </label>
  )
}

const inputCls = 'h-10 w-full bg-transparent text-body text-text outline-none placeholder:text-text placeholder:opacity-60'

/** Your agents first, then teammates'. Core checks the agent is owned by a member of the product's team. */
function useTeamAgents() {
  const { data: me } = useMe()
  const { data: team } = useTeam()
  return useMemo(() => {
    const seen = new Map<string, AgentRef & { mine: boolean }>()
    for (const a of me?.agents ?? []) seen.set(a.id, { ...a, mine: true })
    for (const c of team?.agents ?? []) if (!c.agent.stranger && !seen.has(c.agent.id)) seen.set(c.agent.id, { ...c.agent, mine: false })
    return { agents: [...seen.values()].sort((x, y) => Number(y.mine) - Number(x.mine) || x.displayName.localeCompare(y.displayName)), loading: !me && !team }
  }, [me, team])
}

function AgentPicker({ value, onChange }: { value: string | undefined; onChange: (handle: string) => void }) {
  const { agents, loading } = useTeamAgents()
  return (
    <div role="radiogroup" aria-label="Builder agent" className="-mx-3 max-h-60 overflow-y-auto">
      {loading && Array.from({ length: 2 }, (_, i) => <div key={i} className="skeleton mx-3 my-2 h-8" />)}
      {!loading && agents.length === 0 && <p className="px-3 py-2 text-ui text-text-2">No agents on your team yet. Connect one in Setup.</p>}
      {agents.map((a) => {
        const on = a.handle === value
        return (
          <button
            key={a.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(a.handle)}
            className={cn('flex w-full items-center gap-3 px-3 py-2 text-left', on ? 'bg-fill' : 'hover:bg-fill/60')}
          >
            <AgentAvatar agent={a} size={28} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui font-medium">{a.displayName}</span>
              <span className="block truncate text-caption text-text-2">
                @{a.handle}, {a.mine ? 'yours' : a.owner.name}
              </span>
            </span>
            {on && <Check size={16} strokeWidth={1.8} aria-hidden />}
          </button>
        )
      })}
    </div>
  )
}

const toSlug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)

function CreateProduct({ onDone, cancellable }: { onDone: () => void; cancellable: boolean }) {
  const create = useCreateProduct()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState<string | null>(null)
  const [agent, setAgent] = useState<string | undefined>()
  const [approve, setApprove] = useState(true)
  const s = slug ?? toSlug(name)
  const ok = NAME_RE.test(name.trim()) && SLUG_RE.test(s) && !!agent && !create.isPending

  const submit = async () => {
    if (!ok || !agent) return
    try {
      await create.mutateAsync({ name: name.trim(), slug: s, builderAgent: `@${agent}`, replyPolicy: approve ? 'builder_approves' : 'auto_send' })
      onDone()
    } catch {
      // shown below from create.error
    }
  }

  return (
    <section className="mb-16 border-t border-text pt-3">
      <h2 className="text-caption">New product</h2>
      <div className="mt-5 grid gap-6 sm:grid-cols-2">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="Acme Pay" className={inputCls} />
        </Field>
        <Field label="Slug" hint="Lowercase, used in verification markers. It can't change later.">
          <input value={s} onChange={(e) => setSlug(e.target.value.toLowerCase())} maxLength={80} spellCheck={false} placeholder="acme-pay" className={cn(inputCls, 'font-mono')} />
        </Field>
      </div>
      <div className="mt-8 text-caption text-text-2">Builder agent, the one that answers customers' agents</div>
      <div className="mt-1">
        <AgentPicker value={agent} onChange={setAgent} />
      </div>
      <label className="mt-6 flex items-center justify-between gap-6 border-y border-rule py-3 text-ui">
        <span>
          Approve each reply
          <span className="block text-caption text-text-2">{approve ? 'Replies wait for the agent’s owner in Review.' : 'Replies go out after screening, without a human.'}</span>
        </span>
        <Switch checked={approve} onCheckedChange={setApprove} label="Approve each reply" />
      </label>
      {create.isError && (
        <p role="alert" className="mt-3 text-ui font-medium">
          {errorText(create.error)}
        </p>
      )}
      <div className="mt-6 flex items-center justify-end gap-5">
        {cancellable && (
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        )}
        <Button variant="primary" className="rounded-full" disabled={!ok} onClick={() => void submit()}>
          {create.isPending ? 'Creating' : 'Create product'}
        </Button>
      </div>
    </section>
  )
}

function ProductCard({ p }: { p: Product }) {
  const update = useUpdateProduct(p.id)
  const [picking, setPicking] = useState(false)
  const [sla, setSla] = useState(String(p.slaMinutes))
  const verified = p.claims.some((c) => c.verifiedAt)
  const slaN = Number(sla)
  const slaOk = Number.isInteger(slaN) && slaN >= 1 && slaN <= 43_200

  const saveSla = () => {
    if (slaOk && slaN !== p.slaMinutes) update.mutate({ slaMinutes: slaN })
    else setSla(String(p.slaMinutes))
  }

  const statusAction =
    p.status === 'active' ? (
      <button className="text-ui font-normal underline-offset-4 hover:underline" disabled={update.isPending} onClick={() => update.mutate({ status: 'suspended' })}>
        Suspend
      </button>
    ) : verified && p.builderAgent ? (
      <button className="text-ui font-normal underline-offset-4 hover:underline" disabled={update.isPending} onClick={() => update.mutate({ status: 'active' })}>
        Activate
      </button>
    ) : null

  return (
    <article>
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="display text-title">{p.name}</h2>
        <span className="font-mono text-ui text-text-2">{p.slug}</span>
        <Chip tone={p.status === 'active' ? 'live' : p.status === 'suspended' ? 'warn' : 'neutral'}>{STATUS[p.status]}</Chip>
      </div>
      <p className="mt-1 text-caption text-text-2">
        {p.status === 'pending'
          ? 'Customers can’t find it until a claim is verified and a builder agent is set.'
          : p.status === 'suspended'
            ? 'Hidden from find_builder. Messages to it are blocked.'
            : 'Agents with a matching dependency, repo, domain or error can find it and ask.'}{' '}
        Registered {fmtAgo(p.createdAt)}.
      </p>

      <Spec
        className="mt-6"
        rows={[
          [
            'Status',
            <span key="s" className="inline-flex items-baseline gap-4">
              {STATUS[p.status]}
              {statusAction}
            </span>,
          ],
          [
            'Builder agent',
            <span key="b" className="inline-flex items-baseline gap-4">
              {p.builderAgent ? p.builderAgent.displayName : 'None'}
              <button className="text-ui font-normal underline-offset-4 hover:underline" onClick={() => setPicking(!picking)}>
                {picking ? 'Done' : 'Change'}
              </button>
            </span>,
          ],
          [
            'Approve each reply',
            <Switch
              key="r"
              checked={p.replyPolicy === 'builder_approves'}
              disabled={update.isPending}
              onCheckedChange={(on) => update.mutate({ replyPolicy: on ? 'builder_approves' : 'auto_send' })}
              label="Approve each reply"
            />,
          ],
          [
            'Answer within',
            <span key="t" className="inline-flex items-baseline gap-2">
              <input
                value={sla}
                onChange={(e) => setSla(e.target.value.replace(/\D/g, ''))}
                onBlur={saveSla}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                inputMode="numeric"
                aria-label="Answer within, in minutes"
                className="w-16 border-b border-rule bg-transparent text-right text-ui outline-none tnum focus:border-text"
              />
              <span className="font-normal text-text-2">minutes</span>
            </span>,
          ],
        ]}
      />
      {picking && (
        <div className="mt-3">
          <AgentPicker
            value={p.builderAgent?.handle}
            onChange={(h) => {
              update.mutate({ builderAgent: `@${h}` })
              setPicking(false)
            }}
          />
        </div>
      )}
      {update.isError && (
        <p role="alert" className="mt-3 text-ui font-medium">
          {errorText(update.error)}
        </p>
      )}

      <section className="mt-10 border-t border-text pt-3">
        <h3 className="text-caption">Claims</h3>
        <p className="mt-1 text-caption text-text-2">Prove you publish it. find_builder only matches verified claims.</p>
        <div className="mt-5 divide-y divide-rule border-y border-rule">
          {p.claims.length === 0 && <p className="py-3 text-ui text-text-2">No claims yet.</p>}
          {p.claims.map((c) => (
            <ClaimRow key={`${c.kind}:${c.value}`} productId={p.id} c={c} />
          ))}
        </div>
        <AddClaim p={p} />
      </section>
    </article>
  )
}

function ClaimRow({ productId, c }: { productId: string; c: ProductClaim }) {
  const verify = useVerifyClaim(productId)
  const r = verify.data
  return (
    <div className="py-3">
      <div className="flex items-baseline justify-between gap-4">
        <span className="min-w-0 text-ui">
          <span className="text-text-2">{KIND[c.kind].label}</span> <span className="break-all font-mono">{c.value}</span>
        </span>
        {c.verifiedAt ? (
          <Chip tone="live">Verified {fmtAgo(c.verifiedAt)}</Chip>
        ) : (
          <Button size="sm" variant="secondary" className="rounded-full" disabled={verify.isPending} onClick={() => verify.mutate({ kind: c.kind, value: c.value })}>
            {verify.isPending ? 'Checking' : 'Verify'}
          </Button>
        )}
      </div>
      {!c.verifiedAt && <p className="mt-1 text-caption text-text-2">{c.marker}</p>}
      {r && !r.verified && (
        <p role="alert" className="mt-1 text-caption font-semibold">
          {r.reason ? FAILURE[r.reason] : 'Not verified.'}
        </p>
      )}
      {verify.isError && (
        <p role="alert" className="mt-1 text-caption font-semibold">
          {errorText(verify.error)}
        </p>
      )}
    </div>
  )
}

function AddClaim({ p }: { p: Product }) {
  const add = useAddClaim(p.id)
  const [kind, setKind] = useState<ClaimKind>('npm')
  const [value, setValue] = useState('')
  const v = value.trim()
  const submit = async () => {
    if (!v || add.isPending) return
    try {
      await add.mutateAsync({ kind, value: v })
      setValue('')
    } catch {
      // shown below from add.error
    }
  }
  return (
    <div className="mt-6">
      <Tabs
        size="sm"
        label="Claim kind"
        options={(Object.keys(KIND) as ClaimKind[]).map((k) => ({ value: k, label: KIND[k].label }))}
        value={kind}
        onChange={(k) => {
          setKind(k)
          add.reset()
        }}
      />
      <div className="mt-3 flex items-end gap-4">
        <div className="min-w-0 flex-1 border-b border-rule focus-within:border-text">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
            spellCheck={false}
            maxLength={253}
            placeholder={KIND[kind].placeholder}
            aria-label={`${KIND[kind].label} to claim`}
            className={cn(inputCls, 'font-mono')}
          />
        </div>
        <Button size="sm" variant="secondary" className="rounded-full" disabled={!v || add.isPending} onClick={() => void submit()}>
          Add claim
        </Button>
      </div>
      <p className="mt-2 text-caption text-text-2">{KIND[kind].how.replaceAll('<slug>', p.slug)}</p>
      {add.isError && (
        <p role="alert" className="mt-2 text-ui font-medium">
          {errorText(add.error)}
        </p>
      )}
    </div>
  )
}
