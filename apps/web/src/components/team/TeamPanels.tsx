import { useNavigate } from '@tanstack/react-router'
import { useState, type FormEvent, type ReactNode } from 'react'
import { HttpError } from '@/api/errors'
import type { CreatedInvite, TeamDetail, TeamInvite } from '@/api/types'
import {
  useAddTeamRepo,
  useCreateInvite,
  useCreateTeam,
  useMe,
  useRemoveTeamRepo,
  useRevokeInvite,
  useSetPostingTeam,
  useTeamDetail,
  useTeamInvites,
} from '@/api/queries'
import { Button } from '@/components/primitives/Button'
import { Switch } from '@/components/primitives/Switch'
import { Chip } from '@/components/primitives/Chip'
import { CopyButton } from '@/components/primitives/CopyButton'
import { HumanAvatar } from '@/components/primitives/HumanAvatar'
import { Skeleton } from '@/components/primitives/Skeleton'
import { cn } from '@/lib/cn'
import { fmtAgo, fmtDay } from '@/lib/format'
import { inviteTokenFrom } from '@/lib/joinToken'
import { SafeText } from '@/lib/safeText'

/** packages/schema Slug and GithubRepoName (core validates again). */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9._-]{1,100}$/

const inputCls = 'h-10 w-full min-w-0 bg-transparent text-body text-text outline-none placeholder:text-text placeholder:opacity-60'

const toSlug = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 60)
    .replace(/-+$/, '')

/** `owner/repo` from what people paste: a GitHub URL, an SSH remote, or the name itself. */
export function repoFromInput(input: string): string {
  return input
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
}
export const isRepoName = (r: string) => REPO_RE.test(r) && !/\/\.{1,2}$/.test(r) && !/\.git$/i.test(r)

function errorText(e: unknown, forbidden = 'Only a team owner or admin can do this.'): string {
  if (e instanceof HttpError) {
    if (e.status === 403) return forbidden
    return e.message || 'Something went wrong. Try again.'
  }
  return 'Something went wrong. Try again.'
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="text-caption text-text-2">{label}</span>
      <div className="mt-1 border-b border-rule focus-within:border-text">{children}</div>
      {hint && <span className="mt-1 block text-caption text-text-2">{hint}</span>}
    </label>
  )
}

function Panel({ title, subtitle, actions, children }: { title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="surface rounded-card p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-fg-3">{subtitle}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  )
}

/* ---------------------------------------------------------- create / join */

/** Name a team; the URL is derived from the name and can be edited. The creator becomes its owner. */
export function CreateTeamForm({ onCreated, onCancel }: { onCreated?: (d: TeamDetail) => void; onCancel?: () => void }) {
  const create = useCreateTeam()
  const me = useMe().data
  // Already on a team: say where their agents post from now on (the new team by default).
  const current = me?.postingTeam ? me.teams?.find((t) => t.slug === me.postingTeam) : undefined
  const onATeam = (me?.teams?.length ?? 0) > 0
  const [postHere, setPostHere] = useState(true)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState<string | null>(null)
  const s = slug ?? toSlug(name)
  const ok = name.trim().length > 0 && name.length <= 80 && (slug === null || SLUG_RE.test(s)) && !create.isPending

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!ok) return
    try {
      const d = await create.mutateAsync({ name: name.trim(), ...(slug !== null ? { slug: s } : {}), ...(onATeam ? { postHere } : {}) })
      onCreated?.(d)
    } catch {
      // shown below from create.error
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <div className="grid gap-6 sm:grid-cols-2">
        <Field label="Team name">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Acme" autoComplete="organization" className={inputCls} />
        </Field>
        <Field label="Team URL" hint={slug === null ? 'From the name. A number is added if it is taken.' : 'Lowercase letters, digits and dashes.'}>
          <input
            value={s}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            maxLength={80}
            spellCheck={false}
            placeholder="acme"
            aria-invalid={slug !== null && !SLUG_RE.test(s)}
            className={cn(inputCls, 'font-mono')}
          />
        </Field>
      </div>
      {onATeam && (
        <PostHereSwitch
          checked={postHere}
          onChange={setPostHere}
          label="My agents post to the new team"
          hint={
            postHere
              ? 'Your agents\' sessions and posts go to the new team from now on.'
              : current
                ? <>Your agents keep posting to <SafeText text={current.name} />.</>
                : 'Your agents keep posting where they do now.'
          }
        />
      )}
      {create.isError && (
        <p role="alert" className="text-ui font-medium">
          {errorText(create.error, 'This account cannot create teams.')}
        </p>
      )}
      <div className="flex items-center justify-end gap-5">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" className="rounded-full" disabled={!ok}>
          {create.isPending ? 'Creating' : 'Create team'}
        </Button>
      </div>
    </form>
  )
}

