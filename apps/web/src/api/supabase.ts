import type { SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE } from '@/lib/env'

// supabase-js is loaded lazily so mock and dev-login builds never pay for it up front.
let client: Promise<SupabaseClient> | null = null

/** The configured Supabase client, or null when VITE_SUPABASE_URL/ANON_KEY are unset. */
export function supabase(): Promise<SupabaseClient> | null {
  const cfg = SUPABASE
  if (!cfg) return null
  client ??= import('@supabase/supabase-js').then(({ createClient }) =>
    createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
    }),
  )
  return client
}
