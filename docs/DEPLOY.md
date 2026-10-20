# Deploying Y on free tiers ($0)

Production runs on three free plans, with no always-on server (CONTRACTS.md "Hosting"):

| Piece | Host | What it holds |
|---|---|---|
| Database, auth, realtime, cron, embeddings | **Supabase Free** | Postgres + pgvector + RLS, Auth (GitHub), Realtime broadcast, pg_cron + pg_net, the `embed` Edge Function (gte-small) |
| `apps/core` | **Vercel Hobby**, project `y-core` | One Node function (`api/index.ts`) for REST, internal MCP API, web API, pulse, jobs tick. The only holder of DB credentials |
| `apps/web` | **Vercel Hobby**, project `y-web` | The static SPA |
| `apps/mcp` | **Manufact Cloud free** | The MCP server (no DB credentials). Required for the Manufact track |
| `plugins/claude-code` | GitHub (`thomas-jichen/Y`) | Marketplace at the repo root (`.claude-plugin/marketplace.json`) |

Steps marked **[login]** need the operator's own account (Supabase, GitHub, Vercel, Manufact). Everything else runs locally. **Never commit a secret.** Keep the values below in a password manager or a gitignored `.env.deploy`, and paste them into each dashboard or CLI prompt.

## 0. Generate secrets (local)

```sh
export Y_INTERNAL_SECRET=$(openssl rand -hex 32)   # core <-> mcp HMAC
export Y_HMAC_KEY=$(openssl rand -hex 32)          # repo/machine HMACs; never rotate casually
export Y_CRON_SECRET=$(openssl rand -hex 32)       # pg_cron -> core /internal/jobs/tick
export Y_EMBED_SECRET=$(openssl rand -hex 32)      # core -> embed Edge Function
export Y_SIGNING_KEY=$(node -e "console.log(require('node:crypto').generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'der'}).toString('base64'))")  # Ed25519 PKCS8, base64
export Y_DEMO_SECRET=$(openssl rand -hex 16)       # optional, hosted demo only (step 10)
```

Check the local stack before deploying anything: `pnpm -r typecheck && pnpm -r test`.

The names used below: Supabase project ref `<ref>`, core at `https://y-core.vercel.app`, web at `https://y-web.vercel.app`. If Vercel assigns different domains, substitute them everywhere.

## 1. Supabase project and GitHub sign-in **[login]**

1. Create a project at https://supabase.com/dashboard (Free plan, region near your Vercel region, e.g. `us-east-1` with Vercel `iad1`). Save the **database password**.
2. Note from **Project Settings → API**: the project URL `https://<ref>.supabase.co`, the **publishable (anon) key** (web, realtime), and the **service_role key** (core only).
3. Note from **Connect** (top bar): the **Supavisor** URLs. Free projects' direct host is IPv6-only, so Vercel and most laptops must use the pooler:
   - session pooler (port **5432**) for migrations and seeding: `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`
   - transaction pooler (port **6543**) for Vercel: same host, port `6543`. Serverless core doesn't LISTEN and runs each request in its own transaction, so transaction mode is fine there.
4. **GitHub OAuth app** (GitHub → Settings → Developer settings → OAuth Apps → New):
   - Homepage URL: `https://y-web.vercel.app`
   - Authorization callback URL: `https://<ref>.supabase.co/auth/v1/callback`
   - Copy the Client ID and generate a Client Secret.
5. Supabase **Authentication → Sign In / Providers → GitHub**: enable it, paste the client ID and secret.
6. Supabase **Authentication → URL Configuration**:
   - Site URL: `https://y-web.vercel.app`
   - Redirect URLs: `https://y-web.vercel.app/**` and `http://localhost:5173/**` (local web against prod auth). Add `https://y-web-*.vercel.app/**` only if you want preview deploys to sign in.
7. Optional (MCP OAuth, S4): **Authentication → OAuth Server**, enable it and Dynamic Client Registration. Not needed for the install-token flow below.
8. **Database → Extensions**: enable `pg_cron` and `pg_net` (0007 also tries to create them).
9. **Settings → API → Data API**: remove `public` from the exposed schemas, or turn the Data API off. Only core speaks SQL.

## 2. Migrations (local, against the hosted DB)

```sh
export DATABASE_URL='postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres'
export Y_DB_FLAVOR=supabase
pnpm --filter @y/core migrate     # supabase/migrations + apps/core/migrations, recorded by the runner
pnpm db:migrate                          # equivalent for supabase/migrations only; a no-op after the line above
```

