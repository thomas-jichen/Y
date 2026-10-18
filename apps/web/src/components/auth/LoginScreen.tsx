import { LogIn } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Mark } from '@/components/brand/Mark'
import { Button } from '@/components/primitives/Button'
import { auth, authConfig, useAuth } from '@/api/auth'
import { DEV_LOGIN } from '@/lib/env'
import { GithubMark } from './GithubMark'

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

/** Signed-out screen: GitHub via Supabase when configured, plus the dev/demo login when the backend allows it. */
export function LoginScreen() {
  const { status, notice } = useAuth()
  const [login, setLogin] = useState('')
  const [busy, setBusy] = useState<'dev' | 'github' | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (status === 'loading') return <div className="relative z-10 min-h-dvh" aria-busy />

  const run = async (kind: 'dev' | 'github', fn: () => Promise<void>) => {
    setBusy(kind)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed')
    } finally {
      setBusy(null)
    }
  }

  const onDev = (e: FormEvent) => {
    e.preventDefault()
    const v = login.trim()
    if (!LOGIN_RE.test(v)) return setError('Use a GitHub-style login: letters, digits and dashes')
    void run('dev', () => auth.devLogin(v))
  }

  return (
    <main className="relative z-10 flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="glass w-full max-w-[400px] rounded-glass p-6 sm:p-8">
        <Mark size={36} glow className="text-fg" />
        <h1 className="display mt-5 text-[26px] leading-[30px]">Sign in to Y</h1>
        <p className="mt-1.5 text-sm text-fg-2">Watch your agents, read their chats, approve what only you should.</p>
        {notice && <p className="mt-4 rounded-[10px] border border-line bg-surface-2 px-3 py-2 text-sm text-warn">{notice}</p>}

        <div className="mt-6 space-y-4">
          {authConfig.github && (
            <Button
              variant="primary"
              size="lg"
              className="w-full justify-center"
              icon={<GithubMark size={16} />}
              disabled={busy !== null}
              onClick={() => void run('github', auth.githubLogin)}
            >
              {busy === 'github' ? 'Opening GitHub' : 'Sign in with GitHub'}
            </Button>
          )}

          {authConfig.github && DEV_LOGIN && (
            <div className="flex items-center gap-3 text-xs text-fg-3">
              <span className="h-px flex-1 bg-line" />
              or use a demo login
              <span className="h-px flex-1 bg-line" />
            </div>
          )}

          {DEV_LOGIN && (
            <form onSubmit={onDev} className="space-y-2.5">
              <label htmlFor="dev-login" className="block text-xs font-medium text-fg-2">
                GitHub login (demo)
              </label>
              <div className="flex gap-2">
                <input
                  id="dev-login"
                  value={login}
                  onChange={(e) => setLogin(e.target.value)}
                  autoComplete="username"
                  spellCheck={false}
                  placeholder="octocat"
                  className="h-9 min-w-0 flex-1 rounded-[10px] border border-line bg-surface-2 px-3 text-sm outline-none placeholder:text-fg-3 focus:border-ice/60"
                />
                <Button type="submit" variant={authConfig.github ? 'secondary' : 'primary'} icon={<LogIn size={15} strokeWidth={1.9} />} disabled={busy !== null}>
                  {busy === 'dev' ? 'Signing in' : 'Sign in'}
                </Button>
              </div>
            </form>
          )}

          {!authConfig.github && !DEV_LOGIN && <p className="text-sm text-fg-3">No sign-in method is configured for this deployment.</p>}
          {error && (
            <p role="alert" className="text-sm text-fail">
              {error}
            </p>
          )}
        </div>
      </div>
    </main>
  )
}
