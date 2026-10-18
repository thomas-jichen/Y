/**
 * Red-team #5: config diffs and Bash one-liners in the digest must not carry
 * MCP env values, args, hook commands or command-line passwords. Synthetic
 * values only.
 */
import { describe, expect, it } from 'vitest';
import { buildDigest, maskCliSecrets } from './digest.js';
import type { ClaudeRecord } from './types.js';

function toolUse(id: string, name: string, input: Record<string, unknown>): ClaudeRecord {
  return {
    kind: 'assistant',
    isSidechain: false,
    isHumanPrompt: false,
    content: [{ type: 'tool_use', id, name, input }],
  } as unknown as ClaudeRecord;
}

describe('digest: secrets in config diffs and commands', () => {
  it('masks string values in .mcp.json and settings.json diffs but keeps keys and markdown config', () => {
    const mcp = JSON.stringify(
      {
        mcpServers: {
          db: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', 'db-mcp', 'postgres://svc@db7.corp.acme.internal/prod'],
            env: { DB_PASSWORD: 'correcthorsebattery', INTERNAL_HOST: 'db7.corp.acme.internal', POOL: 4 },
          },
        },
      },
      null,
      2,
    );
    const d = buildDigest(
      [
        toolUse('t1', 'Write', { file_path: '/work/app/.mcp.json', content: mcp }),
        toolUse('t2', 'Edit', {
          file_path: '/work/app/.claude/settings.json',
          old_string: '"command": "old-hook"',
          new_string: '"command": "curl -s https://hooks.acme.internal/x?k=s3cr3tvalue"',
        }),
        toolUse('t3', 'Edit', { file_path: '/work/app/CLAUDE.md', old_string: '', new_string: 'Run migrations with QUARRY_DIRECT=1.' }),
      ],
      { projectDir: '/work/app' },
    );
    expect(d.text).not.toContain('correcthorsebattery');
    expect(d.text).not.toContain('db7.corp.acme.internal');
    expect(d.text).not.toContain('s3cr3tvalue');
    expect(d.text).toContain('"DB_PASSWORD": "<REDACTED:config_value>"');
    expect(d.text).toContain('"type": "stdio"');
    expect(d.text).toContain('"POOL": 4');
    expect(d.text).toContain('CONFIG .mcp.json:');
    expect(d.text).toContain('CONFIG CLAUDE.md:\n@@\n+Run migrations with QUARRY_DIRECT=1.');
  });

  it('masks command-line passwords in Bash one-liners', () => {
    const d = buildDigest(
      [
        toolUse('b1', 'Bash', { command: 'mysql -u root -pHunter2Sekrit prod -e "select 1"' }),
        toolUse('b2', 'Bash', { command: 'sshpass -p Wint3rIsComing ssh deploy@10.1.2.3' }),
        toolUse('b3', 'Bash', { command: 'PGPASSWORD=Tr0ub4dor psql -h db -U app' }),
      ],
      {},
    );
    for (const pw of ['Hunter2Sekrit', 'Wint3rIsComing', 'Tr0ub4dor']) expect(d.text).not.toContain(pw);
    expect(d.text).toContain('TOOL Bash: mysql -u root -p<REDACTED:cli_password> prod -e "select 1"');
  });

  it('leaves ordinary commands alone', () => {
    for (const c of ['QUARRY_DIRECT=1 quarry migrate', 'mkdir -p src/lib', 'docker login --password-stdin', 'docker run -u 1000:1000 -p8080:80 img', 'pytest -q']) {
      expect(maskCliSecrets(c)).toBe(c);
    }
    expect(maskCliSecrets('app --password=abc123 run')).toBe('app --password=<REDACTED:cli_password> run');
    expect(maskCliSecrets('curl -u bob:pa55word https://api.example.test')).toBe('curl -u bob:<REDACTED:cli_password> https://api.example.test');
  });
});
