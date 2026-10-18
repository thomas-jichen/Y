/** Runtime configuration from the environment (see .env.example). */
import { randomBytes } from 'node:crypto';
import type { CoreConfig } from '../contracts.js';

function str(v: string | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

function flag(v: string | undefined): boolean | null {
  const t = v?.trim().toLowerCase();
  if (!t) return null;
  return t === '1' || t === 'true' || t === 'yes' || t === 'on';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const production = env.NODE_ENV === 'production';
  const port = Number(env.PORT ?? '') || 8787;
  const publicUrl = (str(env.PUBLIC_URL) ?? `http://localhost:${port}`).replace(/\/+$/, '');

  const supabaseUrl = str(env.SUPABASE_URL);
  const jwksUrl = str(env.SUPABASE_JWKS_URL) ?? (supabaseUrl ? `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/.well-known/jwks.json` : null);
  const devAuth = flag(env.PACELINE_DEV_AUTH) ?? (!production && !jwksUrl);
  if (devAuth && production) throw new Error('PACELINE_DEV_AUTH cannot be enabled in production');

  const secret = (name: string): string => {
    const v = str(env[name]);
    if (v) return v;
    if (production) throw new Error(`${name} is required in production`);
    console.warn(`[paceline core] ${name} is unset; using a random per-process value (dev only)`);
    return randomBytes(32).toString('hex');
  };

  const llm = env.PACELINE_LLM?.trim() === 'anthropic' ? 'anthropic' : 'mock';
  const emb = env.PACELINE_EMBEDDINGS?.trim();
  const embeddings = emb === 'gateway' ? 'gateway' : emb === 'gte' ? 'gte' : 'mock';

  return {
    port,
    publicUrl,
    // Serverless mode is cut for v0: always a long-running server with the in-process job loop.
    mode: 'server',
    internalSecret: secret('PACELINE_INTERNAL_SECRET'),
    hmacKey: secret('PACELINE_HMAC_KEY'),
    signingKeyPkcs8B64: str(env.PACELINE_SIGNING_KEY),
    llm,
    embeddings,
    anthropicApiKey: str(env.ANTHROPIC_API_KEY),
    devAuth,
    supabase: { url: supabaseUrl, jwksUrl, serviceKey: str(env.SUPABASE_SERVICE_ROLE_KEY) },
  };
}
