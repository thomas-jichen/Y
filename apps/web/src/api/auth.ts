import { useSyncExternalStore } from 'react'
import { API_BASE, DEMO_SECRET, MOCKS, SUPABASE } from '@/lib/env'
import { supabase } from './supabase'

/**
 * Who is signed in, and with what bearer token. Two ways in:
 * - dev/demo login: POST /dev/login {githubLogin} returns a core web token (pcl_web_…), kept in localStorage;
 * - GitHub via Supabase Auth: supabase-js owns the session; we read its access token (a Supabase JWT)
 *   and follow refreshes through onAuthStateChange.
 * Every request sends `Authorization: Bearer <token>` (see client.ts).
 */
export type AuthMethod = 'dev' | 'supabase'
export type AuthState = {
  status: 'loading' | 'signed_out' | 'signed_in'
  token?: string
  method?: AuthMethod
  /** Dev login name, kept so step-up can re-authenticate without asking again. */
  login?: string
  /** Set by a 401 STEP_UP_REQUIRED: the re-auth prompt is open. */
  stepUp: boolean
  /** Why the user is looking at the login screen (expired session, failed login). */
  notice?: string
}

const KEY = 'y-auth'
/** Stored as `login` for a demo-account session; never a valid GitHub login, so it can't collide. */
const DEMO_ACCOUNT = '#demo'
let state: AuthState = MOCKS ? { status: 'signed_in', token: 'mock', stepUp: false } : { status: 'loading', stepUp: false }
const subs = new Set<() => void>()

function set(patch: Partial<AuthState>) {
  state = { ...state, ...patch }
  subs.forEach((s) => s())
}

/**
 * Which sign-in the current token belongs to: the dev token itself, or the Supabase user id (its
 * access token changes on every refresh, the user doesn't). A request made under one key never
 * signs out, or retries under, another.
 */
let sessionKey: string | undefined
const supabaseKey = (session: { user?: { id?: string } | null } | null | undefined) => (session?.user?.id ? `sb:${session.user.id}` : 'sb:')

/**
 * Per-tab values that belong to one signed-in account: the agent install token minted on /connect
 * (routes/connect.tsx) and a pending Slack link token (routes/slack.link.tsx). The next account to
 * sign in to this tab must never see them.
 */
export const CONNECT_KEY = 'y-connect'
export const SLACK_LINK_KEY = 'y.slackLinkToken'
function clearTab(keys: string[]) {
  for (const k of keys) {
    try {
      sessionStorage.removeItem(k)
    } catch {
      /* storage unavailable */
    }
  }
}

function saveDev(token: string | null, login?: string) {
  try {
    if (token) localStorage.setItem(KEY, JSON.stringify({ token, login }))
    else localStorage.removeItem(KEY)
  } catch {
    /* private mode: the session lasts for this tab only */
  }
}

function loadDev(): { token: string; login?: string } | null {
  try {
    const raw = localStorage.getItem(KEY)
    const v = raw ? (JSON.parse(raw) as { token?: unknown; login?: unknown }) : null
    return v && typeof v.token === 'string' ? { token: v.token, login: typeof v.login === 'string' ? v.login : undefined } : null
  } catch {
    return null
  }
}

let started = false
let refreshing: Promise<string | null> | null = null
/** Restore a session (dev token or Supabase session). Safe to call more than once. */
export async function initAuth(): Promise<void> {
  if (MOCKS || started) return
  started = true
  const sb = supabase()
  if (sb) {
    try {
      const client = await sb
      client.auth.onAuthStateChange((event, session) => {
        if (session?.access_token) {
          const key = supabaseKey(session)
          // A different GitHub account in this tab: drop the previous one's minted install token.
          if (sessionKey && sessionKey !== key) clearTab([CONNECT_KEY])
          sessionKey = key
          set({ status: 'signed_in', token: session.access_token, method: 'supabase', stepUp: false, notice: undefined })
        } else if (event === 'SIGNED_OUT' && state.method === 'supabase') {
          sessionKey = undefined
          clearTab([CONNECT_KEY])
          set({ status: 'signed_out', token: undefined, method: undefined })
        }
      })
      const { data } = await client.auth.getSession()
      if (data.session?.access_token) {
        sessionKey = supabaseKey(data.session)
        set({ status: 'signed_in', token: data.session.access_token, method: 'supabase' })
        return
      }
    } catch {
      /* fall through to a dev token or the login screen */
    }
  }
  const dev = loadDev()
  if (dev) {
    sessionKey = dev.token
    set({ status: 'signed_in', token: dev.token, method: 'dev', login: dev.login })
  } else if (state.status === 'loading') set({ status: 'signed_out' })
}

