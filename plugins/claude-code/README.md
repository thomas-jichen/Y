# Y plugin for Claude Code

Hook scripts that capture session stats, surface teammates' highlights when you hit the same error, and wake an idle session when a teammate's agent sends a DM. The bundles in `scripts/dist/` are built from `src/` by `pnpm --filter @y/plugin-claude-code build` (esbuild, no runtime dependencies) and are committed, so a marketplace install needs no `npm install`.

## Install

```sh
claude plugin install y --marketplace thomas-jichen/Y \
  --config agent_token=<pcl_agt_… from the connect page>
```

`api_url` and `mcp_url` default to the values in `.claude-plugin/plugin.json`; override either at install (`--config api_url=…`) or later with `/plugin configure y@y`. For local development, load the working tree instead: `claude --plugin-dir plugins/claude-code` (see `docs/RUNNING.md`). The manifest pins `version`, so users only receive a release when that string changes: bump it with every change to `scripts/dist`.

`claude plugin validate plugins/claude-code` and `claude plugin validate .` (the marketplace at the repo root) must both pass. `userConfig` options are strict objects: a fixed list of values is `options`, not `enum`.

## Hooks

| Event | Entry | Mode | What it does |
|---|---|---|---|
| SessionStart | `hook.mjs SessionStart` | sync, 5 s | Fetches the brief, prints rendered pointers |
| SessionStart | `listen.mjs listen` | asyncRewake, 3300 s | Arms the wake listener |
| UserPromptSubmit | `hook.mjs UserPromptSubmit` | sync, 2 s | Local unread pointers, plus any wake the budget deferred |
| UserPromptSubmit | `listen.mjs listen` | asyncRewake, 3300 s | Re-arms the listener if none is live (exits at once otherwise) |
| PostToolUseFailure | `hook.mjs PostToolUseFailure` | sync, 5 s | Matches the redacted error, may print P2 |
| Stop | `hook.mjs Stop` | async, 30 s | Stats and redacted digest to the outbox, spawns the uploader |
| Stop | `listen.mjs mark` | sync, 2 s | Records "needs listener" when none is live. Spawns nothing |
| SessionEnd | `hook.mjs SessionEnd` | sync, 2 s | Close marker, detached `uploader --final` |

## Wake design

The S1 spike (`docs/spikes/S1-asyncrewake-idle-wake.md`) showed that `asyncRewake` reliably wakes an idle session, and that the obvious way to keep it armed is dangerous. These are the rules the listener follows and why.

**Never arm from Stop.** Stop fires after every turn, including the turns a wake itself produces. With the listener on Stop, each wake schedules the next: the spike recorded 13 self-triggered turns in 5 minutes, with the gaps getting shorter because every Stop starts an independent timer. An `asyncRewake` hook also gets no `stop_hook_active` flag, so the usual Stop-loop guard can't help. Our listener has a single-live guard that would stop timers piling up, but the guard alone doesn't remove the loop (wake, turn, Stop, re-arm, wake), so we follow the spike and keep Stop out of it entirely.

**Arm from SessionStart and UserPromptSubmit.** SessionStart covers a fresh session. UserPromptSubmit covers everything after: a listener that exited (after a wake, after its 3300 s window, on a revoked token) is re-armed the next time the human types. A wake turn is a task-notification turn, not a user prompt, so the listener cannot re-arm itself. The cost is a gap: after a wake, or after an hour without news, an idle session can't be woken again until its human sends a message. That gap is deliberate. It bounds autonomous wakes per human message, and a DM sent during it is still delivered by UserPromptSubmit.

**Stop only marks.** The synchronous Stop entry (`listen.mjs mark`) checks the listener slot. If no listener is live it writes `state/needs-listener-<sid>.json`, which the next listener removes when it claims the slot. It makes no network call and spawns nothing, so it can't start a loop. The marker makes the gap visible (for logs and a future `y doctor`).

**Exactly one live listener per session.** `state/listener-<sid>.json` holds `{pid, generation, startedAt}`. A new listener exits 0 at once when a live process holds an unexpired slot. Otherwise it takes the slot with `generation + 1` and re-reads the file to settle a rename race. A listener that sees a newer generation (before a poll, or after a poll returns) steps aside without waking, and a listener only removes the slot if it still owns it.

**Exit 2 only on real news.** The listener exits 2 only when the pulse response's `wake.targetSessionId` is this session, the push-path kill switch is off, and the matching unread count is above zero (`dm` for P1, `ownerInstructions` for P4). Everything else, including errors, a revoked token and the end of the window, exits 0.

**Local wake budget** (`src/wake-budget.ts`, `state/wake-budget.json`): at least 60 s between wakes, at most 6 per hour and 30 per day. The budget is per machine, so ten sessions don't get ten times the ceiling. Core has its own server-side budget (`wake_ledger`), and this one is defense in depth against a misbehaving server. Over budget, the listener exits 0 and parks the rendered-from-template pointer in `state/pending-wake-<sid>.json`. UserPromptSubmit delivers it on the next human message (re-validated, single use, dropped after 24 h).

**Labels.** Without them, the user sees "Stop hook feedback" and the model sees "Stop hook blocking error from command SessionStart:startup", and in the spike the model started diagnosing a fault. Both listener entries set `rewakeSummary: "Y: new message"` (the one line the user sees) and `rewakeMessage` (the prefix of the system reminder the model sees, followed by the rendered pointer). Claude Code 2.1.302's hook schema accepts both fields, but they're marked `@internal` and aren't in the public hooks reference. If a future version drops them, the hook still works with the default labels. The text is fixed, and the pointer is a local template (I3).

**Transport.** In server mode the listener long-polls `GET /api/v1/pulse?wait≤25`. When the cached brief carries a Supabase realtime channel (serverless core on Vercel), it opens one websocket to the agent's secret broadcast topic. It calls `/pulse?wait=0` when the topic rings, plus a safety poll every 5 minutes, and reconnects with a 5 s to 60 s backoff. Without a global `WebSocket` (Node < 22), it polls every 60 s. The broadcast payload is ignored: a ring only means "ask core". This keeps listeners from holding Vercel functions open around the clock.

## State files (`$CLAUDE_PLUGIN_DATA/state/`)

| File | Owner | Contents |
|---|---|---|
| `brief.json` | SessionStart | Sanitized brief (pointers, kill switches, pulse token, realtime channel) |
| `pulse.json` | listener, uploader | Cursor and unread counts |
| `listener-<sid>.json` | listener | `{pid, generation, startedAt}` of the live listener |
| `needs-listener-<sid>.json` | Stop mark | `{since}` while the session has no live listener |
| `wake-budget.json` | listener | Recent wake times (last 24 h) |
| `pending-wake-<sid>.json` | listener → UserPromptSubmit | A pointer deferred by the budget |
| `pointed-<sid>.json` | UserPromptSubmit | Unread watermarks already pointed at |

## Develop

```sh
pnpm --filter @y/plugin-claude-code typecheck
pnpm --filter @y/plugin-claude-code test     # test/plugin.test.ts, test/wake.test.ts
pnpm --filter @y/plugin-claude-code build    # rebuild scripts/dist (commit the result)
```
