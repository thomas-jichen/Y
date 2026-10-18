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

env_file="$(mktemp)"
trap 'rm -f "$env_file"' EXIT
chmod 600 "$env_file"
{
  printf 'Y_CORE_URL=%s\n' "$Y_CORE_URL"
  printf 'Y_WEB_URL=%s\n' "$Y_WEB_URL"
  printf 'Y_INTERNAL_SECRET=%s\n' "$Y_INTERNAL_SECRET"
} > "$env_file"

cd deploy
# The bundle entry is src/server.js, which mcp-use's entry auto-detection does not
# look for, so pin the build and start commands to the package scripts.
npx mcp-use deploy --no-github --name y-mcp \
  --env-file "$env_file" \
  --build-command "npm run build" \
  --start-command "npm start" \
  "$@"

echo
echo "MCP URL (the slug is generated; never hard-code it):"
npx mcp-use servers list --json 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try {
      const j = JSON.parse(s); const list = Array.isArray(j) ? j : (j.servers ?? []);
      for (const x of list) if (x.name === "y-mcp") console.log(`  ${x.mcpUrl}  (${x.status})`);
    } catch { console.log("  run: npx mcp-use servers list --json"); }
  });'
