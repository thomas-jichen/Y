# Teammate tasks: accounts, spikes, seeds

Parallel work that build agents can't do: provisioning real accounts, and checking our assumptions in real Claude Code and Codex sessions. The results change what gets built, so **do sections 1 and 2 first**. If S1 or S6 fails, tell the core owner before the messaging layer is built.

**Where to work.** Use your own branch. Only touch `docs/spikes/` and `seeds/`. Build agents own `packages/`, `apps/core`, `apps/mcp`, `plugins/`, `cli/` and `eval/` (on branch `core/v0`), and the UI teammate owns `apps/web`.

---

## 1. Provision accounts (all free)

We're running at **$0** on free tiers. Don't sign up for anything paid (no Fly.io, AWS, Vercel AI Gateway or Supabase Pro). Keep every value in a shared password manager. **Never commit keys to the repo.**

- [ ] **Supabase, Free plan** (database, GitHub login, OAuth for MCP clients, Realtime, cron, Edge Functions):
  - Create one project.
  - Enable the **OAuth 2.1 server** and dynamic client registration, if the Free plan offers them. Note it if it doesn't; S4 checks this.
  - Record the project URL, anon key, service-role key, JWKS URL, and the DB connection strings (pooled and direct).
- [ ] **GitHub OAuth app** (free): set it as Supabase's GitHub login provider, with the callback URL Supabase shows you.
- [ ] **Vercel, Hobby plan** (free): hosts the core API and the web app. Just create the account; we'll link the project later.
- [ ] **Manufact, free plan**: run `npx mcp-use login`. Hosts the MCP server for the Manufact track.
- [ ] **Slack internal app** in our workspace (free; needed later for M6): create it and note the signing secret and bot token. No scopes beyond `chat:write`, `im:write`, `commands` yet.
- Optional, not needed: an Anthropic API key. Session summaries run on each user's own Claude subscription by default; a key only enables server-side summaries and the AI safety judge.

---

## 2. Spikes

Each spike is a 30–90 minute throwaway experiment. Write each result to `docs/spikes/<id>-<name>.md` using the template at the end of this section. **Always record the exact Claude Code or Codex version** (`claude --version`, `codex --version`).

### S1: Does asyncRewake wake an idle Claude Code session? (CLI)

This decides whether a DM can wake your idle agent.

1. Make a throwaway plugin:
   ```
   /tmp/spike-wake/.claude-plugin/plugin.json   {"name":"spike-wake","version":"0.0.1"}
   /tmp/spike-wake/hooks/hooks.json
   /tmp/spike-wake/wake.mjs
   ```
   `hooks/hooks.json`:
   ```json
   {"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"node",
     "args":["${CLAUDE_PLUGIN_ROOT}/wake.mjs"],"asyncRewake":true,"timeout":3300}]}]}}
   ```
   `wake.mjs`:
   ```js
   const s = Number(process.env.WAKE_AFTER_S ?? 120);
   setTimeout(() => {
     process.stderr.write('Paceline: 1 unread DM from @spike-bot. Call the inbox tool.\n');
     process.exit(2);
   }, s * 1000);
   ```
2. Run `WAKE_AFTER_S=120 claude --plugin-dir /tmp/spike-wake` in a scratch folder, say "hi", then **leave it idle**. Does Claude start a new turn about 2 minutes later, showing the stderr text?
   - If `--plugin-dir` isn't accepted, put the same hook in a scratch project's `.claude/settings.local.json` (`"command":"node /tmp/spike-wake/wake.mjs"`) and note that.
3. Vary the delay and timeout:
   - `WAKE_AFTER_S` = 900, 1800 and 3200 with `timeout` 3300.
   - `timeout` 7200 with `WAKE_AFTER_S` 5000, to find the largest timeout that's actually honored.
4. **Mid-turn**: give Claude a long task (e.g. "list every file and summarize each") and trigger the wake while it's working. Is the text delivered after the turn, or does it interrupt?
5. **Re-arm**: add the same hook under `Stop`. After a wake fires and the turn ends, does a new listener start, and does a second wake work?
6. Try the same hook under `Notification` with `"matcher":"idle_prompt"`. The docs say exit codes are ignored for Notification hooks, so does a wake from there work at all?

### S13: Same checks in the Claude desktop app (Code tab)

1. Open a scratch folder in the desktop app's Code tab. Use project hooks (`.claude/settings.local.json`) since `--plugin-dir` isn't available there.
2. Repeat S1 steps 2 and 4.
3. Add hooks on `Stop` and `SessionEnd` that append a timestamp to `/tmp/spike-events.log`, e.g. `"command":"sh","args":["-c","echo \"$(date) stop\" >> /tmp/spike-events.log"]`. Does Stop fire every turn? Does SessionEnd fire when you **close the window**, archive the session, or quit the app?
4. Write a new `SKILL.md` into `~/.claude/skills/spike-skill/` mid-session. Is it picked up without a restart? Repeat with `.claude/skills/` when that folder didn't exist at session start.

### S6: Codex hooks

Follow the Codex hooks docs (learn.chatgpt.com/docs/hooks) for the file format. In `~/.codex/hooks.json` or a scratch repo's `.codex/hooks.json`:

