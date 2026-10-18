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
| `tests/*.sql` | pgTAP: isolation, CAS, rate limits, jobs, events, cron (plain SQL, no psql meta-commands) |
| `functions/embed/` | gte-small embeddings (384 dims) for core, behind a shared secret |
| `config.toml` | Supabase CLI settings (local stack, `verify_jwt = false` for `embed`) |

## Commands

```sh
pnpm --filter @paceline/db migrate            # apply to .pglite (PACELINE_DATA_DIR=memory for a throwaway)
pnpm --filter @paceline/db test:sql           # every tests/*.sql on fresh PGlite databases
pnpm --filter @paceline/db test               # includes the same gate (supabase.test.ts)
supabase db push                              # hosted project (after `supabase link`)
supabase test db                              # the same pgTAP files against the local Supabase stack
deno test supabase/functions/embed            # Edge Function handler tests
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
- The insert trigger always runs `pg_notify('paceline_events', id)`. Server-mode core LISTENs and reads new rows with `api.events_since(cursor)`, which returns the `NotifyPayload` JSON in its `notify` column.
- Where `realtime.send` exists (Supabase), the trigger also broadcasts `{id, type, payload}` to `agent:<agent_id>:<secret>` and `user:<user_id>:<secret>` on public channels (`private = false`). Secrets live in `realtime_channels`, readable only by their owner. Clients subscribe with `supabase.channel(topic, { config: { private: false } }).on('broadcast', { event: '*' }, ...)`. `api.rotate_channel_secret` rotates one.
- `api.my_events(cursor)` is the per-caller catch-up (SSE `Last-Event-ID`, `/pulse`).
- Do not emit `review.new`, `review.decided` or `change.updated` from core: triggers do.
- `jobs` inserts run `pg_notify('paceline_jobs', topic)`.

## Production checklist (Supabase Free)

1. **Migrations**: `supabase link --project-ref <ref>`, then `supabase db push`. 0006 warns instead of failing if the API-role grants are not allowed; grant them manually if so.
2. **Data API**: only core speaks SQL. In Dashboard → Settings → API, remove `public` from the exposed schemas (or disable the Data API). RLS and grants are written to be safe either way. Never expose `api` or `paceline_private`: their functions assume core is the only caller.
3. **Auth**: enable the GitHub provider. Enable the OAuth 2.1 server for ChatGPT, claude.ai and `codex mcp login`.
4. **Realtime**: keep public channels allowed (topics carry the secret). One connection per listening plugin; payloads are ids only.
5. **Cron tick** (0007 schedules it every minute as `paceline-jobs-tick`):
   ```sql
   select vault.create_secret('https://<core>.vercel.app', 'paceline_core_url');
   select vault.create_secret('<random 32+ chars>', 'paceline_jobs_tick_secret');
   ```
   Core gets the same secret as `PACELINE_CRON_SECRET` and receives `POST /internal/jobs/tick` with `Authorization: Bearer <secret>` and body `{"source":"pg_cron","due":<n>}`. Without Vault, insert `core_url` and `jobs_tick_secret` into `paceline_private.app_config`. Check with `select * from cron.job;` and `select * from net._http_response order by id desc limit 5;`.
6. **Embeddings**: `supabase functions deploy embed --no-verify-jwt` and `supabase secrets set PACELINE_EMBED_SECRET=<random 32+ chars>`. Core calls `POST <SUPABASE_URL>/functions/v1/embed` with header `x-paceline-embed-secret` and body `{"input": string | string[]}` (up to 32 inputs of 8,000 chars), and gets `{"model":"gte-small","dims":384,"embeddings":[[...]]}`.
7. **Roles (optional)**: in the SQL editor, `alter role paceline_core with login password '...'` (and `paceline_worker`). Connect through Supavisor as `paceline_core.<project-ref>`: the session pooler (5432) supports LISTEN, the transaction pooler (6543) does not. In serverless mode core uses the `paceline_worker` URL only for draining jobs.
8. **Free-tier budget (500 MB)**: `api.purge_expired()` runs hourly. It keeps events for 7 days, digests for 24 h (I6) and finished jobs for 7 days, and clears Slack dedupe, idle rate buckets, stale leases and expired review items.
