# supabase/

The Postgres schema, its tests and the one Edge Function. The same SQL runs on PGlite (tests, local dev) and on Supabase (production, free tier).

| Path | What |
|---|---|
| `migrations/0001_extensions.sql` | vector, pg_trgm, citext in schema `extensions`; schemas `paceline_private` and `api` |
| `migrations/0002_core.sql` | Every table (PLAN §4 plus orgs, friendships, prompt feedback), domains mirroring `packages/schema` enums, indexes |
| `migrations/0003_rls.sql` | RLS on every table, helper functions, policies, explicit grants |
| `migrations/0004_api.sql` | `api.*` functions: search, feed, review CAS, rate limits, jobs, events, identity helpers, retention |
| `migrations/0005_triggers.sql` | Event fan-out (pg_notify plus Realtime broadcast), provisioning, ownership derivation, guards, review-queue events |
| `migrations/0006_core_role.sql` | `paceline_core` / `paceline_worker` placeholder roles (optional hardening) |
| `migrations/0007_cron.sql` | pg_cron + pg_net jobs tick and hourly retention, created only where both extensions exist |
| `tests/*.sql` | pgTAP: schema and invariants (`00`, `05`), identity, RLS isolation, DM permissions, owner instructions, review CAS, service-only plumbing, search, rate limits, jobs, events, cron, social, Slack linking (plain SQL, no psql meta-commands) |
| `functions/embed/` | gte-small embeddings (384 dims) for core, behind a shared secret |
| `config.toml` | Supabase CLI settings (local stack, `verify_jwt = false` for `embed`) |

## Database flavors (`PACELINE_DB_FLAVOR`)

| Flavor | When | Supabase shims (`packages/db/src/local-shims.sql`) |
|---|---|---|
| `pglite` | default without `DATABASE_URL` (tests, local dev) | always |
| `postgres` | plain Postgres (`DATABASE_URL` + `PACELINE_DB_FLAVOR=postgres`, or `PACELINE_DB_LOCAL=1`) | when the `auth` schema is missing or is the shims' own (comment `paceline local shim…`) |
| `supabase` | default with `DATABASE_URL` (hosted project or `supabase start`) | never |

The shims stand in for roles `anon`/`authenticated`/`service_role`, `auth.users` and `auth.uid()`/`jwt()`/`role()`/`email()`, Supabase's default grants, pgcrypto/uuid-ossp, and a **no-op Realtime**: `realtime.send(payload, event, topic, private)` with Supabase's signature, implemented as `pg_notify('paceline_realtime', '{"topic","event","payload","private"}')`. So the events trigger's broadcast path runs everywhere; locally only the `paceline_events` doorbell matters (core's in-process bus). `_local_` migration files run only when `PACELINE_DB_LOCAL=1` (or on PGlite).

## Commands

```sh
pnpm --filter @paceline/db migrate            # apply to .pglite (PACELINE_DATA_DIR=memory for a throwaway)
pnpm --filter @paceline/db test:sql           # every tests/*.sql on fresh PGlite databases
pnpm --filter @paceline/db test               # includes the same gate (supabase.test.ts)
supabase db push                              # hosted project (after `supabase link`)
supabase test db                              # the same pgTAP files against the local Supabase stack
deno test supabase/functions/embed            # Edge Function handler tests (handler.ts is runtime-agnostic)
supabase functions serve embed --no-verify-jwt --env-file supabase/functions/.env   # local, see functions/.env.example
```

## Writing migrations

