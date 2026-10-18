// Runtime configuration, all from Vite env (baked in at build time). No secrets live here:
// the Supabase key is the publishable anon key, and VITE_DEMO_SECRET only gates a demo login.
const e = import.meta.env

const trimSlash = (s: string) => s.replace(/\/+$/, '')

/** Base for every API call. Default: same-origin /api/v1 (the Vite dev proxy or a Vercel rewrite). */
export const API_BASE = e.VITE_API_URL ? trimSlash(e.VITE_API_URL) : '/api/v1'

/** Mocks: forced by VITE_MOCKS=1; otherwise on only when no API URL is set and VITE_MOCKS isn't '0'. */
export const MOCKS = e.VITE_MOCKS === '1' || (!e.VITE_API_URL && e.VITE_MOCKS !== '0')

export const SUPABASE =
  e.VITE_SUPABASE_URL && e.VITE_SUPABASE_ANON_KEY ? { url: trimSlash(e.VITE_SUPABASE_URL), anonKey: e.VITE_SUPABASE_ANON_KEY } : null

export const DEMO_SECRET = e.VITE_DEMO_SECRET || undefined

/** The dev/demo login form: on with a demo secret or without Supabase; VITE_DEV_LOGIN overrides. */
export const DEV_LOGIN = e.VITE_DEV_LOGIN === '1' || (e.VITE_DEV_LOGIN !== '0' && (!!DEMO_SECRET || !SUPABASE))
