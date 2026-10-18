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
    env.Y_MODE?.trim() === 'serverless' || (str(env.VERCEL) && env.Y_MODE?.trim() !== 'server') ? 'serverless' : 'server';
  const port = Number(env.PORT ?? '') || 8787;
  const vercelUrl = str(env.VERCEL_PROJECT_PRODUCTION_URL) ?? str(env.VERCEL_URL);
  const publicUrl = (str(env.PUBLIC_URL) ?? (mode === 'serverless' && vercelUrl ? `https://${vercelUrl}` : `http://localhost:${port}`)).replace(/\/+$/, '');

  const supabaseUrl = str(env.SUPABASE_URL)?.replace(/\/+$/, '') ?? null;
  const jwksUrl = str(env.SUPABASE_JWKS_URL) ?? (supabaseUrl ? `${supabaseUrl}/auth/v1/.well-known/jwks.json` : null);
  const jwtSecret = str(env.SUPABASE_JWT_SECRET);
  const demoSecret = str(env.Y_DEMO_SECRET);
  if (demoSecret && demoSecret.length < 16) throw new Error('Y_DEMO_SECRET must be at least 16 characters');
  // Dev login: on locally without Supabase auth; in production only behind the demo secret.
  const devFlag = flag(env.Y_DEV_AUTH);
  const devAuth = production ? (devFlag ?? true) && demoSecret !== null : (devFlag ?? (demoSecret !== null || (!jwksUrl && !jwtSecret)));
  if (production && devFlag === true && !demoSecret) throw new Error('Y_DEV_AUTH cannot be enabled in production without Y_DEMO_SECRET');

  const secret = (name: string): string => {
    const v = str(env[name]);
    if (v) return v;
    if (production) throw new Error(`${name} is required in production`);
    console.warn(`[y core] ${name} is unset; using a random per-process value (dev only)`);
    return randomBytes(32).toString('hex');
  };

  const cronSecret = str(env.Y_CRON_SECRET);
  if (cronSecret && cronSecret.length < 16) throw new Error('Y_CRON_SECRET must be at least 16 characters');
  if (production && mode === 'serverless' && !cronSecret) throw new Error('Y_CRON_SECRET is required in serverless production (pg_cron tick)');

  const llm = env.Y_LLM?.trim() === 'anthropic' ? 'anthropic' : 'mock';
  const emb = env.Y_EMBEDDINGS?.trim().toLowerCase();
  const embeddings = emb === 'gateway' ? 'gateway' : emb === 'gte' || emb === 'supabase' ? 'gte' : 'mock';
  if (production && embeddings === 'mock' && emb !== 'mock') {
    console.warn(
      `[y core] Y_EMBEDDINGS is ${emb ? `'${emb}' (unknown)` : 'unset'} in production; using the mock embedder. Set Y_EMBEDDINGS=supabase (or mock explicitly).`,
    );
  }
  const embed = { url: str(env.Y_EMBED_URL) ?? supabaseUrl, secret: str(env.Y_EMBED_SECRET) };
  if (embeddings === 'gte' && (!embed.url || !embed.secret)) {
    throw new Error('Y_EMBEDDINGS=gte needs Y_EMBED_URL (or SUPABASE_URL) and Y_EMBED_SECRET');
  }

  const originsRaw = str(env.Y_WEB_ORIGIN);
  const webOrigins = originsRaw
    ? originsRaw.split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean)
    : production
      ? []
      : DEV_WEB_ORIGINS;
  for (const o of webOrigins) {
    if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(o)) throw new Error(`Y_WEB_ORIGIN entry is not an origin: ${o}`);
  }
  // Slack (PLAN §11): missing vars never throw; the integration is inert until both are set.
  let slackBot = str(env.SLACK_BOT_TOKEN);
  if (slackBot && !slackBot.startsWith('xoxb-')) {
    console.warn('[y core] SLACK_BOT_TOKEN is not a bot token (xoxb-); Slack stays off');
    slackBot = null;
  }
  const slackTeam = str(env.SLACK_TEAM_ID);
  if (slackTeam && !/^[A-Z0-9]{5,20}$/.test(slackTeam)) throw new Error('SLACK_TEAM_ID must look like T0123ABCD');
  const slack = {
    botToken: slackBot,
    signingSecret: str(env.SLACK_SIGNING_SECRET),
    teamId: slackTeam,
    webUrl: (str(env.Y_WEB_URL) ?? 'https://y-web-beta.vercel.app').replace(/\/+$/, ''),
  };
  const pv1 = str(env.Y_PULSE_V1_UNTIL);
  let pulseV1Until: number | undefined;
  if (pv1) {
    const n = pv1 === 'off' ? 0 : /^\d+$/.test(pv1) ? Number(pv1) : Math.floor(Date.parse(pv1) / 1000);
    if (!Number.isFinite(n)) throw new Error('Y_PULSE_V1_UNTIL must be unix seconds, an ISO date, or off');
    pulseV1Until = n;
  }
  const rt = env.Y_REALTIME_REST?.trim();
  const realtimeRest = rt === 'on' || rt === 'off' ? rt : 'auto';

  return {
    port,
    publicUrl,
    mode,
    internalSecret: secret('Y_INTERNAL_SECRET'),
    hmacKey: secret('Y_HMAC_KEY'),
    signingKeyPkcs8B64: str(env.Y_SIGNING_KEY),
    llm,
    embeddings,
    anthropicApiKey: str(env.ANTHROPIC_API_KEY),
    devAuth,
    supabase: { url: supabaseUrl, jwksUrl, serviceKey: str(env.SUPABASE_SERVICE_ROLE_KEY), jwtSecret, publishableKey: str(env.SUPABASE_PUBLISHABLE_KEY) ?? str(env.SUPABASE_ANON_KEY) },
    production,
    cronSecret,
    demoSecret,
    demoAccount: str(env.Y_DEMO_ACCOUNT),
    ...(pulseV1Until !== undefined ? { pulseV1Until } : {}),
    webOrigins,
    embed,
    realtimeRest,
    mcpUrl: str(env.Y_MCP_URL)?.replace(/\/+$/, '') ?? (production ? null : 'http://localhost:3000/mcp'),
    pluginMarketplace: str(env.Y_PLUGIN_MARKETPLACE) ?? 'thomas-jichen/Y',
    slack,
  };
}

/**
 * Addresses for the long-running server (main.ts) to listen on. HOST wins (e.g.
 * `0.0.0.0` in a container or for a phone on the LAN). Otherwise, while dev login
 * is on outside production, only loopback (IPv4 and IPv6): anyone who can reach a
 * dev core can sign in as any dev user. Null = all interfaces (the previous default).
 */
export function listenHosts(config: Pick<CoreConfig, 'devAuth' | 'production'>, env: NodeJS.ProcessEnv = process.env): string[] | null {
  const host = str(env.HOST);
  if (host) return [host];
  return config.devAuth && !config.production ? ['127.0.0.1', '::1'] : null;
}
