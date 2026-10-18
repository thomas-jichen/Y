# S3: Manufact Cloud

- **Date / tester:** 2026-10-17 / laurence (driven from a Claude Code agent session)
- **Versions:** `mcp-use` **2.10.1** (CLI + library) · Node **24.21.0** · Claude Code **2.1.302** (for the client-side 401 check)
- **Account:** org `Primary` (`org-6c1711a6-cv6rx`), `npx mcp-use whoami` → `<Laurence's account> — Primary`
- **Verdict: PASS.** Deploy works, headers pass through intact, egress is open, and Claude Code handles a 401 challenge correctly.

## Question

Can we deploy a hello MCP server to Manufact Cloud, and does it behave well enough to host `apps/mcp`:
URL format, cold start, header pass-through, outbound network, 401/OAuth behaviour, monorepo subfolder,
custom domain, env vars.

## Setup (files, commands)

`/tmp/spike-s3`, `mcp-use@2.10.1`, `zod@4`, entry `src/index.ts`, three tools:

- `hello` — returns `bootedAt` (a module-level constant) + `msSinceBoot` + `pid`, so any call reveals whether it
  hit a fresh instance. This is the cold-start probe.
- `echo_context` — returns the inbound HTTP headers.
- `egress_test` — `fetch('https://httpbin.org/get')`.

```ts
import { MCPServer } from 'mcp-use';
const server = new MCPServer({ name: 'spike-s3-hello', version: '0.0.1', description: '…' });
server.tool({ name: 'hello', description: '…', inputSchema: z.object({ name: z.string().optional() }) },
  async ({ name }) => ({ content: [{ type: 'text', text: JSON.stringify({ … }) }] }));
export default server;
```

Deployed with **managed upload** rather than the default GitHub mode, to avoid creating a repo in the org's
GitHub for a throwaway:

```
npx mcp-use build
npx mcp-use deploy --no-github --json --name spike-s3-hello
```

## What happened

### 1. Deploy and URL format: works

First deploy returned immediately with `status: "pending"`, and the server was `running` within ~2 min:

```json
{"sourceType":"managed","serverId":"8b15b667-c3de-48fc-8471-958c30cd4aee",
 "deploymentId":"e258f494-37f2-4474-ba47-8f50840422bd","status":"pending",
 "webUrl":"https://manufact.com/cloud/org-6c1711a6-cv6rx/servers/8b15b667-c3de-48fc-8471-958c30cd4aee/overview"}
```

**URL format is `https://<auto-slug>.run.mcp-use.com/mcp`.** Ours: `https://dark-pulse-wfxp7.run.mcp-use.com/mcp`.

The slug is **generated, not derived from `--name`** — we passed `spike-s3-hello` and got `dark-pulse-wfxp7`.
Don't hard-code or predict it; read `mcpUrl` from `mcp-use servers list --json`. Relevant fields:

```json
{ "slug": "dark-pulse-wfxp7", "name": "spike-s3-hello", "status": "running",
  "mcpUrl":   "https://dark-pulse-wfxp7.run.mcp-use.com/mcp",
  "chatUrl":  "https://dark-pulse-wfxp7.run.mcp-use.com/chat",
  "gatewayDomain": "run.mcp-use.com", "customDomainCnameTarget": "deploy.mcp-use.com",
  "publicRoutingMode": "gateway", "region": "AUTO", "domains": [] }
```

Transport is streamable HTTP, responses framed as SSE (`event: message` / `data: {…}`). The server is
**stateless** — `tools/list` and `tools/call` work with no `Mcp-Session-Id` (none is even issued), which matches
mcp-use's "stateless MCP servers with a Web-standard Fetch boundary" design. Good for us: no sticky sessions to
reason about.

Redeploy took **~80–100 s** to roll over to the new build; the old build keeps serving until it does.

### 2. Cold start

Cold-start measurement is recorded in the appendix below. Warm numbers for reference: first `initialize` on a
~7-min-old instance **1277 ms**; subsequent `tools/call` **408 ms**; `egress_test`'s own outbound fetch 111 ms.
An instance was still serving with `msSinceBoot` ≈ 438 s, so instances survive at least ~7 min of idle.

### 3. Header pass-through: **both arrive intact**

Sent `Authorization: Bearer y-test-token-123456789` and `X-Y-Test: hello-from-s3`:

```json
{ "authorizationArrived": true,
  "authorizationValue": "Bearer pacel…(36 chars)",
  "xYTest": "hello-from-s3" }
```

So we can carry a Y bearer token and our own metadata headers end to end. Reading them in mcp-use is
**`ctx.req.header('x-y-test')`**; `ctx.request` is a Hono request wrapper (`{raw, routeIndex, path,
bodyCache}`), so the full set is `ctx.request.raw.headers`. Not `ctx.headers`, which does not exist — this cost a
redeploy cycle to find, so note it for `apps/mcp`.

The forwarded header set also fingerprints the platform:

```json
{ "cf-worker": "mcp-use.com", "cf-ray": "a4c435b81cd1981a-SJC", "cf-connecting-ip": "…",
  "via": "1.1 fly.io, 1.1 fly.io", "x-forwarded-host": "dark-pulse-wfxp7.run.mcp-use.com",
  "x-forwarded-proto": "https", "x-request-start": "t=1792291557743410" }
```

plus `fly-request-id`, `fly-region`, `fly-forwarded-proto`. **Manufact Cloud is Fly.io behind a Cloudflare
Worker.** Two things follow. A Cloudflare Worker in front means Worker request limits and timeouts apply to us,
not just the origin's. And since §1 now rules out a Fly.io account of our own (the core API goes on Vercel
Hobby), `apps/mcp` on Manufact and the core API on Vercel are in different clouds — so the
`apps/mcp` → `apps/core` hop is public internet, not same-region. Egress is open (§4), so it works; just do not
assume single-digit-millisecond latency between them.

