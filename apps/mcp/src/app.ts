/**
 * Factory for the Y MCP server (mcp-use v2). No DB credentials here
 * (I7): every tool forwards to core's internal MCP API.
 */
import { TOOLS } from '@y/schema';
import { MCPServer, type StandardSchemaWithJSON } from 'mcp-use';
import { configFromEnv, createCoreClient, type CoreClientConfig } from './core-client.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import { SLICE_TOOLS, TOOL_SPECS, clientAddressFrom, normalizeAuthorization, runTool, toolMeta } from './tools.js';

export const SERVER_NAME = 'y';
export const SERVER_VERSION = '0.0.0';

export interface CreateServerOptions {
  /** Overrides for the core forwarder (defaults from env). */
  core?: Partial<CoreClientConfig>;
  /** Skills over MCP discovery (`skills/`); default automatic. */
  skills?: boolean;
  /** Request logging; default on. */
  logging?: boolean;
  /**
   * A client-IP header the deploy's proxy always overwrites (default env
   * Y_CLIENT_IP_HEADER). Unset: the rightmost X-Forwarded-For entry.
   */
  clientIpHeader?: string;
}

export function createServer(opts: CreateServerOptions = {}) {
  const core = createCoreClient({ ...configFromEnv(), ...opts.core });
  const clientIpHeader = opts.clientIpHeader ?? process.env.Y_CLIENT_IP_HEADER;

  const server = new MCPServer({
    name: SERVER_NAME,
    title: 'Y',
    version: SERVER_VERSION,
    description: "Strava for coding agents: search what other agents learned, and message teammates' agents.",
    instructions: SERVER_INSTRUCTIONS,
    ...(opts.skills === undefined ? {} : { skills: opts.skills }),
    ...(opts.logging === false ? { logging: { enabled: false } } : {}),
  });

  for (const name of SLICE_TOOLS) {
    const spec = TOOL_SPECS[name];
    const meta = toolMeta(name);
    const definition = {
      name,
      title: spec.title,
      description: spec.description,
      inputSchema: TOOLS[name].input as unknown as StandardSchemaWithJSON,
      outputSchema: TOOLS[name].output as unknown as StandardSchemaWithJSON,
      annotations: { title: spec.title, ...spec.annotations },
      ...(meta ? { _meta: meta } : {}),
    };
    server.tool(definition, async (input: Record<string, unknown>, ctx) =>
      runTool(core, name, input, {
        authorization: normalizeAuthorization(ctx.request?.header('authorization')),
        signal: ctx.signal,
        requestId: ctx.request?.header('x-request-id'),
        clientName: ctx.client.info().name,
        clientVersion: ctx.client.info().version,
        clientAddress: clientAddressFrom((n) => ctx.request?.header(n), clientIpHeader),
      }) as never,
    );
  }

  return server;
}
