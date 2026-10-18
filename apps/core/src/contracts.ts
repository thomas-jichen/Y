/**
 * Shared seams inside apps/core. FROZEN for the parallel build: platform/ (jobs, bus, auth, ingest,
 * web API) and messaging/ + internal-mcp/ (DMs, pulse, MCP tool handlers) both code against these.
 * Change only with both owners in the loop.
 */
import type { Db, Tx, AuthClaims } from '@paceline/db';
import type { Hono } from 'hono';

/** Runtime configuration (see .env.example). */
export interface CoreConfig {
  port: number;
  publicUrl: string;
  /** 'server' = long-running Node with in-process job loop + push bus; 'serverless' = Vercel (jobs via tick). */
  mode: 'server' | 'serverless';
  internalSecret: string;
  hmacKey: string;
  /** Ed25519 PKCS8 private key, base64. Generated per process in dev when unset. */
  signingKeyPkcs8B64: string | null;
  llm: 'mock' | 'anthropic';
  embeddings: 'mock' | 'gte' | 'gateway';
  anthropicApiKey: string | null;
  /** Dev-only login (POST /api/v1/dev/login) when no Supabase auth is configured. */
  devAuth: boolean;
  supabase: {
    url: string | null;
    jwksUrl: string | null;
    serviceKey: string | null;
    /** HS256 fallback for projects on the legacy JWT secret (SUPABASE_JWT_SECRET). */
    jwtSecret?: string | null;
    /** Publishable (anon) key handed to browsers and listeners for Realtime (SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY). */
    publishableKey?: string | null;
  };
  /** NODE_ENV=production. */
  production?: boolean;
  /** PACELINE_CRON_SECRET: Bearer for POST /internal/jobs/tick (pg_cron via pg_net). Null = tick disabled. */
  cronSecret?: string | null;
  /** PACELINE_DEMO_SECRET: when set, /api/v1/dev/* needs a matching X-Demo-Secret header (hosted demo). */
  demoSecret?: string | null;
  /** PACELINE_WEB_ORIGIN (comma list): CORS + Origin check for browser callers. */
  webOrigins?: string[];
  /** gte embedder (PACELINE_EMBEDDINGS=gte): PACELINE_EMBED_URL (or SUPABASE_URL) + PACELINE_EMBED_SECRET. */
  embed?: { url: string | null; secret: string | null };
  /** Fan events out through Supabase Realtime REST from core: 'auto' = only when the DB has no realtime.send(). */
  realtimeRest?: 'auto' | 'on' | 'off';
  /** PACELINE_MCP_URL: the public MCP endpoint written into install commands (dev default http://localhost:3000/mcp). */
  mcpUrl?: string | null;
  /** PACELINE_PLUGIN_MARKETPLACE: the Claude Code marketplace (GitHub owner/repo) the plugin installs from. */
  pluginMarketplace?: string;
}

/** The authenticated caller of a request. */
export interface Caller {
  userId: string;
  /** Present for agent credentials (install tokens) and agent-scoped OAuth. */
  agentId: string | null;
  installId: string | null;
  via: 'install' | 'oauth' | 'web' | 'dev';
  /** Claims to pass to db.asUser for RLS. */
  claims: AuthClaims;
  /**
   * Web sessions: when the human last authenticated (unix seconds), for step-up (I5).
   * Dev sessions: web_sessions.created_at; Supabase: the latest `amr` timestamp. Null = unknown (fails step-up).
   */
  authTime?: number | null;
}

export interface AuthService {
  /** Verify `Authorization: Bearer <token>` (install token `pcl_agt_…`, web session, or Supabase JWT). Null if absent/invalid. */
  verifyBearer(authorizationHeader: string | undefined): Promise<Caller | null>;
  /** Verify the apps/mcp → core HMAC header (X-Paceline-Internal) over method+path+body. */
  verifyInternal(req: { method: string; path: string; body: string; header: (name: string) => string | undefined }): boolean;
}

/** A push event. Payload must carry ids/counts/pointer templates only (invariant I3). */
export interface PushEvent {
  id?: string;
  type: string;
  audienceAgentIds: string[];
  audienceUserIds: string[];
  payload: Record<string, unknown>;
}

export interface PushBus {
  /** Persist to `events` (which NOTIFYs) and fan out to in-process waiters. */
  publish(event: PushEvent, tx?: Tx): Promise<void>;
  /** Long-poll helper: resolves with events for this agent after `cursor`, or [] after timeoutMs. */
  waitForAgent(agentId: string, cursor: string | null, timeoutMs: number): Promise<{ events: PushEvent[]; cursor: string | null }>;
  /** Server-sent events for a web user (local/server mode). */
  subscribeUser(userId: string, onEvent: (e: PushEvent) => void): () => void;
}

export type JobHandler = (payload: Record<string, unknown>, deps: CoreDeps) => Promise<void>;

export interface JobQueue {
  /** Enqueue a job (dedupeKey makes it idempotent). Usable inside a caller's transaction. */
  enqueue(topic: string, payload: Record<string, unknown>, opts?: { dedupeKey?: string; runAfterMs?: number; tx?: Tx }): Promise<void>;
  /** Claim and run up to n due jobs once (used by the in-process loop and by /internal/jobs/tick). */
  drain(n?: number): Promise<number>;
}

export interface Embedder {
  readonly dims: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface CoreDeps {
  config: CoreConfig;
  db: Db;
  auth: AuthService;
  bus: PushBus;
  jobs: JobQueue;
  embedder: Embedder;
  now: () => Date;
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
}

export type App = Hono;

/** Each module contributes routes and job handlers through this shape. */
export interface CoreModule {
  register(app: App, deps: CoreDeps): void;
  jobs: Record<string, JobHandler>;
}
