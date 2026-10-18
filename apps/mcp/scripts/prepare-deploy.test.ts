/**
 * The Manufact prebundle: a standalone project with no workspace deps, whose
 * bundle imports only registry packages and still default-exports a working
 * MCPServer (the shape `mcp-use build` requires).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MCP_ROOT, prepareDeploy } from './prepare-deploy.js';

// Inside apps/mcp so the bundle's bare imports (mcp-use, zod) resolve from apps/mcp/node_modules.
const out = path.join(MCP_ROOT, `.test-deploy-${process.pid}`);
afterAll(() => fs.rmSync(out, { recursive: true, force: true }));

describe('prepare-deploy', () => {
  it('writes a standalone project and keeps the mcp-use link dir', async () => {
    fs.mkdirSync(path.join(out, '.mcp-use'), { recursive: true });
    fs.writeFileSync(path.join(out, '.mcp-use', 'link.json'), '{"keep":true}');
    fs.mkdirSync(path.join(out, 'stale'), { recursive: true });

    const r = await prepareDeploy(out);
    expect(r.externals).toEqual(['mcp-use', 'zod']);
    expect(fs.existsSync(path.join(out, '.mcp-use', 'link.json'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'stale'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'skills', 'paceline', 'SKILL.md'))).toBe(true);

    const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
    expect(Object.keys(allDeps).some((d) => d.startsWith('@paceline/'))).toBe(false);
    for (const v of Object.values(allDeps)) expect(v).toMatch(/^\d+\.\d+\.\d+/); // pinned registry versions
    expect(pkg.scripts.build).toBe('mcp-use build --entry src/server.js');

    const code = fs.readFileSync(r.bundle, 'utf8');
    expect(code).not.toMatch(/from ["']@paceline\//);
    expect(code).not.toMatch(/PACELINE_INTERNAL_SECRET\s*=\s*["'][^"']/); // no secrets baked in
  });

  it('the bundle default-exports an MCPServer with the slice tools', async () => {
    const mod = (await import(pathToFileURL(path.join(out, 'src', 'server.js')).href)) as {
      default: { tool: unknown; app: unknown };
    };
    expect(typeof mod.default.tool).toBe('function');
    expect(mod.default.app).toBeDefined();
  });
});
