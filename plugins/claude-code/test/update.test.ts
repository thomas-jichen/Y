/** Plugin version from plugin.json, and the auto-update nudge. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeCtx } from '../src/context.js';
import { autoUpdateNudge } from '../src/hooks/session-start.js';
import { autoUpdateOffFor, PLUGIN_VERSION, readPluginVersion } from '../src/runtime.js';
import { tmpDataDir } from './helpers.js';

function install(opts: { known?: unknown; settings?: unknown } = {}) {
  const home = tmpDataDir();
  const config = path.join(home, '.claude');
  const root = path.join(config, 'plugins', 'cache', 'y', 'y', '9.9.9');
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'y', version: '9.9.9' }));
  if (opts.known !== undefined) fs.writeFileSync(path.join(config, 'plugins', 'known_marketplaces.json'), JSON.stringify(opts.known));
  if (opts.settings !== undefined) fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify(opts.settings));
  return { home, env: { HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDE_PLUGIN_ROOT: root, Y_DATA_DIR: path.join(home, 'data') } as NodeJS.ProcessEnv };
}

describe('plugin version', () => {
  it('reads the installed plugin.json, so CI only bumps that file', () => {
    expect(readPluginVersion(install().env)).toBe('9.9.9');
  });
  it('falls back to the repo plugin.json in a checkout', () => {
    const repo = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;
    expect(PLUGIN_VERSION).toBe(repo);
  });
});

describe('auto-update', () => {
  const ys = { y: { source: { source: 'github', repo: 'thomas-jichen/Y' } } };
  it('is off by default for the marketplace this plugin came from', () => {
    expect(autoUpdateOffFor(install({ known: ys }).env)).toBe('y');
  });
  it('is on when the /plugin toggle or a settings entry turns it on; settings win', () => {
    expect(autoUpdateOffFor(install({ known: { y: { ...ys.y, autoUpdate: true } } }).env)).toBeUndefined();
    expect(autoUpdateOffFor(install({ known: ys, settings: { extraKnownMarketplaces: { y: { autoUpdate: true } } } }).env)).toBeUndefined();
    expect(autoUpdateOffFor(install({ known: { y: { ...ys.y, autoUpdate: true } }, settings: { extraKnownMarketplaces: { y: { autoUpdate: false } } } }).env)).toBe('y');
  });
  it('stays quiet when the install is unknown (dev checkout, no marketplace entry)', () => {
    expect(autoUpdateOffFor({ HOME: '/nonexistent' })).toBeUndefined();
    expect(autoUpdateOffFor(install({ known: {} }).env)).toBeUndefined();
  });
  it('nudges the human at most once a day', () => {
    const { env } = install({ known: ys });
    let now = 1_800_000_000_000;
    const ctx = () => makeCtx('SessionStart', '{}', { env, now: () => now });
    expect(autoUpdateNudge(ctx())).toMatch(/auto-update is off.*\/plugin, Marketplaces, y, Enable auto-update/);
    now += 3600_000;
    expect(autoUpdateNudge(ctx())).toBeUndefined();
    now += 24 * 3600_000;
    expect(autoUpdateNudge(ctx())).toMatch(/auto-update is off/);
  });
});
