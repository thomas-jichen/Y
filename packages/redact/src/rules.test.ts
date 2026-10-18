import { RedactionRuleId } from '@paceline/schema';
import { describe, expect, it } from 'vitest';
import { ENV_DUMP_COMMAND_RE, MARKER_RE, RULES } from './index.js';

describe('RULES (contract)', () => {
  it('has unique ids that are valid receipt rule ids', () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(RedactionRuleId.safeParse(id).success, id).toBe(true);
  });

  it('every marker is recognized as a residual marker', () => {
    for (const r of RULES) expect(MARKER_RE.test(r.marker), r.marker).toBe(true);
  });

  it('env dump commands', () => {
    for (const cmd of ['env', 'env | sort', 'printenv', 'printenv GITHUB_TOKEN', 'set', 'cat .env.local', 'cd app && cat .env', 'head -n 5 .env.production', 'export -p', 'kubectl get secret x -o yaml']) {
      expect(ENV_DUMP_COMMAND_RE.test(cmd), cmd).toBe(true);
    }
    for (const cmd of ['pnpm test', 'cat README.md', 'echo environment', 'set -euo pipefail; pnpm test', 'env NODE_ENV=test pnpm test', 'cat src/env.ts']) expect(ENV_DUMP_COMMAND_RE.test(cmd), cmd).toBe(false);
  });
});
