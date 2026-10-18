/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** '1' forces the in-browser mocks; '0' forces real mode. */
  readonly VITE_MOCKS?: string
  /** Core base URL including /api/v1 (e.g. https://core.example.app/api/v1). Unset = same-origin /api/v1. */
  readonly VITE_API_URL?: string
  readonly VITE_SUPABASE_URL?: string
  /** Publishable (anon) key only. Never a service key. */
  readonly VITE_SUPABASE_ANON_KEY?: string
  /** Sent as X-Demo-Secret on dev login (hosted demos). Not a real secret: it ships in the bundle. */
  readonly VITE_DEMO_SECRET?: string
  /** '1' shows the dev login form even when Supabase is configured; '0' hides it. */
  readonly VITE_DEV_LOGIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
