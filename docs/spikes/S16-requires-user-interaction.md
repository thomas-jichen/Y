# S16: Does `requiresUserInteraction` force a prompt?

- **Date / tester:** 2026-10-17 / laurence (driven from a Claude Code agent session)
- **Versions:** Claude Code **2.1.302** (CLI, `claude --version`) · `@modelcontextprotocol/sdk` **1.32.1** · macOS 27.0.1
  - (A second, older install exists on this machine at `/usr/local/bin/claude` = 2.1.240. All S16 runs used 2.1.302, first on `PATH`.)
- **Verdict: YES — and it is stronger than "a prompt appears".** The flag makes a tool **unusable without a live human**: no permission mode and no allow rule can satisfy it, and in headless mode the call is denied outright.

## Question

Does a tool advertising `_meta: { "anthropic/requiresUserInteraction": true }` always force an approval prompt —
even in `bypassPermissions`? Does an explicit allow rule skip it? What happens under `claude -p`?

## Setup (files, commands)

A stdio MCP server (`/tmp/spike-s16/server.mjs`) on the plain MCP SDK, exposing **two near-identical tools** so
the flag is the only variable:

| tool | `_meta` |
|---|---|
| `needs_interaction` | `{ "anthropic/requiresUserInteraction": true }` |
| `plain_control` | *(none)* |

Both take an optional `note` and return the fixed string `S16-OK:<tool>`. The server appends every
`tools/call` it receives to `/tmp/spike-s16/calls.log` — **that log, not the model's prose, is the ground truth
for whether a call actually executed.**

Verified the flag survives the wire: `tools/list` returns
`{"name":"needs_interaction","_meta":{"anthropic/requiresUserInteraction":true}}`.

Probe method. `--permission-prompts none` means "nobody answers prompts; anything that would prompt is denied
automatically", which turns an interactive question into a programmatic signal:

```
claude -p "Call the <tool> tool …" \
  --mcp-config '{"mcpServers":{"spike-s16":{"command":"node","args":["/tmp/spike-s16/server.mjs"]}}}' \
  --strict-mcp-config --permission-mode <mode> --permission-prompts none --output-format json
```

`--strict-mcp-config` keeps the machine's other MCP servers out of the run; no user config was modified.

## What happened

### Headless matrix (`claude -p`, `--permission-prompts none`)

"Server saw call" = a `tools/call` line appeared in the server log.

| permission mode | tool | allow rule | server saw call | result |
|---|---|---|---|---|
| `default` | `needs_interaction` | — | no | **BLOCKED** |
| `default` | `plain_control` | — | no | BLOCKED |
| `acceptEdits` | `needs_interaction` | — | no | **BLOCKED** |
| `acceptEdits` | `plain_control` | — | no | BLOCKED |
| `bypassPermissions` | `needs_interaction` | — | no | **BLOCKED** |
| `bypassPermissions` | `plain_control` | — | **yes** | ALLOWED → `S16-OK:plain_control` |
| `default` | `needs_interaction` | `--allowedTools mcp__spike-s16__needs_interaction` | no | **BLOCKED** |
| `bypassPermissions` | `needs_interaction` | `--allowedTools mcp__spike-s16__needs_interaction` | no | **BLOCKED** |
| `default` | `plain_control` | `--allowedTools mcp__spike-s16__plain_control` | **yes** | ALLOWED → `S16-OK:plain_control` |

Read the control rows first: `plain_control` sails through in `bypassPermissions`, and an allow rule is enough for
it in `default` mode. So the mechanism being tested is isolated to the `_meta` flag.

Three answers fall out:

1. **`bypassPermissions` does not skip it.** Same mode, same session shape, control allowed, flagged tool denied.
2. **An explicit allow rule does not skip it.** `--allowedTools` on the exact tool name changes nothing, in
   either mode. The same rule works on the control tool.
3. **Under `claude -p` with nobody to ask, the call is simply denied.** It never reaches the server.

### Interactive, via a plugin-bundled MCP server

Plugin `/tmp/spike-s16-plugin` with `.claude-plugin/plugin.json` and
`.mcp.json` → `{"mcpServers":{"s16plug":{"command":"node","args":["/tmp/spike-s16/server.mjs"]}}}`, loaded with
`--plugin-dir`, session driven through a pty in `default` mode. The model was told "do not ask me first, just
call it".

A native approval card appeared and the call sat pending until the session was torn down (`tools/list` reached the
server at 02:29:07; no `tools/call` ever did):

```
Calling plugin:spike-s16-plugin:s16plug…
──────────────────────────────────────────── Tool use  plugin:spike-s16-plugin:s16plug — Needs Interac…
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ About the plugin:spike-s16-plugin:s16plug — Needs Interac…
```

The card is labelled **"Needs Interaction"**. Plugin-bundled and `claude mcp add`-style config behave
identically — the flag travels with the tool descriptor, not the registration route.

### Supporting evidence from the binary

2.1.302 recognises `anthropic/requiresUserInteraction` and gates one-tap approval on it: *"True when one-tap
Approve/Deny must not be offered: the tool's approval card IS the user-interaction surface (the user responds on
the card itself) … which no stored grant or automatic approval may answer."* That phrasing — *no stored grant or
automatic approval may answer* — is precisely what the allow-rule and bypass rows show. There is also a sibling
`anthropic/permissionDisplay` (`title` / `description` / `displayName`) for putting our own words on that card.

`bypassPermissions` interactively was not tested: this machine's sandbox policy refused to launch a nested
session in that mode. The headless row already answers the question, and more strictly.

## Decision

**Default: do not put `requiresUserInteraction` on any tool an agent must call on its own.** It is not "prompt
louder" — it is "a human must be present", and it fails closed. Any Y tool in the agent's own loop
(`inbox`, `read_dm`, `send_dm`, `publish_activity`) carrying this flag would break every headless run:
`claude -p`, CI, cron, and our own eval harness, all with a denial the agent cannot resolve.

Use it for exactly one thing: **the human-approval step.** `approve_proposed_change` — the moment where a
teammate's agent has proposed a setup change and a person must consent — is the right home for it, because its
semantics really are "this card is the consent surface, and no stored grant may pre-answer it". That also makes
the flag our enforcement point for "humans approve from the web or Slack": an agent cannot self-approve even
with `--dangerously-skip-permissions`.

Pair it with `anthropic/permissionDisplay` so the card reads as Y's own approval, not a generic MCP prompt.

**Fallback:** If we later want a soft "please confirm" that still works headless, don't reach for this flag —
model it in the tool's own contract (return an `input_required`-style result, or a two-call
`propose` → `confirm(token)` handshake) so a headless agent gets a well-formed refusal it can reason about
instead of a permission denial.

**Follow-up for the UI/desktop track:** confirm the card renders with our `permissionDisplay` strings in the
desktop app, and that `bypassPermissions` interactively behaves like the headless row (expected, untested here).