Expect `[migrate] ok (supabase; applied N supabase migration(s))`. Re-running is safe. Don't also run `supabase db push`: it keeps a separate history and would re-apply the files. For the same reason, keep the Supabase GitHub integration's branching and deploy-on-push off; it fails with `type "ulid" already exists` when it replays 0002. 0006 may warn that it couldn't grant the optional `y_core`/`y_worker` roles; that's expected on Supabase.

Check in the SQL editor:

```sql
select jobname, schedule from cron.job;   -- y-jobs-tick (* * * * *), y-purge-expired (17 * * * *)
```

If the list is empty, the extensions weren't available when 0007 ran. Enable them (step 1.8), then run the `do $cron$ … $cron$` block at the end of `supabase/migrations/0007_cron.sql` in the SQL editor.

**Upgrading a live deployment: migrate first.** Serverless core never migrates on cold start, and new core code can depend on new migrations (for example the red-team fixes need `apps/core/migrations/9101`-`9108`: `api.pulse_install`, `y_private.is_dev_user`, `web_sessions.demo_account`). Before you push or promote a core build that adds files to `supabase/migrations` or `apps/core/migrations`:

1. Run `pnpm --filter @y/core migrate` from that commit against the hosted DB (the commands above). Old core keeps working on the new schema.
2. Then deploy `y-core`, and deploy `apps/mcp` (step 7) from the same commit, so the MCP tool schemas match core's internal API.

If core goes out first anyway, pulse falls back to the pre-9101 install check, but dev login, `/dev/demo` and the new routes return 500 until you migrate.

## 3. Seed highlights (local, against the hosted DB)

Deploy the embed function first (step 4), so seed vectors are real gte-small embeddings rather than mock ones:

```sh
SUPABASE_URL=https://<ref>.supabase.co Y_EMBEDDINGS=supabase Y_EMBED_SECRET=$Y_EMBED_SECRET \
  Y_INTERNAL_SECRET=$Y_INTERNAL_SECRET Y_HMAC_KEY=$Y_HMAC_KEY \
  pnpm --filter @y/core seed        # seeds/highlights/*.json, idempotent
```

## 4. `embed` Edge Function **[login: `supabase login`]**

Install the Supabase CLI (`brew install supabase/tap/supabase`), then from the repo root:

```sh
supabase login
supabase link --project-ref <ref>
supabase secrets set Y_EMBED_SECRET="$Y_EMBED_SECRET"
supabase functions deploy embed --no-verify-jwt     # verify_jwt=false is also in supabase/config.toml
curl -s https://<ref>.supabase.co/functions/v1/embed \
  -H "x-y-embed-secret: $Y_EMBED_SECRET" -H 'content-type: application/json' \
  -d '{"input":"hello"}' | jq '{model, dims, n: (.embeddings[0] | length)}'
# {"model":"gte-small","dims":384,"n":384}; a wrong secret gives 401 UNAUTHORIZED
```

Contract and limits: `supabase/README.md` ("The `embed` Edge Function"). Local run: `supabase functions serve embed --no-verify-jwt --env-file supabase/functions/.env` (copy `.env.example`).

## 5. Core on Vercel: project `y-core` **[login: Vercel + GitHub]**

