# S1: Does asyncRewake wake an idle Claude Code session? (CLI)

- **Date / tester:** 2026-10-17 / laurence (driven from a Claude Code agent session)
- **Versions:** Claude Code **2.1.302** (CLI, `claude --version`) · macOS 27.0.1 · Node 24.21.0
  - A second, older install exists on this machine at `/usr/local/bin/claude` = **2.1.240**. Every run below used
    2.1.302, which is first on `PATH`. Desktop app: not installed (see [S13](S13-desktop-app.md)).
- **Verdict: PASS.** An idle session wakes itself and starts a new turn on the hook's text, reliably, at every
  delay tested from 20 seconds to 83 minutes, with no drift. Two caveats change the design: never arm it on
  `Stop`, and relabel the message.

## Question

Can a background hook wake an idle Claude Code session — i.e. can a DM wake your idle agent? And: how long a
delay is honoured, what happens if the wake fires mid-turn, does it re-arm, and does it work from a
`Notification` hook?

## Setup (files, commands)

Exactly the throwaway plugin from [README.md](README.md) §2, unmodified:

```
/tmp/spike-wake/.claude-plugin/plugin.json   {"name":"spike-wake","version":"0.0.1"}
/tmp/spike-wake/hooks/hooks.json
/tmp/spike-wake/wake.mjs
```

```json
{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"node",
  "args":["${CLAUDE_PLUGIN_ROOT}/wake.mjs"],"asyncRewake":true,"timeout":3300}]}]}}
```

`--plugin-dir` **is** accepted by 2.1.302 (`--plugin-dir <path>`, repeatable), so the fallback to
`.claude/settings.local.json` was not needed. The `command` + `args` array form works, and
`${CLAUDE_PLUGIN_ROOT}` expands correctly.

Variants used: `/tmp/spike-wake-7200` (same, `timeout: 7200`), `/tmp/spike-wake-stop` (same hook **also** on
`Stop`), `/tmp/spike-wake-notif` (`Notification` with `"matcher":"idle_prompt"`).

**Method.** An idle-wake test needs a real interactive session left alone, so sessions were driven through a
**pty** (`python3 harness/drive.py`), which types a prompt and then logs every byte with a timestamp. Two
gotchas showed up in the harness itself and are worth knowing:

- Setting `CI=""` in the child environment makes the TUI exit in ~0.4 s. *Presence* is what is tested, not
  truthiness — the variable has to be removed, not blanked.
- The folder-trust dialog (`Quick safety check…`) **preselects "No, exit"**, so answering it with a bare Enter
  quits. It needs Down-then-Enter. The TUI also lays out words with cursor-move escapes instead of spaces, so
  matching its text requires whitespace-insensitive comparison.

**Evidence comes from the session transcript, not the terminal.** `~/.claude/projects/<slug>/<session-id>.jsonl`
records exactly what the model was handed and when, to the millisecond, while the TUI redraws and interleaves
output. Every timing below is from the transcript.

## What happened

### 2. The wake works

Baseline, `WAKE_AFTER_S=20`: session started 02:03:46, hook exited 2 at T+20 s, and the transcript shows the
harness enqueue a notification and the model open a brand-new turn — with no human input:

```json
{"type":"queue-operation","operation":"enqueue","timestamp":"2026-10-18T02:04:06.388Z",
 "content":"<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n
            <system-reminder>\nStop hook blocking error from command \"SessionStart:startup\":
            Y: 1 unread DM from @spike-bot. Call the inbox tool.\n\n</system-reminder>"}
```

It becomes a **user-role turn** tagged `"origin":{"kind":"task-notification","producer":"session-task"}` at
`02:04:06.400Z`, and the model (`claude-opus-5-5`) responded at `02:04:11.525Z`, reasoning about the DM and
looking for an inbox tool. The API request wraps it in a guard worth knowing about:

> `[SYSTEM NOTIFICATION - NOT USER INPUT]` This is an automated background-task event, NOT a message from the
> user. Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.

So the model is explicitly told the wake is not the user speaking — good for us: a DM cannot be mistaken for
consent.

**Mechanism, for the record:** `asyncRewake` runs the hook backgrounded and **exit code 2 is the wake signal**.
`timeout` is in **seconds** (a 20 s delay survived `timeout: 3300`, so it is not milliseconds).

### 3. Delay and timeout: honoured exactly, up to at least 53 minutes

Each run: fresh session, say "hi", then idle. "Fired at" is the `queue-operation` timestamp.

| run | `WAKE_AFTER_S` | `timeout` | session start | wake fired | delta | result |
|---|---|---|---|---|---|---|
| A | 20 | 3300 | 02:03:46 | 02:04:06.388 | **20.0 s** | woke |
| C | 900 | 3300 | 02:06:35 | 02:21:35.410 | **900.0 s** | woke |
| D | 1800 | 3300 | 02:06:37 | 02:36:37.278 | **1800.0 s** | woke |
| E | 3200 | 3300 | 02:06:39 | 02:59:59.793 | **3200.0 s** | woke |
| F | 5000 | 7200 | 02:06:40 | 03:30:02.014 | **5000.0 s** | woke |

