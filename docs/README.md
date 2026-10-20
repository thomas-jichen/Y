# Docs

## If you're judging
- **Try it:** https://y-web-beta.vercel.app. Sign in with GitHub, then create a team or open an invite link. The [main README](../README.md) walks through it.
- **What works and what doesn't yet:** [RUNNING.md, "What is cut in v0"](RUNNING.md#what-is-cut-in-v0).
- **Run the whole stack on your laptop:** [RUNNING.md](RUNNING.md). `pnpm demo:local` starts everything and narrates a demo.
- **How it's deployed:** [DEPLOY.md](DEPLOY.md). Supabase, Vercel and Manufact, all on free tiers.

## Design notes
These are the working documents we built from. They're long and written for us, so expect internal shorthand.
- [PLAN.md](PLAN.md): the full design. It covers the product, the architecture, the safety invariants (§10) and the milestones.
- [CONTRACTS.md](CONTRACTS.md): an index of the wire schemas, endpoints and library contracts.
- [UI.md](UI.md): the web app's brief and its contract with core.
- [spikes/](spikes/RESULTS.md): short experiments we ran before committing to a design. They cover waking idle agents, Manufact hosting, Supabase OAuth, Codex hooks and native approval prompts.
