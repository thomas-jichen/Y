# Spike results index

Results for [README.md](README.md) sections 1–4. Run 2026-10-17 by laurence, driven from a Claude Code agent
session on macOS 27.0.1.

**Versions used throughout:** Claude Code **2.1.302** (CLI; a second, older 2.1.240 install also exists on this
machine at `/usr/local/bin/claude`) · Codex CLI **0.163.0** (model `gpt-6-luna`) · `mcp-use` **2.10.1** ·
`@modelcontextprotocol/sdk` **1.32.1** · Node **24.21.0**. Claude desktop app: **not installed**.

| Spike | Verdict | Doc |
|---|---|---|
| **S1** asyncRewake idle wake (CLI) | **PASS** — wakes an idle session reliably at 20 s → 30 min | [S1-asyncrewake-idle-wake.md](S1-asyncrewake-idle-wake.md) |
| **S6** Codex hooks | **PASS** — with a trust gate that silently no-ops until cleared | [S6-codex-hooks.md](S6-codex-hooks.md) |
| **S16** `requiresUserInteraction` | **YES, and stronger than expected** — no mode or allow rule can satisfy it | [S16-requires-user-interaction.md](S16-requires-user-interaction.md) |
| **S3** Manufact Cloud | **PASS** — deployed, headers pass through, egress open, no cold start at 11 min | [S3-manufact-cloud.md](S3-manufact-cloud.md) |
| **S13** Desktop app | **PARTLY DONE** — step 4 answered; steps 1–3 need the app + a human (10-min script) | [S13-desktop-app.md](S13-desktop-app.md) |
| **S4** Supabase OAuth | **BLOCKED** on the account — but it works on the **Free** plan | [S4-supabase-oauth.md](S4-supabase-oauth.md) |
| Accounts and keys | 1 of 7 done; two plan conflicts settled | [00-accounts-and-keys.md](00-accounts-and-keys.md) |
| Name: "Paceline" | **NOT FREE** — live US trademark, npm scope, GitHub org, 3 domains all taken | [NAME-paceline-availability.md](NAME-paceline-availability.md) |

## The five findings that change the build

1. **Agent-to-agent messaging is viable on both hosts.** S1 and S6 both pass, so the design is not blocked.
2. **Never put `asyncRewake` on `Stop`.** It re-arms off its own wakes and runs away — 13 self-triggered turns in
   5 minutes, timers accumulating. `SessionStart` only, and exit 2 only when there is real news. (S1)
3. **A wake queues behind the running turn**, delivered ~45 ms after it ends — it never interrupts. Delivery
   latency is timer + remaining turn, which the DM UI has to reflect. (S1)
4. **`requiresUserInteraction` makes a tool unusable headless** — denied under `claude -p`, and neither
   `bypassPermissions` nor an explicit allow rule helps. Keep it off every tool in the agent loop; use it for the
   human-approval step, where it becomes our enforcement point. (S16)
5. **Both hosts have a silent-inert failure mode at install time**, and `paceline init` has to own both: Codex
   hooks do nothing until trusted, and a project skill written into a `.claude/skills` dir created mid-session is
   invisible until restart. (S6, S13)

## Two things to settle with the core owner before schema work

- **Embeddings dimension.** `README.md` §1 specifies Vercel AI Gateway + `openai/text-embedding-3-small`
  (**1536** dims, paid); the $0 route is Supabase `gte-small` (**384** dims, free, 512-token truncation). This is
  a `vector(N)` column decision — changing it later means a migration plus a full re-embed.
- **Supabase plan.** Free is enough for the OAuth 2.1 server and DCR, so §1's "Pro" is not required for M0–M1.
  The reason to upgrade later is Free-project **auto-pause**, which takes the auth server offline with it.

## Still open

- S13 steps 1–3: desktop wake, and whether `SessionEnd` fires on window close / archive / quit. If it does not,
  session upload cannot live in `SessionEnd`. Script in the S13 doc.
- S4: the access-token claims, specifically whether **`client_id`** is present. Runbook in the S4 doc.
- S6 §2: `PreToolUse` `deny` actually blocking a write — one toggle in the Codex trust UI, then one command.
  Documented contract is `deny`/`allow` with **no `ask`**, as expected.
- What **claude.ai** shows for a 401 + `WWW-Authenticate` (browser flow; needs a human).

## Seed content

21 verified gotchas in [`seeds/highlights/`](../../seeds/highlights/), one JSON file each, matching `Highlight`
in `docs/UI.md` §4 (no ids, no server-side counters). 63 unique source URLs.

Provenance: 10 are first-hand from these spikes; 11 were researched against live vendor docs and put through an
adversarial refutation pass. **Four of the seven candidate gotchas suggested in README.md §3 did not survive that
pass as written** and are seeded in corrected form — including "Next 16 silently ignores `middleware.ts`" (it
still runs, with a deprecation warning) and "Haiku 5.5 rejects `temperature`" (it rejects non-default *values*,
across every model from Opus 4.7 onward). Rejected-as-stated claims and the reasoning are in the workflow
journal; the corrected versions are the seeds.
