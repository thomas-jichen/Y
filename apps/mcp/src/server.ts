/**
 * Entry point. `mcp-use dev|build|start` imports the default export;
 * `tsx src/server.ts` serves it directly on `PORT` (default 3000).
 */
import { pathToFileURL } from 'node:url';
import { isBuilding } from 'mcp-use';
import { createServer } from './app.js';
import { assertCoreEnv } from './core-client.js';

// Fail at startup, not on the first tool call. `mcp-use build` evaluates this
// entry without runtime env, so the check is skipped there.
if (!isBuilding()) assertCoreEnv(process.env);

const server = createServer();

export default server;

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  const { url } = await server.listen(port);
  console.log(`y mcp listening on ${url}`);
}
