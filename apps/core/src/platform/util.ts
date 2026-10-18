/** Small helpers shared by the platform module: hashing, tokens, digest sealing, HTTP errors. */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { ERROR_HTTP_STATUS, makeError, validationError, type ErrorCode, type ErrorOptions } from '@paceline/schema';
import type { z } from 'zod';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacHex(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

/** Constant-time comparison of two hex/ascii strings. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function randomBase62(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += BASE62[randomInt(62)];
  return out;
}

export const INSTALL_TOKEN_PREFIX = 'pcl_agt_';
export const WEB_TOKEN_PREFIX = 'pcl_web_';
export const PULSE_TOKEN_PREFIX = 'pcl_pls_';
export const STREAM_TOKEN_PREFIX = 'pcl_sst_';

export function mintInstallToken(): string {
  return INSTALL_TOKEN_PREFIX + randomBase62(32);
}
export function mintWebToken(): string {
  return WEB_TOKEN_PREFIX + randomBase62(32);
}

/**
 * Deterministic ULID for (session, segmentIndex): the time part is the session
 * start (+ segment index ms, so segments sort in order), the random part is a
 * hash of the pair. Makes activity creation idempotent across chunks.
 */
export function segmentUlid(sessionId: string, segmentIndex: number, sessionStartMs: number): string {
  let t = Math.max(0, Math.floor(sessionStartMs) + segmentIndex);
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const h = createHash('sha256').update(`${sessionId}:${segmentIndex}`).digest();
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[(h[i] ?? 0) & 31];
  return time + rand;
}

/** AES-256-GCM seal for temporary digests (activity_chunks.digest_enc). Layout: iv(12) | tag(16) | ciphertext. */
export function sealDigest(key: string, plaintext: string): Buffer {
  const k = createHash('sha256').update(`paceline-digest-v1\n${key}`).digest();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const body = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

export function openDigest(key: string, sealed: Uint8Array): string {
  const buf = Buffer.from(sealed);
  const k = createHash('sha256').update(`paceline-digest-v1\n${key}`).digest();
  const d = createDecipheriv('aes-256-gcm', k, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

/** Respond with the standard error shape. */
export function fail(c: Context, code: ErrorCode, message: string, opts?: ErrorOptions): Response {
  return c.json(makeError(code, message, opts), ERROR_HTTP_STATUS[code] as 400);
}

/** Parse a value with a zod schema, or produce a VALIDATION response. */
export function parseOr<T extends z.ZodType>(
  c: Context,
  schema: T,
  value: unknown,
): { ok: true; data: z.infer<T> } | { ok: false; res: Response } {
  const r = schema.safeParse(value);
  if (r.success) return { ok: true, data: r.data };
  return { ok: false, res: c.json(validationError(r.error), 400) };
}

export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return new Date(String(v)).toISOString();
}

export function isoOpt(v: unknown): string | undefined {
  return v === null || v === undefined ? undefined : iso(v);
}

export function num(v: unknown): number {
  const n = typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Strip a known wire prefix (`a_`, `h_`, `rv_`) and return the bare ULID, or null. */
export function bareId(prefix: string, id: string): string | null {
  const re = new RegExp(`^${prefix}_([0-9A-HJKMNP-TV-Z]{26})$`);
  const m = re.exec(id);
  return m?.[1] ?? null;
}

export function toVectorLiteral(vec: readonly number[]): string {
  return `[${vec.map((x) => (Number.isFinite(x) ? x.toFixed(6) : '0')).join(',')}]`;
}
