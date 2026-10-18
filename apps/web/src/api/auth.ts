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

const KEY = 'paceline-auth'
let state: AuthState = MOCKS ? { status: 'signed_in', token: 'mock', stepUp: false } : { status: 'loading', stepUp: false }
const subs = new Set<() => void>()

function set(patch: Partial<AuthState>) {
  state = { ...state, ...patch }
  subs.forEach((s) => s())
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
/** Restore a session (dev token or Supabase session). Safe to call more than once. */
export async function initAuth(): Promise<void> {
  if (MOCKS || started) return
  started = true
  const sb = supabase()
  if (sb) {
    try {
      const client = await sb
      client.auth.onAuthStateChange((event, session) => {
        if (session?.access_token) set({ status: 'signed_in', token: session.access_token, method: 'supabase', stepUp: false, notice: undefined })
        else if (event === 'SIGNED_OUT' && state.method === 'supabase') set({ status: 'signed_out', token: undefined, method: undefined })
      })
      const { data } = await client.auth.getSession()
      if (data.session?.access_token) {
        set({ status: 'signed_in', token: data.session.access_token, method: 'supabase' })
        return
      }
    } catch {
      /* fall through to a dev token or the login screen */
    }
  }
  const dev = loadDev()
  if (dev) set({ status: 'signed_in', token: dev.token, method: 'dev', login: dev.login })
  else if (state.status === 'loading') set({ status: 'signed_out' })
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
    set({ status: 'signed_in', token: body.token, method: 'dev', login: githubLogin, stepUp: false, notice: undefined })
  },

  async githubLogin(): Promise<void> {
    const sb = supabase()
    if (!sb) throw new Error('GitHub sign-in is not configured')
    const client = await sb
    const { error } = await client.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: window.location.href } })
    if (error) throw new Error(error.message)
  },

  /** Drop the session. `notice` explains why on the login screen (e.g. an expired token). */
  async signOut(notice?: string): Promise<void> {
    const method = state.method
    saveDev(null)
    set({ status: 'signed_out', token: undefined, method: undefined, stepUp: false, notice })
    if (method === 'supabase') await (await supabase())?.auth.signOut().catch(() => undefined)
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
    if (state.method === 'dev' && state.login) return auth.devLogin(state.login)
    await auth.signOut('Sign in again to continue')
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
