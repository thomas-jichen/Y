# Accounts and keys: status and runbook

- **Date:** 2026-10-17 / laurence (driven from a Claude Code agent session)
- **Tracks [README.md](README.md) §1 as of `ff136db`** (the $0 free-tier rewrite). It answers §1's own open
  question — whether the OAuth 2.1 server exists on the Free plan — and records what each remaining signup needs.
- **Correction:** an earlier version of this file argued that §1's "Supabase Pro" and the Anthropic API key
  conflicted with the $0 constraint. That was written against a stale local copy of §1 and is withdrawn; the
  current §1 already specifies Free everywhere and marks the Anthropic key optional.

## What I could and could not do

**Could not, and did not attempt:** create the accounts. Supabase, Vercel, the GitHub OAuth app and the Slack app
all need an interactive browser signup with email verification and OAuth consent on your own identity. I also
have no access to the password manager, so **no key below is stored anywhere by me** — the runbook tells you
where each value comes from and what name to file it under.

**Did do:** verified the one account that already exists by deploying to it end to end, answered §1's open
question about the Free plan's OAuth server, worked out the schema consequence of the free embeddings path, and
wrote the exact settings for each remaining signup so each one is a few minutes of clicking rather than a
research task.

## Status

The account list below follows [README.md](README.md) §1 as it stands on `main` after `ff136db`
("Update teammate tasks for $0 hosting on free tiers"): everything free, **no Fly.io, no AWS, no Vercel AI
Gateway, no Supabase Pro**.

| # | Account | Plan | Status |
|---|---|---|---|
| 1 | **Supabase** | Free | **not created** — runbook below |
| 2 | **GitHub OAuth app** | free | **not created** — runbook below |
| 3 | **Vercel** | Hobby | **not created** — hosts the core API and the web app |
| 4 | **Manufact** | free | **DONE** (2026-10-17) — verified, see below |
| 5 | **Slack internal app** | free | **not created** — not needed until M6 |
| — | Anthropic API key | — | **not needed.** §1 marks it optional: summaries run on each user's own Claude subscription; a key only adds server-side summaries and the AI safety judge |

### 4. Manufact — verified working

`npx mcp-use whoami` → `<Laurence's account> — Primary`, org `Primary` (`org-6c1711a6-cv6rx`).
`MCP_USE_API_KEY` / `MCP_USE_ORG` are in the local gitignored `.env`; `.env.example` documents them.
Proven beyond login: a hello MCP server was built, deployed and called over the public URL — see
[S3](S3-manufact-cloud.md). Keys are prefixed `mcp_`; rotate by re-running `npx mcp-use login`.

## Answering §1's open question: is the OAuth 2.1 server on the Free plan?

§1 says "Enable the **OAuth 2.1 server** and dynamic client registration, **if the Free plan offers them**. Note
it if it doesn't; S4 checks this", and S4 step 0 asks the same thing with a Better Auth fallback behind it.

**Answer: yes, and no fallback is needed.** The Supabase OAuth 2.1 Server is available on **every plan including
Free**, at no separate charge, and its **Dynamic Client Registration** endpoint (`POST /oauth/clients/register`,
RFC 7591) is a **per-project toggle with no plan gate**. So the design proceeds as written and we do not need to
fall back to Better Auth inside our own server.

Two caveats to carry:

- It is still in **public beta** (since 2025-11-26; no GA announcement as of 2026-10-17).
- Free includes **50,000 MAU**, far beyond a pilot — but **the real Free-plan risk is auto-pause.** A Free project
  with too little database activity over a week is paused automatically, and that takes the authorization server
  down with it: every agent in the pilot fails to authenticate at once, looking exactly like our bug. Add a
  keep-alive (a scheduled query every few days) before the pilot. This, not any missing feature, is what would
  eventually justify paying for Supabase.

## The embeddings decision is now a schema decision

