# Accounts and keys: status, runbook, and two conflicts to settle

- **Date:** 2026-10-17 / laurence (driven from a Claude Code agent session)
- **Read this before section 1 of [README.md](README.md).** Two things in that section conflict with the
  "$0, free plans only" constraint, and one of them turns out to be free after all.

## What I could and could not do

**Could not, and did not attempt:** create the accounts. Supabase, Vercel, the GitHub OAuth app and the Slack app
all need an interactive browser signup with email verification and OAuth consent on your own identity. I also
have no access to the password manager, so **no key below is stored anywhere by me** — the runbook tells you
where each value comes from and what name to file it under.

**Did do:** verified the one account that already exists, established which pieces are genuinely free (this is
where the plan conflict got resolved), deployed to Manufact to prove the account works end to end, and wrote the
exact settings for each remaining signup so each one is a few minutes of clicking rather than a research task.

## Status

| # | Account | Plan needed | Status |
|---|---|---|---|
| 1 | Anthropic API key | pay-as-you-go | **not created** — not free; see "Cost reality" below |
| 2 | Vercel AI Gateway key | Hobby | **not created** — needed only if we use OpenAI embeddings; see conflict 2 |
| 3 | Supabase project | **Free is enough** | **not created** — runbook below |
| 4 | GitHub OAuth app | free | **not created** — runbook below |
| 5 | Manufact | free | **DONE** (2026-10-17) — verified, see below |
| 6 | Fly.io | Hobby/free allowance | **not created** |
| 7 | Slack internal app | free | **not created** — not needed until M6 |

### 5. Manufact — verified working

`npx mcp-use whoami` → `lapark714@gmail.com — Primary`, org `Primary` (`org-6c1711a6-cv6rx`).
`MCP_USE_API_KEY` / `MCP_USE_ORG` are in the local gitignored `.env`; `.env.example` documents them.
Proven beyond login: a hello MCP server was built, deployed and called over the public URL — see
[S3](S3-manufact-cloud.md). Keys are prefixed `mcp_`; rotate by re-running `npx mcp-use login`.

## Conflict 1: Supabase "Pro plan" vs "$0" — resolved, Free is enough

`README.md` section 1 says **Supabase Pro**; your instruction says **Free, no paid plans**. These are reconcilable,
because the feature the Pro line was presumably protecting is not actually gated:

- **The OAuth 2.1 authorization server is available on every plan, including Free, at no separate charge**, and
  its **Dynamic Client Registration** endpoint (`POST /oauth/clients/register`, RFC 7591) is a **per-project
  toggle with no plan gate**. So [S4](S4-supabase-oauth.md) and the whole MCP-OAuth design can proceed on Free.
- Still in **public beta** (since 2025-11-26, no GA announcement as of today). Treat it as beta for planning.
- Free gives **50,000 MAU**, far beyond a pilot.

**The real Free-plan risk is not features, it is auto-pause.** A Free project with too little database activity
over a week is **automatically paused — and that takes the authorization server offline with it.** For a product
whose entire premise is agents connecting at unpredictable times, a paused auth server means every agent in the
pilot fails to authenticate at once, and it will look like our bug. Mitigate with a cheap keep-alive (a scheduled
query every few days) and know that this is the thing that will eventually force the upgrade.

**Recommendation:** build on Free now, and treat "Supabase Pro" as a launch-time line item justified by
auto-pause and payload limits, not by the OAuth feature.

## Conflict 2: embeddings — two incompatible plans, and they change the schema

`README.md` section 1 specifies a **Vercel AI Gateway key** for `openai/text-embedding-3-small`. Your message
instead asks whether **Supabase's free `gte-small`** works. Both work, but they are not interchangeable:

| | `openai/text-embedding-3-small` via Vercel AI Gateway | `gte-small` in Supabase Edge Functions |
|---|---|---|
| Cost | paid per token (Gateway key, Hobby plan) | **free, no AI line item on any plan** |
| Dimensions | **1536** | **384** |
| Runs | Vercel's hosted gateway | locally in the Edge Function, no external API |
| Limits | API rate limits | **512-token input truncation, English only**, 2 s CPU / 256 MB per request |