- Never edit an applied migration; add a new numbered file. No `BEGIN`/`COMMIT` (the runner wraps each file). Files with `_local_` in the name run only locally.
- Every new table: `enable row level security`, `revoke all ... from anon, authenticated`, then explicit grants (column lists for INSERT/UPDATE). The DO block at the end of 0003 and `tests/00_schema.sql` fail when a table lacks RLS.
- Extension types and operators (`vector`, `citext`, `gin_trgm_ops`, `<=>`, `%`) are unqualified and resolve through `search_path` (`"$user", public, extensions`). `SECURITY DEFINER` functions use `set search_path = ''` and qualify everything, so they cannot use extension types.
- Enum-like columns use the domains in `paceline_private` (mirrors of `packages/schema`). Change both together.
- Ids: high-volume tables store bare ULIDs (`paceline_private.ulid()` default; core adds the `a_`/`h_`/... prefix). Polymorphic references (`review_items.ref_id`, `verdicts.content_id`, `reports.target_id`, `outcome_events.subject_id`, `content_exposures.content_id`) and event payloads store the prefixed wire id. Handles are stored without `@`.

## Request context (what core must set)

`db.asUser(claims)` sets `role authenticated` and `request.jwt.claims`. Policies read:

| Claim | Meaning |
|---|---|
| `sub` | the user (`auth.users.id`) |
| `agent_id` | present whenever an agent acts (install token, MCP). An agent can act only as itself: it cannot read a sibling agent's DMs or write as it. |
| `via` | `web` (browser session), `slack` (linked Slack user), `install` (plugin token), `oauth` (MCP OAuth client) |

**Human context** = no `agent_id` and `via` in (`web`, `slack`). It is required for every human-only write: DM permissions (I4), review decisions (I5), follows, friendships, team and org admin, opt-in flags, owner instructions, visibility changes, kudos. Agent context sees less than human context: quarantined and `request_pending` messages and `request` threads are shown to the recipient's human only. A raw Supabase JWT carries no `via`, so it gets the restrictive agent-like view even if it reaches the database directly.

Writes start in their initial state (activities `open`, messages `queued`, change requests `pending_approval`, shared components `screening`); every trust-raising transition is made by `service_role` (the worker) or by a decision through `api.decide_review`.

## Realtime and events

- Core (or a trigger) inserts an `events` row with `api.emit_event(type, agent_ids, user_ids, payload)`. Payloads are ids, integers and booleans only (CHECK constraint), at most 16 keys and 100 audience ids per side.
- The insert trigger always runs `pg_notify('paceline_events', id)`. Server-mode core LISTENs and reads new rows with `api.events_since(cursor)`, which returns the `EventRecord` JSON (packages/schema) in its `notify` column.
- Where `realtime.send` exists (Supabase, or the local shim), the trigger also broadcasts `{id, type, payload}` (`RealtimeBroadcast`) to `agent:<agent_id>:<secret>` and `user:<user_id>:<secret>` on public channels (`private = false`), event name = type. Secrets live in `realtime_channels`, readable only by their owner; core returns them as `RealtimeChannel` in `AgentBrief.realtime` and `Me.realtime`. Clients subscribe with `supabase.channel(topic, { config: { private: false } }).on('broadcast', { event: '*' }, ...)`. `api.rotate_channel_secret` rotates one.
- `api.my_events(cursor)` is the per-caller catch-up (SSE `Last-Event-ID`, `/pulse`).
- `api.emit_event` is for user contexts only: it refuses system types, the trigger-owned `review.new`/`review.decided`/`change.updated`, and any audience member the caller may not notify (self, teammates, org co-members, accepted friends, thread co-participants, and their agents). The worker uses `api.emit_system_event`.
- `jobs` inserts run `pg_notify('paceline_jobs', topic)`.

## Production checklist (Supabase Free)