§1 rules out the Vercel AI Gateway, and S4 step 4 asks for a check that `new Supabase.ai.Session('gte-small')`
"returns 384 numbers". So the direction is already chosen; what matters is the consequence.

| | `gte-small` (chosen) | `openai/text-embedding-3-small` (ruled out) |
|---|---|---|
| Cost | **free**, no AI line item on any plan | paid per token via an AI Gateway key |
| Dimensions | **384** | 1536 |
| Runs | locally inside the Edge Function, no external API | Vercel's hosted gateway |
| Limits | **512-token input truncation, English only**, 2 s CPU / 256 MB per request | API rate limits |

Three things for whoever writes the migrations:

- **The column is `vector(384)`, not `vector(1536)`.** Changing this later means a migration *and* a full
  re-embed of every highlight, so it needs to be right the first time.
- **Chunk highlight bodies under 512 tokens.** `gte-small` silently truncates past that — no error, just a
  worse embedding, which is the kind of bug that never gets found.
- **Guard the model name.** `gte-small` is the only built-in model; any other name falls back to an external
  Ollama host supplied via `AI_INFERENCE_API_HOST`, so a typo becomes a confusing network failure rather than
  a validation error.

Live confirmation of the 384-number result and its latency needs the Supabase project, so it stays on S4 step 4.

## Does $0 actually reach all the way? Yes, on the current plan

I previously flagged that "$0" and "session summaries plus a safety judge" could not both be true. **That was
wrong** — it was written against a stale copy of §1. The current §1 marks the Anthropic key *optional and not
needed*: "Session summaries run on each user's own Claude subscription by default; a key only enables
server-side summaries and the AI safety judge." So the default path costs nothing, and the key is a later
upgrade for server-side summarisation, not a prerequisite.

The one genuine spend risk left is not an account at all — it is **Supabase Free auto-pause** taking the auth
server offline mid-pilot (above). Budget for the upgrade when the pilot starts, not before.

## Runbook for the remaining accounts

Create each, then file the named values in the password manager. **Nothing goes in the repo** — `.env` is
gitignored and `.env.example` carries names only.

### 1 + 2. Supabase project with GitHub login (do these together)

1. **Supabase** → new project on **Free**. Pick the region closest to where the core API will run on
   Vercel. Record:
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
5. Add a keep-alive against auto-pause before you forget (see the OAuth section above).

### 3. Vercel

**Hobby plan.** Per §1 this hosts **the core API and the web app** — so it is not optional, and it is not just
the UI teammate's concern. Create the account now and link the project later. Do **not** create an AI Gateway
key: §1 rules it out, and the embeddings decision above no longer needs it.

`apps/mcp` stays on Manufact ([S3](S3-manufact-cloud.md)); there is no Fly.io account to create.

### 5. Slack internal app (defer to M6)

Workspace-internal app. Scopes: `chat:write`, `im:write`, `commands` — nothing more.
Record the signing secret and bot token. Not needed before M6; creating it early just means a secret sitting
around unused.

## Keys index for the password manager

Use these exact names so `.env.example` and the vault agree.

```
MCP_USE_API_KEY            done
MCP_USE_ORG                done
SUPABASE_URL               pending
SUPABASE_ANON_KEY          pending
SUPABASE_SERVICE_ROLE_KEY  pending — server only, never in apps/web
SUPABASE_JWKS_URL          pending
DATABASE_URL               pending — pooled, :6543
DIRECT_URL                 pending — direct, :5432
GITHUB_OAUTH_CLIENT_ID     pending
GITHUB_OAUTH_CLIENT_SECRET pending
SLACK_SIGNING_SECRET       M6
SLACK_BOT_TOKEN            M6
```

Deliberately absent, because §1 rules them out or marks them optional:
`ANTHROPIC_API_KEY` (optional — user's own Claude subscription by default), `AI_GATEWAY_API_KEY` (no Vercel AI
Gateway), `FLY_API_TOKEN` (no Fly.io).
