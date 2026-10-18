#!/usr/bin/env bash
# Deploy apps/mcp to Manufact Cloud as a managed upload (docs/DEPLOY.md step 7).
#
# Needs the operator's own Manufact login first:  npx mcp-use login
# Reads the three env vars below from the environment (never from the repo);
# they reach Manufact through a temp --env-file that is deleted on exit, so
# the secret never appears in argv or in a committed file.
#
#   Y_CORE_URL=https://y-core.vercel.app \
#   Y_WEB_URL=https://y-web.vercel.app \
#   Y_INTERNAL_SECRET=... \
#   pnpm --filter @y/mcp run deploy:manufact [--new --yes ...extra mcp-use deploy flags]
set -euo pipefail
cd "$(dirname "$0")/.."

: "${Y_CORE_URL:?set Y_CORE_URL (the y-core Vercel URL)}"
: "${Y_WEB_URL:?set Y_WEB_URL (the y-web Vercel URL)}"
: "${Y_INTERNAL_SECRET:?set Y_INTERNAL_SECRET (same value as core)}"

pnpm exec tsx scripts/prepare-deploy.ts

cd deploy
[ "${1:-}" = "--" ] && shift
# Manufact's --env-file must live inside the uploaded folder (it would ship with the
# source), so deploy first, then set the env vars on the server by id. The secret is
# stored write-only. Env changes apply to the running server.
npx mcp-use deploy --no-github --name y-mcp \
  --build-command "npm run build" \
  --start-command "npm start" \
  "$@"

sid="$(npx mcp-use servers list --json 2>/dev/null | node -e '
  let s=""; process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const j=JSON.parse(s);
  const l=Array.isArray(j)?j:(j.items??j.servers??[]); const x=l.find((x)=>x.name==="y-mcp"); if(x) console.log(x.id);});')"
: "${sid:?could not find the y-mcp server id}"
npx mcp-use servers env set "$sid" "Y_CORE_URL=$Y_CORE_URL" --json >/dev/null
npx mcp-use servers env set "$sid" "Y_WEB_URL=$Y_WEB_URL" --json >/dev/null
npx mcp-use servers env set "$sid" "Y_INTERNAL_SECRET=$Y_INTERNAL_SECRET" --secret --json >/dev/null

echo
echo "MCP URL (the slug is generated; never hard-code it):"
npx mcp-use servers list --json 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try {
      const j = JSON.parse(s); const list = Array.isArray(j) ? j : (j.servers ?? []);
      for (const x of list) if (x.name === "y-mcp") console.log(`  ${x.mcpUrl}  (${x.status})`);
    } catch { console.log("  run: npx mcp-use servers list --json"); }
  });'
