# Name check: "Paceline"

- **Date / checker:** 2026-10-17 / laurence (driven from a Claude Code agent session)
- **Method:** npm registry API, GitHub API, RDAP (404 = unregistered), WHOIS, USPTO/Justia trademark records
- **Verdict: "Paceline" is not free.** There is a live US trademark for software in an adjacent space, and the npm scope, GitHub org and the three obvious domains are all taken. Recommend picking a different name before anything ships under it.

## 1. Trademark — the real blocker

**PACELINE is a live registered US trademark.**

| | |
|---|---|
| Mark | PACELINE |
| Registration no. | 6236939 (serial 88816896) |
| Owner | Tam(squared) Inc. — trading as Paceline, San Francisco CA |
| Filed | 2020-03-02 |
| Registered | 2021-01-05 |
| Goods | downloadable computer application software for mobile phones, smartwatches and wearable activity trackers, for recording and monitoring physical fitness activity and providing reward benefits |
| Live product | <https://paceline.fit> — health-and-wellness rewards app |

Why this is not a comfortable "different field of use":

- The registered goods are **downloadable application software**, which is what we ship.
- Our own one-line pitch is **"Strava for coding agents"** — we are describing the product by analogy to fitness
  activity tracking, which is the registrant's exact category. The product is also literally an
  activity-tracking-and-rewards app, just for agents instead of athletes.
- The registrant is a San Francisco software company in the same startup ecosystem and the same distribution
  channels (app stores, web).

That combination — same goods class, adjacent semantics, same market — is the shape that gets a cease-and-desist,
not the shape that gets waved through. There is also a Canadian PACELINE / PACE LINE record in CIPO.

**This is a judgement for a lawyer, not for me.** What I can say is that this does not look like the clean
"the name is free" result the task hoped for, and the cost of changing a name rises steeply after launch,
docs, a GitHub org and an npm scope exist.

## 2. npm — scope is taken

| name | status |
|---|---|
| `@paceline` **scope** | **TAKEN** — `@paceline/tixx-common@1.0.4` exists, published 2020-04-25, maintainer `sehyvone` |
| `paceline` (unscoped) | free (registry 404) |
| `@paceline/core`, `@paceline/cli` | 404, but unusable — the scope belongs to another account |

A scope with any published package cannot be claimed by a new org, so **`@paceline/*` is off the table**. The
unscoped `paceline` name is free, but shipping `paceline` unscoped while someone else owns `@paceline` is a bad
place to be.

Note for anyone re-running this: `GET /-/v1/search?text=scope:paceline` reports **0 packages** and is wrong —
the scope is in use. Query a concrete package path instead (`/@paceline%2ftixx-common` → HTTP 200).

## 3. GitHub — org name is taken

`github.com/paceline` → **HTTP 200, a User account** (Ulf Moehring), created 2008-04-14, 13 public repos.

An existing user holds the namespace, so `github.com/paceline` is unavailable as an org. Dormant-looking
accounts are not reclaimable on request.

## 4. Domains

| domain | status | detail |
|---|---|---|
| paceline.com | **TAKEN** | created 1996-03-12, Network Solutions, expires 2027-03-13 |
| paceline.io | **TAKEN** | created 2015-01-16, Namecheap, expires 2027-01-16 |
| paceline.ai | **TAKEN** | created **2026-08-30** (≈7 weeks ago), Spaceship |
| paceline.dev | free | |
| paceline.app | free | |
| paceline.sh | free | |
| paceline.team | free | |

`.com`, `.io` and `.ai` — the three a developer tool actually wants — are all gone, and `.ai` was taken very
recently, so the name is under active demand.

## Recommendation

Treat "Paceline" as a working title only, and choose a replacement before M1. A usable name should clear, in
this order:

1. **No live trademark in software/Class 9/42** for the exact word (search USPTO TESS and CIPO).
2. **npm scope unclaimed** — check a concrete package path, not the scope search.
3. **GitHub org free.**
4. **`.com` or `.dev` available.**

If the team wants to keep the cycling metaphor, the adjacent vocabulary is large (echelon, paceline, peloton,
domestique, musette, bidon, rouleur, leadout, breakaway) — but *echelon* and *peloton* are both heavily
trademarked in fitness too, so the metaphor itself is a crowded field. A name drawn from the agent/coding side
rather than the fitness side will clear faster.

**What I did not do:** no legal opinion, no TESS full-text clearance search across all classes, no common-law
use search. Someone should run a real clearance check on whatever name is chosen.
