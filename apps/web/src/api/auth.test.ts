// Real-mode auth: which 401s sign out, with which Supabase scope, and what a sign-out leaves in the tab.
// No network: fetch and the Supabase client are fakes; storage is an in-memory stand-in.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Session = { access_token: string; user: { id: string } }
type Listener = (event: string, session: Session | null) => void

const sb = {
  listeners: [] as Listener[],
  session: null as Session | null,
  refreshed: null as Session | null,
  refreshSession: vi.fn(async () => ({ data: { session: sb.refreshed }, error: sb.refreshed ? null : { message: 'expired' } })),
  signOut: vi.fn(async (_opts?: { scope?: string }) => ({ error: null })),
  emit(event: string, session: Session | null) {
    for (const l of sb.listeners) l(event, session)
  },
}
const client = {
  auth: {
    onAuthStateChange: (cb: Listener) => {
      sb.listeners.push(cb)
      return { data: { subscription: { unsubscribe() {} } } }
    },
    getSession: async () => ({ data: { session: sb.session } }),
    refreshSession: () => sb.refreshSession(),
    signOut: (opts?: { scope?: string }) => sb.signOut(opts),
    signInWithOAuth: async () => ({ error: null }),
  },
}
vi.mock('./supabase', () => ({ supabase: () => Promise.resolve(client) }))

function memoryStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const UNAUTH = { error: { code: 'UNAUTHENTICATED', message: 'Sign in', retryable: false } }
/** fetch that accepts only `good` tokens; every call's bearer is recorded. */
function fakeCore(good: Set<string>) {
  const seen: (string | undefined)[] = []
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization?.replace(/^Bearer /, '')
    seen.push(auth)
    return auth && good.has(auth) ? json(200, { ok: true }) : json(401, UNAUTH)
  })
  return { fetch, seen }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

async function load() {
  vi.resetModules()
  const authMod = await import('./auth')
  const realMod = await import('./real')
  return { ...authMod, core: realMod.core }
}

beforeEach(() => {
  vi.stubEnv('VITE_MOCKS', '0')
  vi.stubEnv('VITE_API_URL', '')
  vi.stubEnv('VITE_SUPABASE_URL', 'https://sb.test.invalid')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-test-key')
  vi.stubGlobal('localStorage', memoryStorage())
  vi.stubGlobal('sessionStorage', memoryStorage())
  sb.listeners = []
  sb.session = null
  sb.refreshed = null
  sb.refreshSession.mockClear()
  sb.signOut.mockClear()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('401 handling (#54)', () => {
  it('a Supabase 401 refreshes once and retries instead of signing out everywhere', async () => {
    sb.session = { access_token: 'sb_old', user: { id: 'u1' } }
    sb.refreshed = { access_token: 'sb_new', user: { id: 'u1' } }
    const { auth, initAuth, core } = await load()
    await initAuth()
    const { fetch, seen } = fakeCore(new Set(['sb_new']))
    vi.stubGlobal('fetch', fetch)

    await expect(core('GET', '/me')).resolves.toEqual({ ok: true })
    expect(seen).toEqual(['sb_old', 'sb_new'])
    expect(sb.refreshSession).toHaveBeenCalledTimes(1)
    expect(sb.signOut).not.toHaveBeenCalled()
    expect(auth.get()).toMatchObject({ status: 'signed_in', token: 'sb_new', method: 'supabase' })
  })

  it('a 401 that a refresh cannot fix ends only this browser’s session (scope local)', async () => {
    sb.session = { access_token: 'sb_old', user: { id: 'u1' } }
    const { auth, initAuth, core } = await load()
    await initAuth()
    vi.stubGlobal('fetch', fakeCore(new Set()).fetch)

    await expect(core('GET', '/me')).rejects.toMatchObject({ status: 401 })
    await tick()
    expect(auth.get()).toMatchObject({ status: 'signed_out', notice: 'Your session ended. Sign in again.' })
    expect(sb.signOut).toHaveBeenCalledTimes(1)
    expect(sb.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('a 401 for a token refreshed while the request was in flight retries with the current token', async () => {
    sb.session = { access_token: 'sb_old', user: { id: 'u1' } }
    const { auth, initAuth, core } = await load()
    await initAuth()
    const seen: (string | undefined)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init?: RequestInit) => {
        const t = (init?.headers as Record<string, string>).Authorization.replace(/^Bearer /, '')
        seen.push(t)
        if (t === 'sb_old') {
          // supabase-js refreshes while this request is out
          sb.emit('TOKEN_REFRESHED', { access_token: 'sb_mid', user: { id: 'u1' } })
          return json(401, UNAUTH)
        }
        return json(200, { ok: true })
      }),
    )
    await expect(core('GET', '/feed')).resolves.toEqual({ ok: true })
    expect(seen).toEqual(['sb_old', 'sb_mid'])
    expect(sb.refreshSession).not.toHaveBeenCalled()
    expect(sb.signOut).not.toHaveBeenCalled()
    expect(auth.get().status).toBe('signed_in')
  })

  it('a late 401 from a previous sign-in never signs out the account now in the tab', async () => {
    const { auth, initAuth, core } = await load()
    sb.session = null
    await initAuth()
    let releaseA: (r: Response) => void = () => undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/dev/login')) {
          const login = JSON.parse(String(init?.body)).githubLogin
          return json(200, { token: `pcl_web_${login}` })
        }
        const t = (init?.headers as Record<string, string>).Authorization
        if (t === 'Bearer pcl_web_alice') return new Promise<Response>((r) => (releaseA = r))
        return json(200, { ok: true })
      }),
    )
    await auth.devLogin('alice')
    const late = core('GET', '/review')
    await auth.signOut()
    await auth.devLogin('bob')
    releaseA(json(401, UNAUTH))
    await expect(late).rejects.toMatchObject({ status: 401 })
    await tick()
    expect(auth.get()).toMatchObject({ status: 'signed_in', token: 'pcl_web_bob', login: 'bob' })
  })

  it('a dev token 401 still lands on the login screen with the notice', async () => {
    const { auth, initAuth, core } = await load()
    await initAuth()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url.endsWith('/dev/login') ? json(200, { token: 'pcl_web_dev' }) : json(401, UNAUTH))),
    )
    await auth.devLogin('dev')
    await expect(core('GET', '/me')).rejects.toMatchObject({ status: 401 })
    await tick()
    expect(auth.get()).toMatchObject({ status: 'signed_out', notice: 'Your session ended. Sign in again.' })
  })

  it('STEP_UP_REQUIRED still opens the step-up prompt and does not sign out', async () => {
    const { auth, initAuth, core } = await load()
    await initAuth()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/dev/login') ? json(200, { token: 'pcl_web_dev' }) : json(401, { error: { code: 'STEP_UP_REQUIRED', message: 'Re-auth', retryable: false } }),
      ),
    )
    await auth.devLogin('dev')
    await expect(core('POST', '/review/x/decision', {})).rejects.toMatchObject({ status: 401 })
    expect(auth.get()).toMatchObject({ status: 'signed_in', stepUp: true })
  })

  it('the Sign out menu item still ends the Supabase session as before', async () => {
    sb.session = { access_token: 'sb_old', user: { id: 'u1' } }
    const { auth, initAuth } = await load()
    await initAuth()
    await auth.signOut()
    expect(auth.get().status).toBe('signed_out')
    expect(sb.signOut).toHaveBeenCalledTimes(1)
    expect(sb.signOut.mock.calls[0]?.[0]).toBeUndefined()
  })
})