**This is a schema decision, not a config flag:** the `vector(N)` column dimension differs, so switching later
means a migration and a full re-embed of every highlight. `gte-small` also silently truncates at 512 tokens, and
if you ask for any other model name it **falls back to an external Ollama host** you have to supply via
`AI_INFERENCE_API_HOST` — a quiet failure mode worth guarding.

**Recommendation for $0:** `gte-small`, `vector(384)`, and chunk highlight bodies to stay under 512 tokens. Tell
the core owner before the migrations are written — this needs to be settled *before* `apps/core` lands its schema.

## Cost reality: $0 does not reach all the way

Two items in section 1 are not free at all, and the plan depends on them:

- **Anthropic API key** — session summaries (the doc names Haiku/Sonnet 5.5) and the safety judge. There is no
  free tier. If `$0` is a hard constraint for M0–M1, these two features cannot run on a real key: either stub the
  summariser and judge behind an interface and seed their outputs by hand, or accept a small spend. When you do
  create the key, **set a monthly spend cap in the console on day one.**
- **Fly.io** — has a free allowance but requires a card on file.

Flagging rather than deciding: "spend $0" and "generate session summaries with Haiku and run a safety judge" are
not simultaneously satisfiable, and it is better to know that now than at M3.

## Runbook for the remaining accounts

Create each, then file the named values in the password manager. **Nothing goes in the repo** — `.env` is
gitignored and `.env.example` carries names only.

### 3 + 4. Supabase project with GitHub login (do these together)

1. **Supabase** → new project on **Free**. Pick the region closest to Fly's `apps/core` region. Record:
   - `SUPABASE_URL` → `https://<ref>.supabase.co`
   - `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (service role is a secret — server only, never in `apps/web`)
   - JWKS URL → `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`
   - DB connection strings, **both**: pooled (port 6543, for `apps/core`) and direct (5432, for migrations)
2. **GitHub OAuth app** → github.com → Settings → Developer settings → OAuth Apps → New.
   - Homepage: our app URL (Vercel preview is fine initially)
   - **Authorization callback URL: `https://<ref>.supabase.co/auth/v1/callback`** — this exact value; a mismatch
     here is the single most common cause of a broken login
   - Record Client ID + Client Secret
3. Back in Supabase → Authentication → Providers → **GitHub** → paste Client ID/Secret → enable.
4. Authentication → **OAuth Server** (beta) → enable, and turn on **Dynamic Client Registration**.
   Record the issuer URL and the registration endpoint.
5. Add a keep-alive against auto-pause before you forget (see conflict 1).

### 2. Vercel

Hobby plan. Only create the **AI Gateway** key if conflict 2 resolves toward OpenAI embeddings. If we go
`gte-small`, skip it — and note `README.md` does not list Vercel as a hosting target at all (`apps/core` → Fly,
`apps/mcp` → Manufact), so Vercel Hobby is only relevant for `apps/web`, which the UI teammate owns.

### 6. Fly.io

Hobby. Card required. Create the app for `apps/core` in the same region as Supabase. Record the app name and
deploy token (`fly tokens create deploy`), not your personal credentials.

### 7. Slack internal app (defer to M6)

Workspace-internal app. Scopes: `chat:write`, `im:write`, `commands` — nothing more.
Record the signing secret and bot token. Not needed before M6; creating it early just means a secret sitting
around unused.

## Keys index for the password manager

Use these exact names so `.env.example` and the vault agree:

```
MCP_USE_API_KEY            done
MCP_USE_ORG                done
ANTHROPIC_API_KEY          pending — set a spend cap
AI_GATEWAY_API_KEY         pending — only if we choose OpenAI embeddings
SUPABASE_URL               pending
SUPABASE_ANON_KEY          pending
SUPABASE_SERVICE_ROLE_KEY  pending — server only
SUPABASE_JWKS_URL          pending
DATABASE_URL               pending — pooled, :6543
DIRECT_URL                 pending — direct, :5432
GITHUB_OAUTH_CLIENT_ID     pending
GITHUB_OAUTH_CLIENT_SECRET pending
FLY_API_TOKEN              pending
SLACK_SIGNING_SECRET       M6
SLACK_BOT_TOKEN            M6
```
