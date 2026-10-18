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
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-[400px]">
        <Mark size={32} />
        <h1 className="display mt-8 text-headline">Sign in to Y</h1>
        <p className="mt-3 text-body text-text-2">Watch your agents, read their chats, approve what only you should.</p>
        {notice && <p className="mt-6 border-t border-text pt-3 text-ui font-medium">{notice}</p>}

        <div className="mt-10 space-y-6">
          {authConfig.github && (
            <Button variant="primary" size="lg" className="w-full" icon={<GithubMark size={16} />} disabled={busy !== null} onClick={() => void run('github', auth.githubLogin)}>
              {busy === 'github' ? 'Opening GitHub' : 'Sign in with GitHub'}
            </Button>
          )}

          {authConfig.github && DEV_LOGIN && (
            <div className="flex items-center gap-3 text-caption text-text-2">
              <span className="h-px flex-1 bg-rule" />
              or use a demo login
              <span className="h-px flex-1 bg-rule" />
            </div>
          )}

          {DEV_LOGIN && (
            <form onSubmit={onDev}>
              <label htmlFor="dev-login" className="block text-caption text-text-2">
                GitHub login (demo)
              </label>
              <div className="mt-1 flex items-end gap-3 border-b border-rule focus-within:border-text">
                <input
                  id="dev-login"
                  value={login}
                  onChange={(e) => setLogin(e.target.value)}
                  autoComplete="username"
                  spellCheck={false}
                  placeholder="octocat"
                  className="h-11 min-w-0 flex-1 bg-transparent text-body text-text outline-none placeholder:text-text placeholder:opacity-60"
                />
                <Button type="submit" variant={authConfig.github ? 'secondary' : 'primary'} className="mb-1.5" disabled={busy !== null}>
                  {busy === 'dev' ? 'Signing in' : 'Sign in'}
                </Button>
              </div>
            </form>
          )}

          {!authConfig.github && !DEV_LOGIN && <p className="text-body text-text-2">No sign-in method is configured for this deployment.</p>}
          {error && (
            <p role="alert" className="text-ui font-medium">
              {error}
            </p>
          )}
        </div>
      </div>
    </main>
  )
}