describe('per-account tab state (#55)', () => {
  const CONNECT = JSON.stringify({ tokens: { claudeCode: { token: 'pcl_agt_' + 'x'.repeat(32) } }, installed: false })

  it('sign-out drops the minted install token and a pending Slack link token', async () => {
    const { auth, initAuth, CONNECT_KEY, SLACK_LINK_KEY } = await load()
    await initAuth()
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { token: 'pcl_web_a' })))
    await auth.devLogin('alice')
    sessionStorage.setItem(CONNECT_KEY, CONNECT)
    sessionStorage.setItem(SLACK_LINK_KEY, 'slk_test')
    await auth.signOut()
    expect(sessionStorage.getItem(CONNECT_KEY)).toBeNull()
    expect(sessionStorage.getItem(SLACK_LINK_KEY)).toBeNull()
  })

  it('an expired session drops the install token but keeps a Slack link to finish after signing in', async () => {
    const { auth, initAuth, core, CONNECT_KEY, SLACK_LINK_KEY } = await load()
    await initAuth()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/dev/login') ? json(200, { token: 'pcl_web_a' }) : json(401, UNAUTH))))
    await auth.devLogin('alice')
    sessionStorage.setItem(CONNECT_KEY, CONNECT)
    sessionStorage.setItem(SLACK_LINK_KEY, 'slk_test')
    await expect(core('GET', '/me')).rejects.toMatchObject({ status: 401 })
    await tick()
    expect(sessionStorage.getItem(CONNECT_KEY)).toBeNull()
    expect(sessionStorage.getItem(SLACK_LINK_KEY)).toBe('slk_test')
  })

  it('a different GitHub account in the tab never sees the previous one’s token; a refresh keeps it', async () => {
    sb.session = { access_token: 'sb_a', user: { id: 'ua' } }
    const { initAuth, CONNECT_KEY, SLACK_LINK_KEY } = await load()
    await initAuth()
    sessionStorage.setItem(CONNECT_KEY, CONNECT)
    sessionStorage.setItem(SLACK_LINK_KEY, 'slk_test')
    sb.emit('TOKEN_REFRESHED', { access_token: 'sb_a2', user: { id: 'ua' } })
    expect(sessionStorage.getItem(CONNECT_KEY)).toBe(CONNECT)
    sb.emit('SIGNED_IN', { access_token: 'sb_b', user: { id: 'ub' } })
    expect(sessionStorage.getItem(CONNECT_KEY)).toBeNull()
    // The Slack link resume across the GitHub round trip is untouched.
    expect(sessionStorage.getItem(SLACK_LINK_KEY)).toBe('slk_test')
  })

  it('keeps the install token across reloads while the same account is signed in', async () => {
    const { auth, initAuth, CONNECT_KEY } = await load()
    await initAuth()
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { token: 'pcl_web_a' })))
    await auth.devLogin('alice')
    sessionStorage.setItem(CONNECT_KEY, CONNECT)
    // reload: a fresh module graph restores the dev session from localStorage
    const again = await load()
    await again.initAuth()
    expect(again.auth.get()).toMatchObject({ status: 'signed_in', token: 'pcl_web_a' })
    expect(sessionStorage.getItem(CONNECT_KEY)).toBe(CONNECT)
  })
})
