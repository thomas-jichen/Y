#!/usr/bin/env bash
# Deploy apps/mcp to Manufact Cloud as a managed upload (docs/DEPLOY.md step 7).
#
# Needs the operator's own Manufact login first:  npx mcp-use login
# Reads the three env vars below from the environment (never from the repo)
# and sets them on the server with `mcp-use servers env set`. Values go through
# scripts/mcp-use-env-set.ts, which reads each one from the environment and runs
# the CLI in-process, so Y_INTERNAL_SECRET never appears in any process's argv
# (ps, /proc) or in a committed file. Every mcp-use call here uses the pinned
# workspace CLI in apps/mcp/node_modules, never a registry download via npx.
#
#   Y_CORE_URL=https://y-core.vercel.app \
#   Y_WEB_URL=https://y-web.vercel.app \
#   Y_INTERNAL_SECRET=... \
#   pnpm --filter @y/mcp run deploy:manufact [--new --yes ...extra mcp-use deploy flags]
#
# Y_CLIENT_IP_HEADER is deliberately not set here. Without it, signed-out
# callers are keyed by the rightmost X-Forwarded-For hop. Behind Manufact's
# Cloudflare Worker + Fly.io chain that hop may be shared by everyone, so
# core gives those callers one shared signed-out bucket (10x the per-client
# limit) and no per-client ones. Set it by hand to a header the platform
# always overwrites with the caller's address (candidate: cf-connecting-ip),
# and only after checking it (docs/DEPLOY.md step 7).
#
# Deploy order for this release: deploy apps/mcp BEFORE core. This build
# sends meta.wideSetupNames, and an older apps/mcp that sends no meta would
# reject compare_setups results that carry the wider names.
set -euo pipefail
cd "$(dirname "$0")/.."
MCP_DIR="$(pwd -P)"
MCP_USE_BIN="${Y_MCP_USE_BIN:-$MCP_DIR/node_modules/mcp-use/dist/bin.js}"
[ -f "$MCP_USE_BIN" ] || { echo "mcp-use is not installed in apps/mcp (run pnpm install)" >&2; exit 1; }
mcp_use() { node "$MCP_USE_BIN" "$@"; }
# Sets KEY on a server; the value is read from $KEY, never passed as an argument.
env_set() { Y_MCP_USE_BIN="$MCP_USE_BIN" "$MCP_DIR/node_modules/.bin/tsx" "$MCP_DIR/scripts/mcp-use-env-set.ts" "$@"; }

: "${Y_CORE_URL:?set Y_CORE_URL (the y-core Vercel URL)}"
: "${Y_WEB_URL:?set Y_WEB_URL (the y-web Vercel URL)}"
: "${Y_INTERNAL_SECRET:?set Y_INTERNAL_SECRET (same value as core)}"
export Y_CORE_URL Y_WEB_URL Y_INTERNAL_SECRET

pnpm exec tsx scripts/prepare-deploy.ts

cd deploy
[ "${1:-}" = "--" ] && shift

find_sid() {
  mcp_use servers list --json 2>/dev/null | node -e '
  let s=""; process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const j=JSON.parse(s);
  const l=Array.isArray(j)?j:(j.items??j.servers??[]); const x=l.find((x)=>x.name==="y-mcp"); if(x) console.log(x.id);});'
}
set_env() {
  env_set "$1" Y_CORE_URL >/dev/null
  env_set "$1" Y_WEB_URL >/dev/null
  env_set "$1" Y_INTERNAL_SECRET --secret >/dev/null
}
# The server refuses to start without Y_CORE_URL / Y_INTERNAL_SECRET, so set
# them before the deploy when the server already exists (and again after, for a new one).
existing_sid="$(find_sid || true)"
[ -n "$existing_sid" ] && set_env "$existing_sid"
# Manufact's --env-file must live inside the uploaded folder (it would ship with the
# source), so deploy first, then set the env vars on the server by id. The secret is
# stored write-only. Env changes apply to the running server.
mcp_use deploy --no-github --name y-mcp \
  --build-command "npm run build" \
  --start-command "npm start" \
  "$@"

sid="$(find_sid)"
: "${sid:?could not find the y-mcp server id}"
set_env "$sid"

echo
echo "MCP URL (the slug is generated; never hard-code it):"
mcp_use servers list --json 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try {
      const j = JSON.parse(s); const list = Array.isArray(j) ? j : (j.servers ?? []);
      for (const x of list) if (x.name === "y-mcp") console.log(`  ${x.mcpUrl}  (${x.status})`);
    } catch { console.log("  run: pnpm --filter @y/mcp exec mcp-use servers list --json"); }
  });'
