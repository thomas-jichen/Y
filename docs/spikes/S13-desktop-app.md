# S13: Same checks in the Claude desktop app (Code tab)

- **Date / tester:** 2026-10-17 / laurence (driven from a Claude Code agent session)
- **Versions:** Claude Code **2.1.302** (CLI) · desktop app **not installed on this machine** — `/Applications/*Codex*` and any Claude desktop bundle absent
- **Status: PARTLY DONE.** Step 4 is answered (and found a real asymmetry). Steps 1–3 need the desktop app and a human at the window; a 10-minute script is at the bottom.

## Question

Does the asyncRewake idle wake also work in the desktop app's Code tab; does `Stop` fire every turn and does
`SessionEnd` fire when the window is closed, the session archived, or the app quit; and are skills written
mid-session picked up without a restart?

## What I could not do, and why

The desktop app is not installed here, and steps 1–3 are inherently human: they need someone to open a Code tab,
leave it idle while watching for a new turn, and then close a window / archive a session / quit the app. There is
no scriptable surface for "close the app window", so automating it would not have tested the thing that matters.
Everything below under "Handover" is set up and ready; it needs ~10 minutes of clicking.

## Step 4: mid-session skill pickup — **done, and the two scopes differ**

This part is testable on the CLI and the answer is almost certainly shared with the desktop app, since it is
skill-discovery behaviour rather than UI.

Method: start a session in a scratch folder, write a `SKILL.md` **while the session is running**, then ask the
session to use it. Each skill contained a unique phrase so the answer could not be bluffed.

| scope | written at | result |
|---|---|---|
| **user** — `~/.claude/skills/spike-skill/SKILL.md` | T+45 s | **picked up, no restart** — returned `PACELINE-HOT-RELOAD-OK` |
| **project** — `.claude/skills/spike-proj-skill/SKILL.md`, in a `.claude/skills` dir **absent at session start** | T+40 s | **not picked up** — `NO SUCH SKILL` |

The probe session noticed the first one unprompted:

> The secret phrase in the spike-skill skill is **PACELINE-HOT-RELOAD-OK**. It wasn't in the skills list when
> this session started; it showed up partway through. So skills added mid-session get picked up without a
> restart.

There is independent corroboration for the user-level case: the agent session doing this work received a
`system-reminder` announcing `spike-skill` as newly available, in its own already-running session, moments after
the file was written.

The project-level case failed in a session that *could* see the user-level skill added seconds earlier — so this
is a genuine scope asymmetry, not a timing artefact. Written up as a seed:
`seeds/highlights/claude-code-project-skills-not-hot-reloaded.json`.

**Consequence for `paceline init`:** if the installer writes a project-scoped skill into a `.claude/skills`
directory it has just created, that skill is invisible for the rest of the session. Either create
`.claude/skills/` during project setup (before anyone starts a session), install Paceline's skills at **user**
level, or have the installer tell the user to restart. Reporting "installed" and leaving it inert is the failure
to avoid — it is the same shape as the Codex trust gate in [S6](S6-codex-hooks.md).

## Steps 1–3: handover

Everything needed is already on disk; nothing to build.

### Setup (already prepared)

- Wake plugin: `/tmp/spike-wake/` — `.claude-plugin/plugin.json`, `hooks/hooks.json`, `wake.mjs`.
  Because `--plugin-dir` is not available in the desktop app, copy the hook into the scratch project's
  `.claude/settings.local.json` using the **single-command form**:

```json
{ "hooks": { "SessionStart": [ { "hooks": [ {
  "type": "command",
  "command": "node /tmp/spike-wake/wake.mjs",
  "asyncRewake": true,
  "timeout": 3300
} ] } ] } }
```

- Event log hooks for step 3, in the same file:

```json
"Stop":       [ { "hooks": [ { "type": "command", "command": "sh", "args": ["-c", "echo \"$(date -u +%FT%TZ) stop\" >> /tmp/spike-events.log"] } ] } ],
"SessionEnd": [ { "hooks": [ { "type": "command", "command": "sh", "args": ["-c", "echo \"$(date -u +%FT%TZ) sessionend reason=$CLAUDE_SESSION_END_REASON\" >> /tmp/spike-events.log"] } ] } ]
```

### Script (~10 min)

1. Open a scratch folder in the desktop app's Code tab. Accept the folder-trust prompt — note that in the CLI
   this dialog **defaults to "No, exit"**, so check whether the desktop default is the same.
2. `WAKE_AFTER_S` defaults to 120. Say "hi", then **leave it idle**. Does a new turn start ~2 min later showing
   the stderr text? Expect the summary line to read **"Stop hook feedback"** even though it is a SessionStart
   hook (see [S1](S1-asyncrewake-idle-wake.md)).
3. Mid-turn: ask for something long (e.g. "read every file in this folder one at a time and summarise each"), and
   while it is working let the wake fire. On the CLI it **queues and is delivered ~45 ms after the turn ends**,
   not as an interruption — confirm the desktop app matches.
4. `: > /tmp/spike-events.log`, then: take several turns (does `stop` appear once per turn?), then in turn
   **close the window**, **archive the session**, and **quit the app**, checking the log after each:
   `cat /tmp/spike-events.log`. The three cases are the actual question — a `SessionEnd` that does not fire on
   window close means our session upload silently never happens for desktop users.
5. Record the desktop version (app → About) in the versions line at the top of this file.

### What to watch for

- If `SessionEnd` does not fire on window close, the session-upload design cannot live in `SessionEnd` for
  desktop at all, and must move to the next `SessionStart` reconciling an unfinished session. That is a core
  design decision, so report it to the core owner directly.
- `asyncRewake` with a long `timeout` keeps a Node process alive for the life of the session. In the desktop app,
  where sessions are long-lived and users keep many tabs, check whether these accumulate.

## Decision

**Default (step 4, decided):** install Paceline's skills at **user** level, or create `.claude/skills/` before the
session starts. Never install a project skill mid-session and report success.

**Default (steps 1–3, provisional, pending the run above):** assume desktop behaves like the CLI — the wake works,
queues rather than interrupts, and `Stop` fires per turn — but **do not assume `SessionEnd` fires on window
close**. Design the upload path to be recoverable from the next `SessionStart` regardless, which also covers
crashes and force-quits on both hosts.

**Fallback:** if the desktop app does not deliver wakes at all, agent-to-agent DMs become CLI-only for M-whatever
ships first, and desktop users get the web/Slack approval surface instead of in-session delivery. Worth knowing
early because it changes what we can promise in the pilot.
