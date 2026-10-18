/**
 * Request handling for the `embed` Edge Function, kept free of Deno and
 * Supabase globals (Web APIs only: Request, Response, crypto.subtle) so it
 * can be tested on any runtime. `index.ts` wires it to Supabase.ai.
 *
 * Contract (called by apps/core only, server to server):
 *
 *   POST /functions/v1/embed
 *   x-y-embed-secret: <Y_EMBED_SECRET>
 *   Content-Type: application/json
 *   {"input": "text" | ["text", ...]}            (1..32 inputs, 1..8000 chars each)
 *
 *   200 {"model": "gte-small", "dims": 384, "embeddings": [[...384 numbers], ...]}
 *       one L2-normalized, mean-pooled vector per input, in input order
 *   4xx/5xx {"error": {"code", "message", "retryable"}}   (packages/schema ErrorBody)
 *
 * Inputs are never logged or echoed: embedded text can be team-private.
 */

/** Model served by Supabase's built-in inference (`Supabase.ai.Session`). */
export const EMBEDDING_MODEL = 'gte-small';
/** gte-small output size; must match vector(384) columns and EMBEDDING_DIMS in packages/retrieval. */
export const EMBEDDING_DIMS = 384;
/** Header carrying the shared secret. A custom header, so the gateway's Authorization (if verify_jwt is on) stays free. */
export const SECRET_HEADER = 'x-y-embed-secret';

/** Embeds one text; returns the raw vector (normalization is requested from the model). */
export type EmbedFn = (text: string) => Promise<ArrayLike<number>>;

/** Options for {@link createEmbedHandler}. */
export interface EmbedHandlerOptions {
  /** Expected shared secret. When missing or shorter than 16 chars every request fails closed (500). */
  secret: string | undefined;
  /** The model call. */
  embed: EmbedFn;
  /** Expected vector length. Default {@link EMBEDDING_DIMS}. */
  dims?: number;
  /** Maximum inputs per request. Default 32. */
  maxInputs?: number;
  /** Maximum characters per input. Default 8000 (gte-small reads ~512 tokens; the rest is truncated by the model). */
  maxChars?: number;
  /** Maximum request body size in bytes. Default 512 KiB. */
  maxBodyBytes?: number;
}

type ErrorCode = 'UNAUTHORIZED' | 'VALIDATION' | 'INTERNAL';

const MIN_SECRET_LENGTH = 16;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function fail(status: number, code: ErrorCode, message: string, retryable = false): Response {
  return json(status, { error: { code, message, retryable } });
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** Constant-time comparison of two strings (compares fixed-length SHA-256 digests). */
export async function secretsEqual(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Validates the parsed body; returns the inputs or an error message. */
function parseInputs(body: unknown, maxInputs: number, maxChars: number): string[] | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'body must be a JSON object';
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'input') return 'body must be {"input": string | string[]}';
  const input = (body as { input: unknown }).input;
  const inputs = typeof input === 'string' ? [input] : input;
  if (!Array.isArray(inputs) || inputs.length === 0) return 'input must be a string or a non-empty array of strings';
  if (inputs.length > maxInputs) return `at most ${maxInputs} inputs per request`;
  for (const [i, text] of inputs.entries()) {
    if (typeof text !== 'string') return `input[${i}] must be a string`;
    if (text.length === 0 || text.length > maxChars) return `input[${i}] must be 1..${maxChars} characters`;
  }
  return inputs as string[];
}

/** Converts a model output to a plain array, checking its length and values. */
function toVector(raw: ArrayLike<number>, dims: number): number[] | null {
  if (raw === null || typeof raw !== 'object' || typeof raw.length !== 'number' || raw.length !== dims) return null;
  const out = Array.from(raw, Number);
  return out.every(Number.isFinite) ? out : null;
}

/**
 * Builds the fetch handler. POST only; authenticates with the shared secret
 * before reading the body; embeds inputs sequentially (one in-process model).
 */
export function createEmbedHandler(options: EmbedHandlerOptions): (req: Request) => Promise<Response> {
  const dims = options.dims ?? EMBEDDING_DIMS;
  const maxInputs = options.maxInputs ?? 32;
  const maxChars = options.maxChars ?? 8000;
  const maxBodyBytes = options.maxBodyBytes ?? 512 * 1024;
  const secret = options.secret;

  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') {
      return json(405, { error: { code: 'VALIDATION', message: 'use POST', retryable: false } }, { allow: 'POST' });
    }
    if (!secret || secret.length < MIN_SECRET_LENGTH) {
      return fail(500, 'INTERNAL', 'embed function is not configured (Y_EMBED_SECRET)');
    }
    const given = req.headers.get(SECRET_HEADER);
    if (given === null || !(await secretsEqual(given, secret))) {
      return fail(401, 'UNAUTHORIZED', `missing or invalid ${SECRET_HEADER}`);
    }

    const declared = Number(req.headers.get('content-length') ?? '0');
    if (declared > maxBodyBytes) return fail(413, 'VALIDATION', `body exceeds ${maxBodyBytes} bytes`);
    let text: string;
    try {
      text = await req.text();
    } catch {
      return fail(400, 'VALIDATION', 'could not read the request body');
    }
    if (new TextEncoder().encode(text).length > maxBodyBytes) {
      return fail(413, 'VALIDATION', `body exceeds ${maxBodyBytes} bytes`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return fail(400, 'VALIDATION', 'body must be JSON');
    }
    const inputs = parseInputs(body, maxInputs, maxChars);
    if (typeof inputs === 'string') return fail(400, 'VALIDATION', inputs);

    const embeddings: number[][] = [];
    for (const input of inputs) {
      let raw: ArrayLike<number>;
      try {
        raw = await options.embed(input);
      } catch {
        return fail(503, 'INTERNAL', 'embedding model failed', true);
      }
      const vector = toVector(raw, dims);
      if (!vector) return fail(500, 'INTERNAL', `model returned a vector that is not ${dims} finite numbers`);
      embeddings.push(vector);
    }
    return json(200, { model: EMBEDDING_MODEL, dims, embeddings });
  };
}
