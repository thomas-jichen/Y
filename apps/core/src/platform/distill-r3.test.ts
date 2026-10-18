/**
 * Red-team round 3 (R15): environment masking in the heuristic distiller and
 * in client-supplied drafts keeps ordinary code, library names and
 * project files. Synthetic fixtures only; no DB.
 */
import { describe, expect, it } from 'vitest';
import { heuristicDrafts, maskEnvironment, revealsEnvironment } from './distill.js';

describe('R15 environment masking keeps legitimate highlight content', () => {
  it('leaves property chains, library names, env templates and package steps as written', () => {
    for (const t of [
      'TypeError: this.app is undefined',
      'TypeError: req.session.me is null',
      'state.ai is undefined',
      'socket.io handshake failed',
      'node_modules/socket.io/lib/index.js',
      'Edit: .env.example',
      'Bash: pnpm add socket.io',
      'Edit: src/auth/session.ts (TOKEN_TTL constant)',
      'Bash: MAX_TOKENS=4096 pnpm eval',
    ]) {
      expect(maskEnvironment(t), t).toBe(t);
      expect(revealsEnvironment(t), t).toBe(false);
    }
  });

  it('still masks hosts, credential files and secret variables', () => {
    expect(maskEnvironment('connect ECONNREFUSED 10.20.0.7:5432 via db.prod.acme-internal.net')).toBe('connect ECONNREFUSED <ip>:5432 via <host>');
    expect(maskEnvironment('Edit: .env.local')).toBe('Edit: <file>');
    expect(maskEnvironment('timeout talking to app.acme.dev')).toBe('timeout talking to <host>');
    for (const t of ['cat .env.local', 'echo $GITHUB_PAT', 'grep -rn STRIPE_SECRET_KEY src', 'export API_TOKEN=x', 'curl api.acme.so/v1']) {
      expect(revealsEnvironment(t), t).toBe(true);
    }
  });

  it('a draft keeps a step that names a token constant and a title with a property chain', () => {
    const digest = [
      'TOOL Bash: pnpm test',
      'ERROR Bash: TypeError: this.app is undefined',
      'TOOL Edit: src/auth/session.ts (TOKEN_TTL constant)',
      'OK Bash: Test Files 3 passed (3)',
    ].join('\n');
    const d = heuristicDrafts({ digest, episodes: [], normalize: (t) => t })[0]!;
    expect(d).toBeDefined();
    expect(d.title).toBe('Fix: TypeError: this.app is undefined');
    expect(d.body.steps).toEqual(['Edit: src/auth/session.ts (TOKEN_TTL constant)']);
  });
});
