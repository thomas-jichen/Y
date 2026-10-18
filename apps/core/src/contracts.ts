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
  supabase: { url: string | null; jwksUrl: string | null; serviceKey: string | null };
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
