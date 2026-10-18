#!/usr/bin/env bash
# Deploy apps/mcp to Manufact Cloud as a managed upload (docs/DEPLOY.md step 7).
#
# Needs the operator's own Manufact login first:  npx mcp-use login
# Reads the three env vars below from the environment (never from the repo);
# they reach Manufact through a temp --env-file that is deleted on exit, so
# the secret never appears in argv or in a committed file.
#
#   PACELINE_CORE_URL=https://paceline-core.vercel.app \
#   PACELINE_WEB_URL=https://paceline-web.vercel.app \
#   PACELINE_INTERNAL_SECRET=... \
#   pnpm --filter @paceline/mcp run deploy:manufact [--new --yes ...extra mcp-use deploy flags]
set -euo pipefail
cd "$(dirname "$0")/.."

: "${PACELINE_CORE_URL:?set PACELINE_CORE_URL (the paceline-core Vercel URL)}"
: "${PACELINE_WEB_URL:?set PACELINE_WEB_URL (the paceline-web Vercel URL)}"
: "${PACELINE_INTERNAL_SECRET:?set PACELINE_INTERNAL_SECRET (same value as core)}"

pnpm exec tsx scripts/prepare-deploy.ts

env_file="$(mktemp)"
trap 'rm -f "$env_file"' EXIT
chmod 600 "$env_file"
{
  printf 'PACELINE_CORE_URL=%s\n' "$PACELINE_CORE_URL"
  printf 'PACELINE_WEB_URL=%s\n' "$PACELINE_WEB_URL"
  printf 'PACELINE_INTERNAL_SECRET=%s\n' "$PACELINE_INTERNAL_SECRET"
} > "$env_file"

cd deploy
# The bundle entry is src/server.js, which mcp-use's entry auto-detection does not
# look for, so pin the build and start commands to the package scripts.
npx mcp-use deploy --no-github --name paceline-mcp \
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
      for (const x of list) if (x.name === "paceline-mcp") console.log(`  ${x.mcpUrl}  (${x.status})`);
    } catch { console.log("  run: npx mcp-use servers list --json"); }
  });'