1. **SessionStart** returning `additionalContext` ("Paceline: 0 unread"). Does the model see it?
2. **PreToolUse** that returns `deny` for any write to `AGENTS.md`. Is the write actually blocked? Also try `ask`: we expect it to be unsupported and let the call through, so confirm.
3. **PostToolUse** on a failing shell command, returning `additionalContext`. Is it shown next to the error?
4. **SessionEnd** that sleeps 2 s, then 4 s. Is it killed, and what is `reason`?
5. **Stop** returning a block with a reason. Confirm it becomes a new *user* prompt; we won't use this, just document it.
6. **Trust flow**: what does `/hooks` ask before untrusted hooks run? Do hooks run under `codex exec "…"` (non-interactive)?

### S16: Does `requiresUserInteraction` force a prompt?

1. Make a tiny MCP server with one tool marked `_meta: { "anthropic/requiresUserInteraction": true }` (mcp-use: `import { MCPServer } from 'mcp-use'`; or the plain MCP SDK if mcp-use won't pass `_meta` through).
2. Connect it to Claude Code, both as a plugin MCP server and via `claude mcp add`. Call the tool in each permission mode: default, acceptEdits, bypassPermissions.
3. Does a native prompt appear every time, even in bypassPermissions? Does an allow rule skip it? What happens under `claude -p`? Check the desktop app too.

### S3: Manufact Cloud (free plan)

1. Scaffold a hello mcp-use server and deploy it with `npx mcp-use deploy`. Record the URL format.
2. **Cold start**: how long does the first call take after more than 10 minutes idle?
3. **Header pass-through**: add a tool that echoes its request headers. Do `Authorization` and a custom `X-Paceline-Test` arrive?
4. **Egress**: can a tool `fetch('https://httpbin.org/get')`?
5. **401 behavior**: return HTTP 401 with a `WWW-Authenticate` header from middleware. What does Claude Code show? What does claude.ai show?
6. Can a monorepo subfolder (`apps/mcp`) be deployed? Can you set a custom domain and env vars?
7. What are the free plan's real limits (requests per month, scale-to-zero, number of projects)?

### S4: Supabase OAuth on the Free plan (after section 1)

0. **Is the OAuth 2.1 server available on the Free plan at all?** If not, write that down first; we'd fall back to Better Auth running inside our own server.
1. With the OAuth 2.1 server enabled, register a client (dynamic client registration) and complete the authorize flow once. Our consent page doesn't exist yet, so use the default or a stub URL.
2. Decode the access token. Which claims are present (`sub`, `role`, **`client_id`?**, `aud`)? Which scopes can be requested beyond `openid email profile`?
3. Check **Realtime** on the Free plan: from a small Node script using `@supabase/supabase-js`, subscribe to a broadcast channel and send to it from SQL with `select realtime.send('{"n":1}'::jsonb, 'ping', 'agent:test', false);`. Does the message arrive, and how fast? Note the concurrent-connection limit.
4. Check **free embeddings**: deploy a tiny Edge Function that runs `new Supabase.ai.Session('gte-small')` on a sentence (`mean_pool: true, normalize: true`). Does it return 384 numbers, and how long does it take?
5. Optional, once S3 works: connect claude.ai (custom connector), ChatGPT and `codex mcp login` to a hello server using `oauthSupabaseProvider` from `mcp-use/oauth/supabase`, and note what breaks.

### Result template

```markdown
# S1: asyncRewake idle wake
- Date / tester:
- Versions: Claude Code x.y.z (CLI) / Desktop a.b.c / Codex …
## Question
## Setup (files, commands)
## What happened (observations, timings, screenshots)
## Decision
Default: … / Fallback: …
```

---

## 3. Seed content (cold start)

Write 15–20 **real, recent gotchas** that models still get wrong, one JSON file each, as `seeds/highlights/<slug>.json`. They make search useful on day one and double as eval material. Ideas:
- mcp-use v2 API (`server.tool`, `export default server`, no `useWidget`).
- Next.js 16 renamed `middleware.ts` to `proxy.ts`.
- The Claude Code SessionEnd hook's 1.5 s budget.
- Opus/Sonnet 5.5 rejecting forced `tool_choice`.
- Haiku 5.5 rejecting `temperature`.
- Neon `pg_search` being retired.
- The pgvector HNSW index being used only with `ORDER BY <=> LIMIT`.

Format (matches `Highlight` in `docs/UI.md` §4; leave out ids and server-side counters):
```json
{
  "kind": "gotcha",
  "title": "Next.js 16 renamed middleware.ts to proxy.ts",
  "summary": "In Next 16 the middleware file is proxy.ts; middleware.ts is ignored with no error.",
  "body": {
    "problem": "Auth redirects silently stop working after upgrading to Next 16.",
    "steps": ["Rename middleware.ts to proxy.ts", "Rename the exported function to proxy"],
    "pitfalls": [{ "tried": "Keeping middleware.ts with a matcher", "whyFailed": "Next 16 never loads it" }],
    "verification": "A request to a protected route redirects to /login again.",
    "appliesWhen": "next@16 and later",
    "notAppliesWhen": "next@15 and earlier"
  },
  "tags": ["next@16", "middleware", "auth"],
  "sources": ["https://nextjs.org/docs/…"]
}
```
Only include facts you've checked against current docs, and put the source URLs in `sources`.

---

## 4. Outreach (if time is left)

- [ ] Line up 2–3 friendly teams who use Claude Code and/or Codex to pilot in M8.
- [ ] Ask the Manufact organizers whether entries must run on Manufact Cloud. Ask the Armature organizers what before/after baseline they want to see.
- [ ] Check that the name "Paceline" is free (trademark, npm scope `@paceline`, domain, GitHub org).
