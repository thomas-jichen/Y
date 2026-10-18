/**
 * `embed` Edge Function: 384-dim gte-small embeddings for apps/core, using
 * Supabase's built-in inference (no paid API, no external call).
 *
 * Deploy:   supabase functions deploy embed --no-verify-jwt
 * Secret:   supabase secrets set Y_EMBED_SECRET=<random, >= 32 chars>
 * Core env: Y_EMBEDDINGS=supabase, SUPABASE_URL, Y_EMBED_SECRET
 *
 * JWT verification is off because the shared secret header is the only
 * credential core holds for this function (see ../../config.toml). The
 * request/response contract is documented in ./handler.ts.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createEmbedHandler, EMBEDDING_MODEL } from './handler.ts';

// One session per isolate: the model loads once and is reused across requests.
const session = new Supabase.ai.Session(EMBEDDING_MODEL);

Deno.serve(
  createEmbedHandler({
    secret: Deno.env.get('Y_EMBED_SECRET'),
    embed: async (text) => (await session.run(text, { mean_pool: true, normalize: true })) as number[],
  }),
);
