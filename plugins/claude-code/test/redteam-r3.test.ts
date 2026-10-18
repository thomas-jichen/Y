/**
 * Red-team round 3 regressions in the plugin (R19 git name terms, R20 seq
 * claims, R38 plain-http api_url on a private network). Synthetic fixtures,
 * no network.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redact } from '@y/redact';
import { makeCtx } from '../src/context.js';
import { humanMessage } from '../src/hooks/session-start.js';
import { nameTerms } from '../src/redaction.js';
import { allocSeq, claimSeqFrom, isPrivateNetworkUrl, loadConfig, paths } from '../src/runtime.js';
import { testEnv, tmpDataDir } from './helpers.js';

const SID = 'sess-rt3-1';
let dir: string;
beforeEach(() => {
  dir = tmpDataDir();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('R19 git names made of tool words', () => {
  const text = 'Fixed the code in CLAUDE.md, ran docker compose, the server data and github actions deploy';

  it('do not redact ordinary words', () => {
    for (const name of ['Claude', 'Claude Code', 'GitHub Actions', 'Deploy Bot', 'Jane Server', 'Priya Data', 'Alex Docker']) {
      const user = nameTerms(name);
      const out = redact(text, { identityTerms: { user, email: [], host: [], org: [], project: [], denylist: [] } }).text;
      expect(out, name).toBe(text);
    }
  });

  it('real name parts are still terms', () => {
    expect(nameTerms('Jane Server')).toEqual(['Jane Server', 'Jane']);
    expect(nameTerms('Alex Docker')).toEqual(['Alex Docker', 'Alex']);
    expect(nameTerms('Petra Lindqvist')).toEqual(['Petra Lindqvist', 'Petra', 'Lindqvist']);
    expect(nameTerms('Claude Code')).toEqual([]);
  });
});

describe('R20 a pruned claim is never handed out again', () => {
  it('a stale claim below the highest is given up', () => {
    const p = paths(dir);
    // Y claims 4, Z claims 5 (pruning 4); X read the directory before both and now tries 4.
    for (let i = 0; i < 6; i++) allocSeq(p, SID);
    const seqDir = path.join(p.seq, SID);
    expect(fs.readdirSync(seqDir)).toEqual(['5']);
    expect(claimSeqFrom(seqDir, 4)).toBe(6);
    expect(allocSeq(p, SID)).toBe(7);
    expect(fs.readdirSync(seqDir)).toEqual(['7']);
  });
});

describe('R38 plain-http api_url on a private network', () => {
  const env = (extra: Record<string, string>) => ({ CLAUDE_PLUGIN_OPTION_AGENT_TOKEN: 'tok_test_install_0000000000', Y_DATA_DIR: dir, ...extra });

  it('keeps the token and warns at SessionStart', () => {
    for (const url of ['http://10.0.0.5:8787', 'http://192.168.1.20:8787', 'http://172.20.0.3:8787', 'http://host.docker.internal:8787', 'http://core:8787', 'http://devbox.lan:8787', 'http://[fd00::5]:8787']) {
      const c = loadConfig(env({ CLAUDE_PLUGIN_OPTION_API_URL: url }));
      expect(c.token, url).toBe('tok_test_install_0000000000');
      expect(c.insecureApiUrl, url).toBeUndefined();
      expect(c.cleartextApiUrl, url).toBe(true);
      const ctx = makeCtx('SessionStart', JSON.stringify({ session_id: SID }), { env: testEnv(dir, url), spawnDetached: () => {} });
      expect(humanMessage(ctx, undefined), url).toContain('Y: api_url is plain http:// to another machine on your network');
    }
  });

  it('public http hosts are still withheld; loopback, https and the opt-out do not warn', () => {
    expect(loadConfig(env({ CLAUDE_PLUGIN_OPTION_API_URL: 'http://y.example.com' }))).toMatchObject({ token: 'tok_test_install_0000000000', insecureApiUrl: true });
    expect(isPrivateNetworkUrl('http://8.8.8.8:80')).toBe(false);
    expect(isPrivateNetworkUrl('http://172.32.0.1')).toBe(false);
    for (const [url, extra] of [['https://y.example.com', {}], ['http://localhost:8787', {}], ['http://10.0.0.5:8787', { Y_ALLOW_INSECURE_URL: '1' }]] as const) {
      const c = loadConfig(env({ ...extra, CLAUDE_PLUGIN_OPTION_API_URL: url }));
      expect(c.token, url).toBe('tok_test_install_0000000000');
      expect(c.cleartextApiUrl, url).toBeUndefined();
      const ctx = makeCtx('SessionStart', JSON.stringify({ session_id: SID }), { env: testEnv(dir, url, extra), spawnDetached: () => {} });
      expect(humanMessage(ctx, undefined) ?? '', url).not.toContain('api_url');
    }
  });
});