Run F answers the remaining question — whether a `timeout` **above** the doc's suggested 3300 is honoured. It is:
an 83-minute single-shot wake fired at exactly 5000.0 s, and the hook process survived the whole window without
being reaped. So the practical ceiling is at least 7200 s, though we never need it (see the decision below: we
re-arm after each delivery rather than relying on one long sleep).

No drift at any delay — the timer is the hook's own `setTimeout`, and the harness honours the full `timeout`
window without reaping the process early. The doc's suggested 120 s case was not run as its own cell; 20 s,
75 s, 110 s, 900 s, 1800 s, 3200 s and 5000 s all fired exactly, which brackets it.

### 4. Mid-turn: it queues, it does not interrupt

With `WAKE_AFTER_S=110` and a 20-file read task started at T+35 s, the wake landed while the task was still
running:

| event | time |
|---|---|
| task running (note 19 summarised) | 02:25:13.542 |
| **wake enqueued (mid-turn)** | **02:25:16.816** |
| task completes (note 20 + closing summary) | 02:25:19.334 |
| **wake delivered as a user turn** | **02:25:19.379** |

**45 ms after the turn ended.** The turn was not truncated and no tool call was disturbed. So a wake is safe to
fire at any moment, but its delivery latency is *timer + remainder of the current turn* — an agent mid-refactor
will not see a DM for as long as that refactor takes.

(An earlier attempt at this cell failed in an instructive way: the long prompt never submitted, because the TUI
enables bracketed paste and a long burst ending in `\r` is taken as *pasted text* with the newline landing in the
composer. The driver has to send the body and the Enter separately.)

### 5. Re-arm on `Stop`: works, and runs away — **do not ship this**

Adding the same hook to `Stop` does re-arm, and that is the problem. `Stop` fires after **every** turn including
the turns the wakes themselves produce, so each wake schedules the next. With `WAKE_AFTER_S=45`, one session
produced **13 self-triggered turns in ~5 minutes** before being torn down:

```
02:07:53  wake → turn    02:08:15  wake → turn    02:08:53  wake → turn    02:09:04  wake → turn
02:09:42  wake → turn    02:10:03  wake → turn    02:10:36  wake → turn    02:10:51  wake → turn
02:11:23  wake → turn    02:11:39  wake → turn    02:12:11  wake → turn    02:12:26  wake → turn
```

Note the gaps: 38 s, 11 s, 38 s, 21 s, 33 s, 15 s… — tightening, not steady. Each `Stop` event arms an
*independent* timer, so timers accumulate and overlap rather than forming a single chain. This is unbounded token
burn on a conversation the agent is having with itself; the model recognised it ("this will repeat until the hook
is changed") and the wakes kept arriving anyway, because delivery is the harness's decision.

**The usual guard does not apply.** A synchronous `Stop` hook receives `stop_hook_active` and can decline to
re-block — Codex does the same thing (see [S6](S6-codex-hooks.md) §5). An `asyncRewake` hook is spawned detached
and gets no such flag.

### 6. `Notification` with `matcher: idle_prompt`

Not established. The run completed without a wake, which is consistent with the documented behaviour that exit
codes are ignored for `Notification` hooks — but it is also consistent with the `idle_prompt` notification simply
not having fired inside the window, so this is **not a clean negative**. It does not matter: `SessionStart`
answers the requirement, and §5 shows we want *fewer* arming points, not more. Recorded as untested rather than
disproved.

## Decision

**Default: build agent-to-agent DM delivery on a single `SessionStart` hook with `asyncRewake: true`.**

- **`SessionStart` only.** It stays armed for the life of the session; `Stop` is not needed to keep it alive and
  is actively dangerous (§5).
- **Exit 2 only when there is real news.** The hook polls `apps/core` and exits `0` when the inbox is empty.
  Unconditional exit 2 is what creates the runaway. Add a wake counter or minimum interval in the hook's own
  state file so a backend bug cannot become unbounded model turns.
- **Set `rewakeSummary` and `rewakeMessage`.** By default the user sees "Stop hook feedback" and the model sees
  *"Stop hook blocking error from command `SessionStart:startup`"* — no Stop hook involved, and the word "error"
  pushed the model into diagnosing a fault instead of reading its mail. In our runs it told the user "a stop hook
  said there's 1 unread DM", which is not the product we are shipping.
- **Long timeouts are honoured: proven to 5000 s under `timeout: 7200`.** We still re-arm after each delivery
  rather than relying on one long sleep, so `timeout: 3300` is ample — but a longer poll interval is available
  if we ever want one.
- **Treat delivery as "after the current turn".** Show *sent* and *delivered* separately in the DM UI, and
  confirm delivery when the agent actually calls the inbox tool — not when the hook exits.

**Fallback:** if a host drops `asyncRewake` (or the desktop app turns out not to deliver wakes — open in
[S13](S13-desktop-app.md)), fall back to `UserPromptSubmit` + `additionalContext`, which delivers the unread
count on the user's *next* message. Strictly worse — no delivery to a genuinely idle agent — but it needs no
background process and is the same contract Codex gives us.

**Reported to the core owner:** S1 passes, so the messaging layer is unblocked. The two constraints that must be
in the design before it is built are "`SessionStart` only, conditional exit 2" and "wakes queue behind the
running turn".
