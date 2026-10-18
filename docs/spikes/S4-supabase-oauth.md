# S4: Supabase OAuth on the Free plan (after section 1)

- **Date / tester:** 2026-10-17 / laurence (driven from a Claude Code agent session)
- **Versions:** n/a — no Supabase project exists yet. Client side: Claude Code **2.1.302**, `mcp-use` **2.10.1**
- **Status: BLOCKED on the account, but the plan question it depended on is answered, and it is good news.**

## Question

Per [README.md](README.md) §S4: **step 0** — is the OAuth 2.1 server available on the Free plan at all (else fall
back to Better Auth in our own server)? Then: can we register a client via Dynamic Client Registration and
complete an authorize flow; what claims does the access token carry (`sub`, `role`, **`client_id`?**, `aud`);
**step 3** Realtime on Free; **step 4** free `gte-small` embeddings; and optionally whether claude.ai, ChatGPT and
`codex mcp login` connect using `oauthSupabaseProvider`.

## Step 0 — answered: yes, it is on the Free plan. No Better Auth fallback needed.

This was the question that could have forced a redesign, so it is the headline.

**The Supabase OAuth 2.1 Server is available on every plan including Free, at no separate charge**, and its
**Dynamic Client Registration** endpoint — `POST /oauth/clients/register` (RFC 7591) — is a **per-project toggle
with no plan gate**. Proceed as designed; do not build the Better Auth fallback.

Two caveats: it is still in **public beta** (since 2025-11-26, no GA as of 2026-10-17), and a Free project that
sees too little database activity over a week is **auto-paused**, which takes the authorization server offline
with it. That is the operational risk to plan for, not a missing feature. See
[00-accounts-and-keys.md](00-accounts-and-keys.md).

This is documentation research, not a live check against our own project — which is why the rest of S4 is still
blocked.

## Why the rest is blocked

S4 is explicitly gated on section 1, and the Supabase project does not exist. Creating it needs an interactive
signup on your identity (email verification, then a GitHub OAuth app under your GitHub account), which I cannot
and should not do. See [00-accounts-and-keys.md](00-accounts-and-keys.md) for the runbook.

Nothing in S4 can be faked usefully: token claims and the scope list are properties of a live project.

## Steps 3 and 4 — researched, but they need live measurement

Both steps ask for a *measurement* (does the broadcast arrive and how fast; does `gte-small` return 384 numbers
and how long does it take), so neither can be closed without the project. What the documentation establishes:

**Step 3 — Realtime Broadcast on Free.** Available, including broadcast-from-the-database via
`realtime.send(...)`; it is metered rather than gated. Free ceilings: **200 concurrent connections**,
**100 messages/second**, 100 channel joins/second, **256 KB** payload (Pro: 3,000 KB), and an org-wide
**2 million messages/month**. The sizing trap is that **one broadcast to N subscribers bills as 1 + N messages**,
so a 20-person room costs 21 messages per event — worth modelling before we put per-keystroke or per-tool-call
events on a channel. Latency is unmeasured.

**Step 4 — `gte-small` embeddings.** `new Supabase.ai.Session('gte-small')` runs locally inside the Edge
Function with no external API and no AI line item on any plan, Free included, and nothing in the docs, changelog
or edge-runtime source deprecates it. It produces **384-dimension** vectors. Traps: it is the **only** built-in
model (any other name silently falls back to an external Ollama host via `AI_INFERENCE_API_HOST`), inputs
**truncate at 512 tokens**, and it is English-only; the real ceiling on Free is the **2 s CPU / 256 MB** per-request
limit, not pricing. The 384 count and the latency still need the live check. Schema consequence —
`vector(384)` — is in [00-accounts-and-keys.md](00-accounts-and-keys.md).

## Client-side behaviour is already verified

This half is done, from [S3](S3-manufact-cloud.md) §5. Against a server returning
`401` with `WWW-Authenticate: Bearer error="invalid_token", …, resource_metadata="…"`, Claude Code walked the
whole discovery chain unprompted:

```
GET  /mcp                                      → 401
POST /mcp                                      → 401
GET  /.well-known/oauth-protected-resource     ← followed from resource_metadata
GET  /.well-known/oauth-authorization-server   ← then AS metadata
```