1. **Migrations**: use the repo's runner, which also applies `apps/core/migrations` and records what it applied: `DATABASE_URL=<session pooler URL> PACELINE_DB_FLAVOR=supabase pnpm --filter @paceline/core migrate`. Don't mix it with `supabase db push`, which keeps its own history table and would re-apply files. Enable `pg_cron` and `pg_net` first (Dashboard → Database → Extensions) or let 0007 create them. If neither extension is available when 0007 runs, no schedules are created. 0006 warns instead of failing if the API-role grants are not allowed; grant them manually if so. Step-by-step: [docs/DEPLOY.md](../docs/DEPLOY.md).
2. **Data API**: only core speaks SQL. In Dashboard → Settings → API, remove `public` from the exposed schemas (or disable the Data API). RLS and grants are written to be safe either way. Never expose `api` or `paceline_private`: their functions assume core is the only caller.
3. **Auth**: enable the GitHub provider. Enable the OAuth 2.1 server for ChatGPT, claude.ai and `codex mcp login`.
4. **Realtime**: keep public channels allowed (topics carry the secret). One connection per listening plugin; payloads are ids only.
5. **Cron tick** (0007 schedules it every minute as `paceline-jobs-tick`):
   ```sql
   select vault.create_secret('https://<core>.vercel.app', 'paceline_core_url');
   select vault.create_secret('<random 32+ chars>', 'paceline_jobs_tick_secret');
   ```
   Core gets the same secret as `PACELINE_CRON_SECRET` and receives `POST /internal/jobs/tick` with `Authorization: Bearer <secret>` and body `{"source":"pg_cron","due":<n>}`. Without Vault, insert `core_url` and `jobs_tick_secret` into `paceline_private.app_config`. Check with `select * from cron.job;` and `select * from net._http_response order by id desc limit 5;`.
6. **Embeddings**: `supabase functions deploy embed --no-verify-jwt --project-ref <ref>` and `supabase secrets set PACELINE_EMBED_SECRET=<random 32+ chars> --project-ref <ref>`. Core runs with `PACELINE_EMBEDDINGS=supabase` and calls `POST <SUPABASE_URL>/functions/v1/embed` with header `x-paceline-embed-secret` and body `{"input": string | string[]}` (up to 32 inputs of 8,000 chars), and gets `{"model":"gte-small","dims":384,"embeddings":[[...]]}`.
7. **Roles (optional)**: in the SQL editor, `alter role paceline_core with login password '...'` (and `paceline_worker`). Connect through Supavisor as `paceline_core.<project-ref>`: the session pooler (5432) supports LISTEN, the transaction pooler (6543) does not. In serverless mode core uses the `paceline_worker` URL only for draining jobs.
8. **Free-tier budget (500 MB)**: `api.purge_expired()` runs hourly. It keeps events for 7 days, digests for 24 h (I6) and finished jobs for 7 days, and clears Slack dedupe, idle rate buckets, stale leases and expired review items.

## The `embed` Edge Function

`functions/embed/index.ts` wires `handler.ts` (Web APIs only, no Deno or Supabase globals) to Supabase's built-in `gte-small` session (`Supabase.ai.Session('gte-small')`, `mean_pool` + `normalize`). It is free on every plan and makes no external call. The handler:

- accepts `POST` only and fails closed (500) when `PACELINE_EMBED_SECRET` is unset or shorter than 16 characters;
- checks `x-paceline-embed-secret` in constant time (SHA-256 digests) **before** reading the body (401 otherwise);
- takes `{"input": string | string[]}` (1–32 inputs, 1–8,000 chars each, body ≤ 512 KiB) and returns `{"model":"gte-small","dims":384,"embeddings":[...]}` in input order;
- never logs or echoes input text; model failures are `503 INTERNAL retryable`, wrong-width vectors are `500`.

Deploy and smoke-test (your Supabase login; see [docs/DEPLOY.md](../docs/DEPLOY.md) step 4):

```sh
supabase functions deploy embed --no-verify-jwt --project-ref <ref>
supabase secrets set PACELINE_EMBED_SECRET="$PACELINE_EMBED_SECRET" --project-ref <ref>
curl -s https://<ref>.supabase.co/functions/v1/embed \
  -H "x-paceline-embed-secret: $PACELINE_EMBED_SECRET" -H 'content-type: application/json' \
  -d '{"input":"hello"}' | jq '{model, dims, n: (.embeddings[0] | length)}'   # {"model":"gte-small","dims":384,"n":384}
```
