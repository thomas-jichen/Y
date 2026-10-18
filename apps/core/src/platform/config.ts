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

/** Default browser origins in development (the Vite dev server). */
export const DEV_WEB_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const production = env.NODE_ENV === 'production';
  const mode: CoreConfig['mode'] =
    env.PACELINE_MODE?.trim() === 'serverless' || (str(env.VERCEL) && env.PACELINE_MODE?.trim() !== 'server') ? 'serverless' : 'server';
  const port = Number(env.PORT ?? '') || 8787;
  const vercelUrl = str(env.VERCEL_PROJECT_PRODUCTION_URL) ?? str(env.VERCEL_URL);
  const publicUrl = (str(env.PUBLIC_URL) ?? (mode === 'serverless' && vercelUrl ? `https://${vercelUrl}` : `http://localhost:${port}`)).replace(/\/+$/, '');

  const supabaseUrl = str(env.SUPABASE_URL)?.replace(/\/+$/, '') ?? null;
  const jwksUrl = str(env.SUPABASE_JWKS_URL) ?? (supabaseUrl ? `${supabaseUrl}/auth/v1/.well-known/jwks.json` : null);
  const jwtSecret = str(env.SUPABASE_JWT_SECRET);
  const demoSecret = str(env.PACELINE_DEMO_SECRET);
  if (demoSecret && demoSecret.length < 16) throw new Error('PACELINE_DEMO_SECRET must be at least 16 characters');
  // Dev login: on locally without Supabase auth; in production only behind the demo secret.
  const devFlag = flag(env.PACELINE_DEV_AUTH);
  const devAuth = production ? (devFlag ?? true) && demoSecret !== null : (devFlag ?? (demoSecret !== null || (!jwksUrl && !jwtSecret)));
  if (production && devFlag === true && !demoSecret) throw new Error('PACELINE_DEV_AUTH cannot be enabled in production without PACELINE_DEMO_SECRET');

  const secret = (name: string): string => {
    const v = str(env[name]);
    if (v) return v;
    if (production) throw new Error(`${name} is required in production`);
    console.warn(`[paceline core] ${name} is unset; using a random per-process value (dev only)`);
    return randomBytes(32).toString('hex');
  };

  const cronSecret = str(env.PACELINE_CRON_SECRET);
  if (cronSecret && cronSecret.length < 16) throw new Error('PACELINE_CRON_SECRET must be at least 16 characters');
  if (production && mode === 'serverless' && !cronSecret) throw new Error('PACELINE_CRON_SECRET is required in serverless production (pg_cron tick)');

  const llm = env.PACELINE_LLM?.trim() === 'anthropic' ? 'anthropic' : 'mock';
  const emb = env.PACELINE_EMBEDDINGS?.trim();
  const embeddings = emb === 'gateway' ? 'gateway' : emb === 'gte' || emb === 'supabase' ? 'gte' : 'mock';
  const embed = { url: str(env.PACELINE_EMBED_URL) ?? supabaseUrl, secret: str(env.PACELINE_EMBED_SECRET) };
  if (embeddings === 'gte' && (!embed.url || !embed.secret)) {
    throw new Error('PACELINE_EMBEDDINGS=gte needs PACELINE_EMBED_URL (or SUPABASE_URL) and PACELINE_EMBED_SECRET');
  }

  const originsRaw = str(env.PACELINE_WEB_ORIGIN);
  const webOrigins = originsRaw
    ? originsRaw.split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean)
    : production
      ? []
      : DEV_WEB_ORIGINS;
  for (const o of webOrigins) {
    if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(o)) throw new Error(`PACELINE_WEB_ORIGIN entry is not an origin: ${o}`);
  }
  const rt = env.PACELINE_REALTIME_REST?.trim();
  const realtimeRest = rt === 'on' || rt === 'off' ? rt : 'auto';

  return {
    port,
    publicUrl,
    mode,
    internalSecret: secret('PACELINE_INTERNAL_SECRET'),
    hmacKey: secret('PACELINE_HMAC_KEY'),
    signingKeyPkcs8B64: str(env.PACELINE_SIGNING_KEY),
    llm,
    embeddings,
    anthropicApiKey: str(env.ANTHROPIC_API_KEY),
    devAuth,
    supabase: { url: supabaseUrl, jwksUrl, serviceKey: str(env.SUPABASE_SERVICE_ROLE_KEY), jwtSecret, publishableKey: str(env.SUPABASE_PUBLISHABLE_KEY) ?? str(env.SUPABASE_ANON_KEY) },
    production,
    cronSecret,
    demoSecret,
    webOrigins,
    embed,
    realtimeRest,
    mcpUrl: str(env.PACELINE_MCP_URL)?.replace(/\/+$/, '') ?? (production ? null : 'http://localhost:3000/mcp'),
    pluginMarketplace: str(env.PACELINE_PLUGIN_MARKETPLACE) ?? 'thomas-jichen/Y',
  };
}