### 4. Egress: open

```json
{ "ok": true, "target": "https://httpbin.org/get", "status": 200, "ms": 111 }
```

A tool can reach the public internet. No allow-list to configure, at least on this plan.

### 5. 401 + `WWW-Authenticate`: Claude Code does the right thing

Tested against a local server that always 401s with an OAuth-shaped challenge (faster than redeploying, and this
is a *client* question):

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token", error_description="No authorization provided",
                  resource_metadata="http://127.0.0.1:4111/.well-known/oauth-protected-resource"
```

Claude Code **followed the whole discovery chain**, in this order:

```
GET  /mcp                                        auth=no
POST /mcp                                        auth=no
GET  /.well-known/oauth-protected-resource       auth=no
GET  /.well-known/oauth-authorization-server     auth=no
```

So it honours `resource_metadata` from the challenge and then fetches authorization-server metadata — the
RFC 9728 → RFC 8414 path our Supabase OAuth design depends on. In the session it reported:

> The following MCP servers require authentication before their tools can be used: s3auth

and, being non-interactive, that the OAuth sign-in could not run there. The fix it names is `/mcp` in an
interactive session. The TUI shows this as `⚠ 1 MCP server needs authentication · run /mcp`.

**What claude.ai shows is not covered here** — that is a browser flow against a public URL and needs a human with
a logged-in claude.ai session. Carried into [S4](S4-supabase-oauth.md).

### 6. Monorepo subfolder, custom domain, env vars

Established from the CLI contract and the server record rather than by burning extra deploys:

- **Subfolder:** `mcp-use deploy --root-dir <path>` sets the project root inside the repo/upload, so
  `apps/mcp` is deployable. Also `--branch`, `--watch-paths <glob>` for auto-deploy path filters, and
  `--wait-for-ci`.
- **Custom domain:** supported — the server exposes `customDomainCnameTarget: "deploy.mcp-use.com"` and an empty
  `domains: []`. Point a CNAME at that target. Not exercised (no spare domain, and see the name finding).
- **Env vars:** `mcp-use deploy --env KEY=VALUE` (repeatable) and `--env-file <path>`, plus
  `mcp-use servers` for managing them on an existing server. The server record carries an `environments` array
  with a `production` entry.

### 7. Free-plan limits (§1's added question)

Partly answered, and the gap is worth stating plainly. **Measured:** one server deploys and runs on the free
tier; instances are **not** scaled to zero at ten minutes idle (§2 — an instance survived 11 minutes with the
same pid); redeploys roll over in ~80–100 s. **Not established:** any published request-per-month quota,
concurrent-instance cap, or project count limit — these are not exposed in the CLI's server record and we did
not find a figure we would be willing to quote. Treat "no cold start at 11 min" as the one hard datum and get
the quotas from Manufact directly — which pairs with the organiser question already in §4 of the task doc.

## Decision

**Default: host `apps/mcp` on Manufact Cloud.** It clears every requirement we actually have — stateless HTTP
transport, `Authorization` pass-through for Y tokens, open egress for calling `apps/core`, a sane 401/OAuth
story on the Claude Code side, subfolder deploys for the monorepo, and custom domains when we want one.

Build notes for whoever owns `apps/mcp`:

- Read headers with `ctx.req.header(name)`; `ctx.headers` does not exist.
- Never hard-code the deploy URL — read `mcpUrl` from `mcp-use servers list --json`; the slug is generated.
- Expect ~80–100 s of old-build serving after a deploy, so treat deploys as non-atomic and keep tool contracts
  backward-compatible across one release.
- Keep `MCP_USE_API_KEY` / `MCP_USE_ORG` out of the repo (already in `.gitignore`); CI authenticates with
  `npx mcp-use login --api-key "$MCP_USE_API_KEY" --org "$MCP_USE_ORG"`.

**Fallback:** `apps/mcp` is a plain stateless fetch handler, so if Manufact's Worker-layer limits bite it ports
to wherever the core API lives — Vercel Hobby, per §1 — with no architectural change, which would also collapse
the cross-cloud hop noted in §3. That is a deployment swap, not a rewrite: do not let anything Manufact-specific
leak past the serving boundary. Note the Manufact track is a deliverable in its own right, so moving off it is a
last resort, not a convenience.

## Appendix: cold start after >10 min idle

Left the server untouched for **11 minutes**, then called `hello` (which reports a module-level `bootedAt`, so a
restart is unmissable):

| measurement | value |
|---|---|
| idle before the call | 11 min |
| first-call latency after idle | **1824 ms** |
| `msSinceBoot` reported | **727 253 ms** (12.1 min) |
| `pid` | 657 — *same pid as before the idle window* |
| immediate second call | 555 ms, same pid |

**There was no cold start.** The instance survived 11 minutes of idle: same process, uptime tracking real elapsed
time. The first call cost ~1.3 s more than the warm baseline (1824 ms vs 555 ms), which is the gateway/TLS path
warming rather than a container boot — a boot would have reset `bootedAt` and `pid`.

Two caveats on how far to trust this. It is a single observation on a free-tier server that had been deployed
~12 minutes earlier, so it establishes "instances are not aggressively reaped at 10 minutes" rather than a
guaranteed floor; Manufact publishes no idle-eviction policy we verified. And the warm figures themselves
(400–555 ms for a trivial tool) are the number to design against: that is the per-call floor before any work,
on top of which `apps/core` round-trips are added.

**Implication:** we do not need a keep-alive pinger for the ~10-minute case, but the inbox-poll path should still
tolerate a ~2 s first call after a quiet period, and nothing user-facing should block on it.