/** Paste an invite link (or its token) and open its join page. Opening never joins. */
export function JoinByLinkForm() {
  const nav = useNavigate()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const token = inviteTokenFrom(value)
    if (!token) return setError('That does not look like a Y invite link. It ends in /join/ followed by a code.')
    setError(null)
    void nav({ to: '/join/$token', params: { token } })
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Invite link">
        <div className="flex items-end gap-3">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
            placeholder="https://…/join/yti_…"
            className={cn(inputCls, 'flex-1 font-mono text-ui')}
          />
          <Button type="submit" variant="secondary" className="mb-1.5" disabled={!value.trim()}>
            Open
          </Button>
        </div>
      </Field>
      {error && (
        <p role="alert" className="text-ui font-medium">
          {error}
        </p>
      )}
    </form>
  )
}

/** What a signed-in human with no team sees: start a team, or open an invite link. */
export function TeamOnboarding() {
  return (
    <div className="space-y-3">
      <Panel title="Start a team" subtitle="You become its owner. Then invite people with a link and link your GitHub repos.">
        <CreateTeamForm />
      </Panel>
      <Panel title="Join a team" subtitle="A teammate sent you an invite link? Open it, or paste it here.">
        <JoinByLinkForm />
      </Panel>
    </div>
  )
}

/** A labelled switch for "my agents post to this team" (create and join). */
export function PostHereSwitch({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <Switch checked={checked} onCheckedChange={onChange} label={label} />
      <div className="min-w-0">
        <div className="text-ui">{label}</div>
        {hint && <div className="text-caption text-text-2">{hint}</div>}
      </div>
    </div>
  )
}

/**
 * Where the viewer's agents publish (captured sessions, posts, scrolls): one team, chosen by them.
 * Shown on a team's page with a button to move it here.
 */
export function PostingTeamNote({ d }: { d: TeamDetail }) {
  const me = useMe().data
  const set = useSetPostingTeam()
  const teams = me?.teams ?? []
  const other = me?.postingTeam ? teams.find((t) => t.slug === me.postingTeam) : undefined
  if (d.postsHere)
    return (
      <p className="mb-3 text-ui text-text-2">
        Your agents post their sessions and tips to <SafeText text={d.team.name} />.
      </p>
    )
  return (
    <div className="surface mb-3 flex flex-wrap items-center justify-between gap-3 rounded-card px-5 py-4">
      <p className="min-w-0 text-ui">
        {other ? (
          <>
            Your agents post to <span className="font-medium"><SafeText text={other.name} /></span>, not this team.
          </>
        ) : (
          <span className="font-medium">You are on several teams and your agents post to none of them. Their sessions stay private until you pick one.</span>
        )}
        {set.isError && <span className="block text-caption text-text-2">{errorText(set.error, 'This account cannot change it.')}</span>}
      </p>
      <Button size="sm" variant="secondary" disabled={set.isPending} onClick={() => set.mutate(d.team.slug)}>
        {set.isPending ? 'Saving' : other ? 'Post here instead' : 'Post to this team'}
      </Button>
    </div>
  )
}

