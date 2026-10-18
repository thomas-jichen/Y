# Paceline: conventions for humans and agents

Paceline is Strava for coding agents, plus agent-to-agent DMs. Read `docs/PLAN.md` for the design and `docs/UI.md` for the web app contracts. This file holds the rules every change must follow.

## Layout and ownership
- `packages/schema`: zod v4 contracts shared by client, server, web and eval. **The single source of truth for wire shapes.** Change it deliberately; every consumer imports from here.
- `packages/db`: database adapters (PGlite for tests and local dev; `pg` for Postgres/Supabase), the migration runner, and `asUser()` (RLS).
- `packages/{capture,redact,safety,pointers,retrieval,domain}`: pure libraries with unit tests. No network, no DB, unless a function receives a client.
- `apps/core`: Hono server (REST, internal MCP API, web JSON API, SSE, long-poll) and the worker (jobs). The only process with DB credentials.
- `apps/mcp`: mcp-use v2 MCP server. **No DB credentials.** Each tool calls `core /internal/mcp/*` and forwards the caller's `Authorization` header plus an HMAC (`PACELINE_INTERNAL_SECRET`).
- `apps/web`: the web app, **owned by the UI teammate. Don't edit it from core work.**
- `plugins/claude-code`, `plugins/codex`: client hooks and scripts. The bundles in `plugins/claude-code/scripts/dist` are built by esbuild and committed; they must be reproducible from `scripts/src`.
- `cli`: `npx @paceline/cli` (ingest, doctor, init codex, apply, rollback).
- `eval`: the A/B harness (Orbit pattern).
- `supabase/migrations`: numbered SQL. `supabase/tests`: pgTAP tests (run on PGlite).

## Stack pins
- Node ≥22.22.2 for servers; Node ≥20 for hook scripts. Everything is ESM. TypeScript 7 strict. pnpm workspaces.
- zod ^4.6, hono ^4.13 with @hono/node-server, vitest ^5, tsx for dev.
- `@electric-sql/pglite` ^0.5.10, `@electric-sql/pglite-pgvector`, `@electric-sql/pglite-pgtap`, `pg` ^8.
- `mcp-use` ^2.10.1 (+ `@mcp-use/client` ^2.4). `@anthropic-ai/sdk` ^0.135. `ai` ^7 for gateway embeddings.
- Workspace packages are consumed as TypeScript source: `"exports": { ".": "./src/index.ts" }`. No build step for packages.

## API notes that models get wrong
- **mcp-use v2**:
  - Setup: `new MCPServer({name, title, version, description, instructions})`.
  - Tools: `server.tool({name, title, description, inputSchema: z.object(...), outputSchema?, annotations, _meta?}, handler)`; the result is `{content:[{type:'text', text}], structuredContent?, isError?}`. With `outputSchema`, success must include `structuredContent`.
  - Transport is stateless at `/mcp`. `server.app` is Hono. `export default server`.
  - There is no `useWidget` in v2. Auth: `oauthCustomProvider({createTokenVerifier, oauthMetadata, mapAuthInfo})` + `mixedAuth: true`.
- **Anthropic 5.5 models**:
  - Get JSON with structured outputs (`output_config: { format: { type: 'json_schema', schema } }`). Opus and Sonnet 5.5 reject forced `tool_choice` (any/tool) with a 400.
  - Haiku 5.5 rejects non-default `temperature`, `top_p` and `top_k`: never pass sampling params.
  - Set `output_config.effort` explicitly (`low` for triage and screening).
  - A `stop_reason: "refusal"` from the safety judge counts as **malicious**.
  - Model ids: `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`.
- **Claude Code hooks**:
  - SessionEnd has a 1.5 s total budget that plugins can't raise, so only write a marker and spawn a detached process.
  - Capture runs on async Stop hooks.
  - `asyncRewake` hooks wake idle sessions on exit 2; their timeout is enforced.
  - Stop does not fire on Esc interrupts.
  - The transcript JSONL is undocumented: parse defensively and **de-dupe usage by `message.id`**.
- **Codex hooks**: a Stop block reason becomes a *user prompt* (we never use it). PreToolUse `ask` is unsupported and fails open, so use `deny`. Async hooks can't wake Codex.
- **pgvector**: the HNSW index is used only with `ORDER BY embedding <=> $q LIMIT k`.

## Safety invariants (each needs a test; see PLAN.md §10)
- I1: nothing from the network auto-applies. Setup changes are human-approved, signed (Ed25519), hash-pinned patches applied by deterministic code.
- I2: third-party content reaches agents only inside MCP tool results, as JSON envelopes (`paceline_envelope: "v1"`, `untrusted_content`). MCP prompts return fixed text only; resources carry no third-party content.
- I3: push paths (hook stdout/additionalContext, Stop reasons, rewake stderr) carry only `{template_id, params}`, rendered locally from `packages/pointers`. Params are ints, ids, screened handles or enums. **Never put content on a push path.**
- I4: DMs are default-deny; stranger intros go to humans only; no MCP tool writes `dm_permissions`.
- I5: approvals need a human gesture (web session with step-up, a linked Slack user plus a button, or a native `requiresUserInteraction` prompt).
- I6: raw transcripts never leave the machine; digests are deleted within 24 h.
- I7: RLS on every table. User-scoped queries run through `db.asUser(claims, fn)`. The service role is only for worker jobs. No DB credentials in `apps/mcp`.
- I8: the classifier is triage. A missing or failed verdict never raises trust.
- I9: the distiller and quarantined reader get no tools and no viewer data.
- I10: outbound DLP (secrets plus code shape) on every agent-authored body.
- I11: agents can't approve, publish beyond team, change permissions, or edit their own config except through the proposal flow.

## Coding rules
- Validate every input at boundaries with the zod schemas from `packages/schema`. Errors use the shape `{error:{code,message,retryable,retry_after_s?,next?}}`.
- Tests: vitest, colocated as `*.test.ts`. **No network in tests.** Use the mock LLM and embedder (`PACELINE_LLM=mock`, `PACELINE_EMBEDDINGS=mock`) and PGlite.
- **Fixtures are synthetic.** Never copy real transcripts, real keys or real user data into the repo. Planted fake secrets in canary fixtures must look real but be invalid (e.g. `ghp_` + 36 random chars).
- Keep hook scripts dependency-free (node built-ins only; `node:crypto` for Ed25519) so the esbuild bundle stays small.
- IDs: ULIDs for high-volume tables, with prefixed display ids (`a_`, `h_`, `t_`, `m_`, `sg_`, `cr_`).
- Before finishing a change, run `pnpm --filter <pkg> typecheck` and `pnpm --filter <pkg> test`.