So the RFC 9728 → RFC 8414 path this design assumes is real in 2.1.302, and the harness reports
*"The following MCP servers require authentication before their tools can be used"*, with `/mcp` as the sign-in
route (`⚠ 1 MCP server needs authentication · run /mcp` in the TUI). Non-interactive sessions cannot complete
sign-in, which matters for our eval harness and any CI usage.

`mcp-use` 2.10.1 does export the provider the plan calls for: `mcp-use/oauth/supabase` is a real export path
(alongside `auth0`, `better-auth`, `clerk`, `convex`, `keycloak`, `scalekit`, `workos`), so step 3's
`oauthSupabaseProvider` import is sound.

## Runbook to finish S4 (~45 min once the project exists)

1. Create the project and the GitHub OAuth app, and enable **OAuth Server** + **Dynamic Client Registration** —
   steps 3 and 4 of [00-accounts-and-keys.md](00-accounts-and-keys.md).
2. Confirm discovery is live:
   ```
   curl -s https://<ref>.supabase.co/.well-known/oauth-authorization-server | jq .
   ```
   Record `issuer`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint`,
   `scopes_supported`, `code_challenge_methods_supported`.
3. Register a client dynamically:
   ```
   curl -s -X POST https://<ref>.supabase.co/oauth/clients/register \
     -H 'Content-Type: application/json' \
     -d '{"client_name":"paceline-spike","redirect_uris":["http://127.0.0.1:8765/callback"],
          "grant_types":["authorization_code","refresh_token"],"response_types":["code"],
          "token_endpoint_auth_method":"none"}' | jq .
   ```
   Record `client_id`, whether a secret is issued, and whether `token_endpoint_auth_method: "none"` (public
   client + PKCE, which is what MCP clients use) is accepted.
4. Complete one authorize flow with PKCE against `http://127.0.0.1:8765/callback`. The consent page does not
   exist yet, so the default/stub is fine — the point is to obtain a real token.
5. **Decode the access token and answer the claims question** — this is the part the design is waiting on:
   ```
   echo "$ACCESS_TOKEN" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null | jq .
   ```
   Record exactly which of `sub`, `role`, **`client_id`**, `aud`, `iss`, `exp`, `scope`, `aal`, `session_id` are
   present. **`client_id` is the load-bearing one:** if the token does not identify *which registered client*
   is calling, `apps/core` cannot attribute an action to a specific agent install from the token alone, and we
   need a second mechanism (a Paceline-issued token in the `Authorization` header — confirmed to pass through
   Manufact intact in [S3](S3-manufact-cloud.md) §3 — or a server-side client registry keyed another way).
   Write the answer into this file; the core owner needs it before the auth middleware is built.
6. Record which scopes beyond `openid email profile` the server accepts, and what a request for an unknown scope
   does (ignored vs rejected).
7. **Step 3 (Realtime):** from a small Node script using `@supabase/supabase-js`, subscribe to a broadcast
   channel and send to it from SQL with
   `select realtime.send('{"n":1}'::jsonb, 'ping', 'agent:test', false);`. Record whether it arrives and how
   fast, and sanity-check the 200-connection ceiling above.
8. **Step 4 (embeddings):** deploy a tiny Edge Function running
   `new Supabase.ai.Session('gte-small')` on a sentence with `mean_pool: true, normalize: true`. Confirm it
   returns **384** numbers and record the latency and CPU time against the 2 s limit.
9. Optional, once a Supabase project exists: redeploy the S3 hello server with `oauthSupabaseProvider` from
   `mcp-use/oauth/supabase` and connect claude.ai (custom connector), ChatGPT, and `codex mcp login`, noting
   what breaks. **What claude.ai shows for a 401 is still open** — it needs a browser with a logged-in claude.ai
   session, so it is a human step.

## Decision

**Default:** proceed as planned — Supabase as the OAuth 2.1 provider with DCR, on the **Free** plan. Step 0 is
answered, so **do not build the Better Auth fallback**. The client half of the contract is verified; the
token-claims detail is the one real unknown.

**Fallback (and the thing to decide early):** if the access token carries no `client_id`, do not try to work
around it in the token. Issue a Paceline-scoped credential at install time and send it in `Authorization`
alongside the Supabase identity — S3 proved custom headers and `Authorization` survive the hosting path intact.
That keeps "which install is this" independent of whatever Supabase's beta token shape settles on.

**Risk to track:** the OAuth server is in public beta and Free projects auto-pause. Neither blocks M0, both
bite in a pilot.