export const auth = {
  get: () => state,
  token: () => state.token,

  async devLogin(githubLogin: string): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (DEMO_SECRET) headers['X-Demo-Secret'] = DEMO_SECRET
    let res: Response
    try {
      res = await fetch(`${API_BASE}/dev/login`, { method: 'POST', headers, body: JSON.stringify({ githubLogin }) })
    } catch {
      throw new Error('Could not reach the server')
    }
    if (res.status === 404) throw new Error('Dev login is turned off on this server')
    const body = (await res.json().catch(() => null)) as { token?: string; error?: { message?: string } } | null
    if (!res.ok || !body?.token) throw new Error(body?.error?.message ?? `Login failed (${res.status})`)
    saveDev(body.token, githubLogin)
    sessionKey = body.token
    set({ status: 'signed_in', token: body.token, method: 'dev', login: githubLogin, stepUp: false, notice: undefined })
  },

  /** Hosted demo: signs into the server's configured demo account (Y_DEMO_ACCOUNT). */
  async demoAccount(): Promise<void> {
    const headers: Record<string, string> = {}
    if (DEMO_SECRET) headers['X-Demo-Secret'] = DEMO_SECRET
    let res: Response
    try {
      res = await fetch(`${API_BASE}/dev/demo`, { method: 'POST', headers })
    } catch {
      throw new Error('Could not reach the server')
    }
    const body = (await res.json().catch(() => null)) as { token?: string; error?: { message?: string } } | null
    if (!res.ok || !body?.token) throw new Error(body?.error?.message ?? `Demo sign-in failed (${res.status})`)
    saveDev(body.token, DEMO_ACCOUNT)
    sessionKey = body.token
    set({ status: 'signed_in', token: body.token, method: 'dev', login: DEMO_ACCOUNT, stepUp: false, notice: undefined })
  },

  async githubLogin(): Promise<void> {
    const sb = supabase()
    if (!sb) throw new Error('GitHub sign-in is not configured')
    const client = await sb
    const { error } = await client.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: window.location.href } })
    if (error) throw new Error(error.message)
  },

  /** Which sign-in the current token belongs to (see `sessionKey`). */
  sessionKey: () => sessionKey,

  /** Drop the session. `notice` explains why on the login screen (e.g. an expired token). */
  async signOut(notice?: string): Promise<void> {
    const method = state.method
    saveDev(null)
    sessionKey = undefined
    clearTab([CONNECT_KEY, SLACK_LINK_KEY])
    set({ status: 'signed_out', token: undefined, method: undefined, stepUp: false, notice })
    if (method === 'supabase') await (await supabase())?.auth.signOut().catch(() => undefined)
  },

  /**
   * The session ended on its own (core said 401). Unlike the user's Sign out, this ends only this
   * browser's Supabase session (scope 'local'): other devices stay signed in. A pending Slack link
   * token stays so the visitor can sign in and finish linking.
   */
  async expire(notice?: string): Promise<void> {
    const method = state.method
    saveDev(null)
    sessionKey = undefined
    clearTab([CONNECT_KEY])
    set({ status: 'signed_out', token: undefined, method: undefined, stepUp: false, notice })
    if (method === 'supabase') await (await supabase())?.auth.signOut({ scope: 'local' }).catch(() => undefined)
  },

  /**
   * A request sent with `usedToken` under session `key` got a 401. Returns a token to retry with,
   * from the same sign-in only: one refreshed since the request left, or (Supabase) a fresh refresh.
   * Null means there is nothing to retry with.
   */
  async recover(key: string | undefined, usedToken: string | undefined): Promise<string | null> {
    if (!usedToken || !key || sessionKey !== key || state.status !== 'signed_in') return null
    if (state.token && state.token !== usedToken) return state.token
    if (state.method !== 'supabase') return null
    refreshing ??= (async () => {
      try {
        const { data } = (await (await supabase())?.auth.refreshSession()) ?? { data: null }
        return data?.session?.access_token && supabaseKey(data.session) === key ? data.session.access_token : null
      } catch {
        return null
      } finally {
        refreshing = null
      }
    })()
    const fresh = await refreshing
    if (!fresh || fresh === usedToken || sessionKey !== key) return null
    if (state.token !== fresh) set({ token: fresh })
    return fresh
  },

  /** Expire the session only if it is still the one the failed request was made under. */
  async expireIf(key: string | undefined, notice?: string): Promise<void> {
    if (sessionKey === key) await auth.expire(notice)
  },

  requestStepUp() {
    if (!state.stepUp) set({ stepUp: true })
  },
  cancelStepUp() {
    set({ stepUp: false })
  },

  /**
   * Re-authenticate for a fresh session (step-up). Dev: log in again with the same name.
   * Supabase: a new GitHub round trip (the page redirects and comes back here).
   */
  async reauthenticate(): Promise<void> {
    if (state.method === 'supabase') return auth.githubLogin()
    if (state.method === 'dev' && state.login === DEMO_ACCOUNT) return auth.demoAccount()
    if (state.method === 'dev' && state.login) return auth.devLogin(state.login)
    await auth.expire('Sign in again to continue')
  },
}

export const authConfig = { github: !!SUPABASE }

export function useAuth(): AuthState {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => state,
  )
}