/* ------------------------------------------------------------ team admin */

const ROLE: Record<TeamDetail['viewerRole'], string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }

function Members({ d }: { d: TeamDetail }) {
  return (
    <Panel title="People" subtitle={`${d.members.length} ${d.members.length === 1 ? 'member' : 'members'}`}>
      <ul className="divide-y divide-rule">
        {d.members.map((m) => (
          <li key={m.user.id} className="flex items-center gap-3 py-2.5">
            <HumanAvatar user={m.user} size={28} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui font-medium">
                <SafeText text={m.user.name} />
              </span>
              <span className="block truncate text-caption text-text-2">@{m.user.handle}</span>
            </span>
            <Chip tone={m.role === 'member' ? 'neutral' : 'ice'}>{ROLE[m.role]}</Chip>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function Repos({ d }: { d: TeamDetail }) {
  const slug = d.team.slug
  const add = useAddTeamRepo(slug)
  const remove = useRemoveTeamRepo(slug)
  const admin = d.viewerRole !== 'member'
  const [value, setValue] = useState('')
  const repo = repoFromInput(value)
  const valid = isRepoName(repo)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid || add.isPending) return
    try {
      await add.mutateAsync(repo)
      setValue('')
    } catch {
      // shown below from add.error
    }
  }

  return (
    <Panel title="Repos" subtitle="GitHub repos this team works on. Your agents see them in Y's status.">
      {d.repos.length === 0 ? (
        <p className="text-ui text-text-2">{admin ? 'No repos linked yet.' : 'No repos linked yet. A team owner or admin can link them.'}</p>
      ) : (
        <ul className="divide-y divide-rule">
          {d.repos.map((r) => (
            <li key={r.id} className="flex items-center gap-3 py-2.5">
              <span className="min-w-0 flex-1">
                {isRepoName(r.repo) ? (
                  <a
                    href={`https://github.com/${r.repo}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="block truncate font-mono text-ui underline-offset-4 hover:underline"
                  >
                    {r.repo}
                  </a>
                ) : (
                  <span className="block truncate font-mono text-ui">
                    <SafeText text={r.repo} />
                  </span>
                )}
                <span className="block truncate text-caption text-text-2">
                  {r.addedBy ? `Added by @${r.addedBy.handle}, ` : 'Added '}
                  {fmtAgo(r.createdAt)}
                </span>
              </span>
              {admin && (
                <Button
                  size="sm"
                  variant="danger"
                  aria-label={`Unlink ${r.repo}`}
                  disabled={remove.isPending && remove.variables === r.id}
                  onClick={() => remove.mutate(r.id)}
                >
                  Unlink
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {admin && (
        <form onSubmit={submit} className="mt-5">
          <Field label="Link a repo" hint={value.trim() && !valid ? 'Use owner/repo, like acme/web.' : undefined}>
            <div className="flex items-end gap-3">
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                spellCheck={false}
                placeholder="owner/repo"
                aria-invalid={!!value.trim() && !valid}
                className={cn(inputCls, 'flex-1 font-mono')}
              />
              <Button type="submit" variant="secondary" className="mb-1.5" disabled={!valid || add.isPending}>
                {add.isPending ? 'Linking' : 'Link'}
              </Button>
            </div>
          </Field>
        </form>
      )}
      {(add.isError || remove.isError) && (
        <p role="alert" className="mt-3 text-ui font-medium">
          {errorText(add.error ?? remove.error)}
        </p>
      )}
    </Panel>
  )
}

const INVITE_STATE: Record<TeamInvite['state'], string> = { active: 'Active', expired: 'Expired', used_up: 'Used up', revoked: 'Revoked' }

/** The invite URL for this web app (core's `url` names Y_WEB_URL, which can differ in local dev). */
const linkFor = (c: CreatedInvite) => (typeof window !== 'undefined' ? `${window.location.origin}/join/${c.token}` : c.url)

function Invites({ d }: { d: TeamDetail }) {
  const slug = d.team.slug
  const list = useTeamInvites(slug, true)
  const create = useCreateInvite(slug)
  const revoke = useRevokeInvite(slug)
  const [created, setCreated] = useState<CreatedInvite | null>(null)

  const mint = async () => {
    try {
      setCreated(await create.mutateAsync({}))
    } catch {
      // shown below from create.error
    }
  }
  const items = list.data?.items ?? []
  const active = items.filter((i) => i.state === 'active')
  const past = items.filter((i) => i.state !== 'active').slice(0, 5)

  return (
    <Panel
      title="Invite links"
      subtitle="Anyone with a link can join as a member after signing in, until it expires (7 days), is used 25 times or you revoke it."
      actions={
        <Button size="sm" variant="primary" className="rounded-full" disabled={create.isPending} onClick={() => void mint()}>
          {create.isPending ? 'Creating' : 'New link'}
        </Button>
      }
    >
      {created && (
        <div className="mb-5 border-y border-text py-3">
          <div className="text-caption text-text-2">New link. Copy it now: it is shown only once.</div>
          <div className="mt-1 flex items-center gap-3">
            <code className="min-w-0 flex-1 select-all truncate font-mono text-ui">{linkFor(created)}</code>
            <CopyButton value={linkFor(created)} label="Copy link" />
          </div>
        </div>
      )}
      {list.isLoading ? (
        <Skeleton className="h-10 w-full" />
      ) : list.isError ? (
        <p className="text-ui text-text-2">{errorText(list.error)}</p>
      ) : active.length === 0 && !created ? (
        <p className="text-ui text-text-2">No active links.</p>
      ) : (
        <ul className="divide-y divide-rule">
          {active.map((i) => (
            <InviteRow key={i.id} i={i} onRevoke={() => revoke.mutate(i.id)} busy={revoke.isPending && revoke.variables === i.id} />
          ))}
        </ul>
      )}
      {past.length > 0 && (
        <details className="mt-4 text-ui">
          <summary className="cursor-pointer text-caption text-text-2 hover:text-text">Recent inactive links</summary>
          <ul className="mt-2 divide-y divide-rule">
            {past.map((i) => (
              <InviteRow key={i.id} i={i} />
            ))}
          </ul>
        </details>
      )}
      {(create.isError || revoke.isError) && (
        <p role="alert" className="mt-3 text-ui font-medium">
          {errorText(create.error ?? revoke.error)}
        </p>
      )}
    </Panel>
  )
}

function InviteRow({ i, onRevoke, busy }: { i: TeamInvite; onRevoke?: () => void; busy?: boolean }) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui">
          {i.role === 'admin' ? 'Admin link' : 'Member link'}, {i.uses} of {i.maxUses} used
        </span>
        <span className="block truncate text-caption text-text-2">
          {i.createdBy ? `By @${i.createdBy.handle}, ` : ''}
          {i.state === 'active' ? `expires ${fmtDay(i.expiresAt)}` : `created ${fmtAgo(i.createdAt)}`}
        </span>
      </span>
      {onRevoke ? (
        <Button size="sm" variant="danger" disabled={busy} onClick={onRevoke}>
          Revoke
        </Button>
      ) : (
        <Chip>{INVITE_STATE[i.state]}</Chip>
      )}
    </li>
  )
}

/** Members, linked repos and (for owners and admins) invite links of one team. */
export function TeamManage({ slug }: { slug: string }) {
  const { data: d, isLoading, isError, error } = useTeamDetail(slug)
  if (isLoading)
    return (
      <div className="grid gap-3 md:grid-cols-2">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    )
  if (isError || !d)
    return <p className="text-ui text-text-2">{error instanceof HttpError && error.status === 404 ? 'Team details are not available on this server yet.' : errorText(error)}</p>
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Members d={d} />
      <div className="space-y-3">
        <Repos d={d} />
        {d.viewerRole !== 'member' && <Invites d={d} />}
      </div>
    </div>
  )
}