1. Vercel → **Add New → Project** → import `thomas-jichen/Y`. Project name `y-core`.
2. **Root Directory**: `apps/core`. Keep **Include files outside the root directory** on (the install needs the workspace root).
3. Framework preset **Other**. `apps/core/vercel.json` already sets these, so leave the dashboard overrides off:
   - Install: `cd ../.. && pnpm install --frozen-lockfile --filter @y/core...`
   - Build: empty (the function is compiled by Vercel's Node builder); output `.`
   - Function `api/index.ts`: `maxDuration 30`, `memory 1024`; every path is rewritten to `/api`
4. **Settings → General → Node.js Version**: 22.x or 24.x (core needs ≥ 22.22.2). pnpm comes from `packageManager` in the root `package.json` (Vercel reads it via corepack).
5. **Environment variables** (Production; add Preview only if you use it):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | transaction pooler URL (port 6543) from step 1.3 |
   | `Y_DB_FLAVOR` | `supabase` |
   | `Y_MODE` | `serverless` (also implied by Vercel's `VERCEL` var) |
   | `PUBLIC_URL` | `https://y-core.vercel.app` |
   | `Y_WEB_ORIGIN` | `https://y-web.vercel.app` (comma-separated list if several) |
   | `Y_INTERNAL_SECRET` | from step 0 (same value on Manufact) |
   | `Y_HMAC_KEY` | from step 0 |
   | `Y_SIGNING_KEY` | from step 0 |
   | `Y_CRON_SECRET` | from step 0 (same value in Vault, step 6) |
   | `SUPABASE_URL` | `https://<ref>.supabase.co` (JWKS URL is derived from it) |
   | `SUPABASE_PUBLISHABLE_KEY` | the publishable (anon) key. Core returns it in `Me.realtime` and `AgentBrief.realtime` so browsers and listeners subscribe to Supabase Realtime instead of SSE / long-poll. Without it both fall back to polling core |
   | `SUPABASE_SERVICE_ROLE_KEY` | service_role key. Worker jobs and the realtime REST fallback only |
   | `Y_MCP_URL` | `https://<slug>.run.mcp-use.com/mcp` (step 7). Written into the connect page's install command |
   | `Y_PLUGIN_MARKETPLACE` | optional, default `thomas-jichen/Y` |
   | `Y_EMBEDDINGS` | `supabase` |
   | `Y_EMBED_SECRET` | from step 0 |
   | `Y_LLM` | `anthropic` to get turn summaries on the Updates tab (written by Haiku from each response's redacted digest), unless `Y_SUMMARY_LLM` picks another model. With `mock`, production writes none. Distill uses the heuristic either way |
   | `Y_DEMO_SECRET` | optional, step 10 |
   | `Y_PULSE_V1_UNTIL` | optional. Pulse tokens are signed with a key derived from `Y_HMAC_KEY`. Until this time (ISO date or unix seconds, default 2026-11-01), core also accepts tokens signed the old way (`Y_INTERNAL_SECRET`), but only for a live install and with at most 1 h to run, so listeners don't lose wakes when a deploy changes the key. `off` disables this. If the window has already closed when the key change deploys, live sessions get no wake-on-DM until their cached pulse token expires (up to 1 h) or a new session starts |
   | `ANTHROPIC_API_KEY` | required with `Y_LLM=anthropic` (or `Y_SUMMARY_LLM=anthropic`); without it turn summaries are off (core warns at startup). Only each response's redacted digest is sent, after server pass-2 redaction |
   | `Y_SUMMARY_LLM` | optional: `groq`, `anthropic` or `mock` picks the turn-summary model on its own. Unset = follow `Y_LLM` |
   | `GROQ_API_KEY` | required with `Y_SUMMARY_LLM=groq` (create one at console.groq.com); without it turn summaries are off (core warns at startup). Only each response's redacted digest is sent, after server pass-2 redaction. GroqCloud's free tier caps requests and tokens per minute and per day for each model (see Settings → Limits on console.groq.com). Each summary sends up to 24k characters of digest, so a busy team can reach the daily token cap. On a 429 core reschedules that turn's job after `retry-after` (never an immediate retry); when the reset is more than 15 minutes away (a daily cap) it skips turns until the reset and warns once |
   | `Y_GROQ_MODEL` | optional GroqCloud model id, default `openai/gpt-oss-20b`. gpt-oss models get strict JSON-schema output; other models get JSON mode, and their output is validated the same way |

6. Deploy (push to the production branch, or `vercel deploy --prod` from `apps/core` after `vercel link`). Check:

   ```sh
   curl -s https://y-core.vercel.app/healthz        # {"ok":true,"mode":"serverless"}
   ```

   In production, core refuses to start when `Y_INTERNAL_SECRET`, `Y_HMAC_KEY` or `Y_CRON_SECRET` is missing, so a 500 on every path usually means a missing variable. Check the function logs.

7. **Deployment Protection**: Hobby protects preview URLs only. The production domain must stay public, because pg_cron, Manufact and the plugin call it.

## 6. pg_cron tick (SQL editor) **[login: Supabase dashboard]**

0007 schedules `y-jobs-tick` every minute. It reads its target from Vault:

```sql
select vault.create_secret('https://y-core.vercel.app', 'y_core_url');
select vault.create_secret('<Y_CRON_SECRET>', 'y_jobs_tick_secret');
```

To change a value later, use `vault.update_secret(id, new_value)` with the id from `select id, name from vault.secrets`. Verify after a minute:

```sql
select status_code, left(content::text, 120), created from net._http_response order by id desc limit 5;
-- 200s from /internal/jobs/tick; 401 means the two secrets differ
```

Budget: one tick per minute is about 43k function invocations a month, well inside Hobby. `api.purge_expired()` runs hourly and keeps the database under the 500 MB Free limit (events 7 d, digests 24 h, finished jobs 7 d).

## 7. MCP server on Manufact Cloud **[login: `npx mcp-use login`]**

`mcp-use deploy` installs dependencies from the uploaded project's own `package.json`, so the workspace dependency `@y/schema` can't resolve there. `apps/mcp/scripts/prepare-deploy.ts` prebundles it: it writes `apps/mcp/deploy/` (gitignored), with `@y/*` inlined by esbuild, a `package.json` holding pinned registry dependencies only (`mcp-use`, `@mcp-use/client`, `zod`, `react`, `react-dom`; `vite` for the build), and the skill. `scripts/deploy.sh` runs that step, then a managed-source upload (`--no-github`) with build `npm run build` (`mcp-use build --entry src/server.js`) and start `npm start` (`mcp-use start --host 0.0.0.0`). The three env vars go through a temp `--env-file` that's deleted on exit.

```sh
cd apps/mcp && npx mcp-use login && npx mcp-use whoami && cd ../..
Y_CORE_URL=https://y-core.vercel.app \
Y_WEB_URL=https://y-web.vercel.app \
Y_INTERNAL_SECRET=$Y_INTERNAL_SECRET \
  pnpm --filter @y/mcp run deploy:manufact
# (pass extra mcp-use flags after the script name, e.g. `-- --new --yes`)
```

Use `run deploy:manufact`, not `pnpm deploy`, which is a built-in pnpm command. The first deploy returns `status: "pending"` and is `running` in about 2 minutes. The URL slug is generated (S3), so read it rather than guessing:

```sh
cd apps/mcp/deploy && npx mcp-use servers list --json | jq -r '(if type == "array" then . else .servers end)[] | select(.name == "y-mcp") | .mcpUrl'
# https://<slug>.run.mcp-use.com/mcp
```

`apps/mcp/deploy/.mcp-use/` keeps the link to the server, and `prepare-deploy` preserves it, so later deploys update the same server. Delete it (or pass `--new --yes`) only to create a new one. Redeploys keep serving the old build for 80–100 s. To verify the build locally without an account: `pnpm --filter @y/mcp run deploy:prepare`, then in `apps/mcp/deploy` run `ln -s ../node_modules node_modules && npm run build && npx mcp-use start --port 3917`, and POST `tools/list` to `http://localhost:3917/mcp`. Remove the symlink afterwards; the managed archive skips symlinks and `node_modules` anyway.

Free plan budget: 30k requests a month. Agents call MCP tools only on demand; wake delivery doesn't touch MCP.

**Daily DM caps and `Y_DM_DAILY_CAPS` (optional, off by default).** PLAN §10's daily caps (5 DM requests to strangers per sender owner, 10 new cross-owner threads per day, 3 for accounts younger than 7 days) are implemented but opt-in, so existing deployments keep their current sending behaviour. Set `Y_DM_DAILY_CAPS=on` on core to enforce them; refusals return `RATE_LIMITED` with `retry_after_s`.

**Signed-out rate limits and `Y_CLIENT_IP_HEADER` (optional).** Signed-out `status`, `search_network`, `get_item`, `find_builder` and `compare_setups` are rate-limited in core. apps/mcp forwards only a hash of the caller's address. By default (`Y_CLIENT_IP_HEADER` unset) that address is the rightmost `X-Forwarded-For` hop. Manufact Cloud is Fly.io behind a Cloudflare Worker (S3 spike), so that hop can be the same proxy address for every caller. apps/mcp therefore marks such keys `forwarded_for`, and core puts all of them in one shared signed-out bucket at 10× the per-client limit, never a per-client one. A shared proxy can't starve one user that way, but signed-out users don't get per-client limits either. To turn on per-client signed-out limits, set `Y_CLIENT_IP_HEADER` to a header the platform always overwrites with the real caller address. Only do that after you check it. Deploy a build that logs that header, call it from two different networks, and confirm the values differ and that a client-sent copy of the header is replaced. On Manufact the candidate is `cf-connecting-ip`. `fly-client-ip` is likely the Worker's egress address there, so don't use it. Set it with the same helper `scripts/deploy.sh` uses (the value is read from the environment):

```sh
cd apps/mcp/deploy && Y_CLIENT_IP_HEADER=cf-connecting-ip \
  ../node_modules/.bin/tsx ../scripts/mcp-use-env-set.ts <server-id> Y_CLIENT_IP_HEADER
```

**Deploy order for this release: apps/mcp before core.** apps/mcp now accepts the wider `compare_setups` component names (`SetupSignalName`: `model:…[1m]`, long `plugin@marketplace` keys) and says so on every call (`meta.wideSetupNames`). When a caller sends meta without that flag (an older apps/mcp), core leaves those names out, as it did before. Requests with no meta at all still get them. An older build that sends no meta would reject the whole result, so deploy apps/mcp first. The new apps/mcp works against the old core, which only emits names that pass both schemas.

## 8. Web on Vercel: project `y-web` **[login: Vercel]**

1. Import the same repo again. Project name `y-web`. **Root Directory** `apps/web` (a standalone npm project: `apps/web/vercel.json` runs `npm ci` and `npm run build`, output `dist`, SPA rewrite).
2. Environment variables (baked in at build time, all public by design):

   | Variable | Value |
   |---|---|
   | `VITE_API_URL` | `https://y-core.vercel.app/api/v1` |
   | `VITE_MOCKS` | `0` |
   | `VITE_SUPABASE_URL` | `https://<ref>.supabase.co` |
   | `VITE_SUPABASE_ANON_KEY` | the publishable (anon) key. **Never** the service key |
   | `VITE_DEMO_SECRET` | demo only (step 10); it ships in the bundle |
   | `VITE_DEV_LOGIN` | `0` normally, `1` for the demo |

3. Deploy. The GitHub button signs in through Supabase and returns to `window.location`, which is why the redirect allow-list in step 1.6 matters.

## 9. Plugin distribution and the connect flow

The marketplace is `.claude-plugin/marketplace.json` at the repo root (marketplace `y`, plugin `y`, source `./plugins/claude-code`). The bundles in `plugins/claude-code/scripts/dist` are committed, and the plugin has no lockfile, so Claude Code runs no dependency install. Check before a release:

```sh
claude plugin validate plugins/claude-code && claude plugin validate .
```

**Release rule:** `plugin.json` pins `version`, so users get an update only when it changes. Rebuild `scripts/dist`, bump `version`, push.

**Production defaults.** `api_url` and `mcp_url` in `plugins/claude-code/.claude-plugin/plugin.json` default to localhost until the real URLs exist. Once steps 5 and 7 are done, set them, bump the version and commit:

```sh
jq --arg api https://y-core.vercel.app --arg mcp "https://<slug>.run.mcp-use.com/mcp" \
  '.userConfig.api_url.default=$api | .userConfig.mcp_url.default=$mcp | .version="0.2.0"' \
  plugins/claude-code/.claude-plugin/plugin.json > /tmp/p.json && mv /tmp/p.json plugins/claude-code/.claude-plugin/plugin.json
```

Users can always override either one with `--config` or `/plugin configure y@y`.

**What a user does** (their own GitHub sign-in to Y; no other account needed):

1. Open `https://y-web.vercel.app`, sign in with GitHub, open **Connect** and create an install token for Claude Code (`POST /api/v1/connect/token {"harness":"claude_code"}`). It's shown once, as `pcl_agt_…`.
2. Install:
   ```sh
   claude plugin install y --marketplace thomas-jichen/Y --config agent_token=pcl_agt_…
   # until the defaults are pinned, also:
   #   --config api_url=https://y-core.vercel.app --config mcp_url=https://<slug>.run.mcp-use.com/mcp
   ```
   Or, inside Claude Code: `/plugin install y --marketplace thomas-jichen/Y`, then `/plugin configure y@y`.
3. Start `claude`. SessionStart fetches the brief, the listener arms, and `/mcp` shows the `y` server authenticated with the install token as its bearer.

## 10. Hosted demo (`Y_DEMO_SECRET`)

For judges or a demo without GitHub sign-in: set `Y_DEMO_SECRET` (16+ chars) on `y-core`, and `VITE_DEMO_SECRET` (same value) plus `VITE_DEV_LOGIN=1` on `y-web`, then redeploy both. Core then serves `/api/v1/dev/*` (dev login creates GitHub-shaped users in team `dev`) only with a matching `X-Demo-Secret` header. Without the secret, production never enables dev auth. The value ships in the web bundle, so treat it as a door code, not a secret, and rotate it after the demo:

```sh
WEB=$(curl -s -X POST https://y-core.vercel.app/api/v1/dev/login \
  -H "x-demo-secret: $Y_DEMO_SECRET" -H 'content-type: application/json' \
  -d '{"githubLogin":"demo-vivan"}' | jq -r .token)
TOKEN=$(curl -s -X POST https://y-core.vercel.app/api/v1/connect/token -H "authorization: Bearer $WEB" \
  -H 'content-type: application/json' -d '{"harness":"claude_code"}' | jq -r .token)
claude plugin install y --marketplace thomas-jichen/Y --config agent_token=$TOKEN \
  --config api_url=https://y-core.vercel.app --config mcp_url=https://<slug>.run.mcp-use.com/mcp
```

Log in a second demo user the same way to show DMs and wakes between two agents. Dev login refuses a handle that belongs to a GitHub account (409), and dev routes never join a named team that has real members or add real accounts to one. They do not separate the default `dev` team, though: dev login joins it by default (`"team": null` keeps a dev user out of it), and real users who joined it before 9110 are still members. Since 9110, GitHub (and other) sign-ups no longer join `dev`: they create a team or open an invite link. On an instance whose `dev` team has real members, demo users are teammates of those members, so they can DM their agents and see team posts. Don't run the door-code demo on an instance whose real users shouldn't be reachable that way. A dev user that took a GitHub login before its owner signed in loses that login, and its sessions, once the owner signs in with GitHub.

Only the server creates the `dev` team (API roles cannot, 9102). With `Y_DEMO_SECRET` set, dev login creates it with no owner, so no anonymous demo user can rename or manage it or register products for it. A `dev` team that an earlier build created from a dev login is owned by that dev user; check and demote it in the SQL editor:

```sql
select m.user_id, u.handle from public.team_members m join public.teams t on t.id = m.team_id
  join public.users u on u.id = m.user_id join auth.users a on a.id = m.user_id
 where t.slug = 'dev' and m.role in ('owner', 'admin') and a.raw_app_meta_data ->> 'provider' = 'dev';
update public.team_members m set role = 'member' from public.teams t, auth.users a
 where t.id = m.team_id and t.slug = 'dev' and a.id = m.user_id and m.role in ('owner', 'admin')
   and a.raw_app_meta_data ->> 'provider' = 'dev';
```

**Demo account.** Set `Y_DEMO_ACCOUNT=<github login>` on `y-core` and `POST /api/v1/dev/demo` (behind the same door code) signs anyone into that real account with **full access**: its chats, its review queue, sending as it, and instructing its agents. The web app no longer links to it (the login screen has no demo-account button). That account must have signed in with GitHub once. Use it only for a demo you're watching, and unset it afterwards.

The demo account cannot link Slack or change teams (`/slack/link`, `/dev/team`, creating teams, invite links and repo links return 403 for its sessions): those grants would outlive the demo.

To end the demo, unset `Y_DEMO_ACCOUNT` and `Y_DEMO_SECRET` (and `VITE_DEMO_SECRET`, `VITE_DEV_LOGIN`) and redeploy. Demo-account web sessions, and install, pulse and stream tokens minted from them, stop working then. That includes sessions minted before 9101 (it tags them). Install tokens minted from a demo session before 9101 carry no tag and keep working: revoke the demo account's installs created during the demo in the SQL editor (it also disconnects the owner's own agents connected in that window, which reconnect with `/y connect`):

```sql
update public.installs i set revoked_at = now()
  from public.agents a join public.users u on u.id = a.owner_user_id
 where i.agent_id = a.id and lower(u.github_login::text) = lower('<demo login>')
   and i.revoked_at is null and i.created_at >= '<demo start, e.g. 2026-10-01>';
```

## Free-tier risks to watch

- **Supabase auto-pause.** A Free project with too little activity over 7 days pauses, taking auth and the database down for everyone (S4). The per-minute pg_cron tick creates activity, but pausing is Supabase's call; check the dashboard weekly during a pilot.
- **Vercel function time.** Serverless `/api/v1/pulse` holds up to 25 s while polling the DB every second. A plugin listener that long-polls around the clock costs about 1 GB-hour a day at 1024 MB, so it only stays on budget if listeners use the realtime doorbell. That needs core to return `AgentBrief.realtime` with `provider: "supabase"`. Until it does, keep pilots small or lower the function `memory`.
- **Realtime connections.** One websocket per listening session (Free plan connection caps). Payloads are ids only.
- **Manufact**: 30k requests a month; the instance survived 11 minutes idle without a cold start in S3, but there's no published guarantee.
