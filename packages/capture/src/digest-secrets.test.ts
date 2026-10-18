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

describe('digest: partial config edits, hook scripts, more CLI shapes (review of #5)', () => {
  const cfg = (input: Record<string, unknown>) => buildDigest([toolUse('c1', 'Edit', input)], { projectDir: '/work/app' }).text;

  it('an Edit that changes only a value, or ends inside a string, keeps nothing of the value', () => {
    const onlyValue = cfg({ file_path: '/work/app/.mcp.json', old_string: 'oldpassvalue1', new_string: 'correcthorsebattery' });
    expect(onlyValue).not.toMatch(/oldpassvalue1|correcthorsebattery/);
    expect(onlyValue).toContain('+<REDACTED:config_value>');
    const partial = cfg({ file_path: '/work/app/.mcp.json', old_string: '"DB_PASSWORD": "x', new_string: '"DB_PASSWORD": "partialEditSecret' });
    expect(partial).not.toContain('partialEditSecret');
    expect(partial).toContain('+"DB_PASSWORD": <REDACTED:config_value>');
    const startsInside = cfg({ file_path: '/work/app/.claude/settings.json', old_string: 'a", "x": 1', new_string: 'tailOfSecret9", "x": 1' });
    expect(startsInside).not.toContain('tailOfSecret9');
    // Whole JSON lines still keep their structure and enum values.
    const whole = cfg({ file_path: '/work/app/.mcp.json', old_string: '"type": "stdio",', new_string: '"type": "http", "retries": 3, "enabled": true, "url": "https://mcp.acme.internal/x"' });
    expect(whole).toContain('+"type": "http", "retries": 3, "enabled": true, "url": "<REDACTED:config_value>"');
  });

  it('hook scripts and other non-markdown config under .claude/ are withheld; markdown is kept', () => {
    const sh = buildDigest(
      [
        toolUse('h1', 'Write', { file_path: '/work/app/.claude/hooks/notify.sh', content: '#!/bin/sh\ncurl -H "X-Api: abcdefSECRET" https://x' }),
        toolUse('h2', 'Edit', { file_path: '/work/app/.claude/skills/deploy/SKILL.md', old_string: '', new_string: 'Deploy with the blue/green script.' }),
      ],
      { projectDir: '/work/app' },
    ).text;
    expect(sh).not.toContain('abcdefSECRET');
    expect(sh).toContain('CONFIG .claude/hooks/notify.sh: content withheld');
    expect(sh).toContain('TOOL Write: .claude/hooks/notify.sh (+2/−0)');
    expect(sh).toContain('CONFIG .claude/skills/deploy/SKILL.md:\n@@\n+Deploy with the blue/green script.');
  });

  it('masks more command-line password shapes', () => {
    const cases: [string, string][] = [
      ['DB_PASS=s3cretA ./run', 'DB_PASS=<REDACTED:cli_password> ./run'],
      ['curl -ubob:pw1 https://api.example.test', 'curl -ubob:<REDACTED:cli_password> https://api.example.test'],
      ['docker login -u bob -p DockerPw1 registry.example.test', 'docker login -u bob -p <REDACTED:cli_password> registry.example.test'],
      ['redis-cli -h cache -a RedisPw123 ping', 'redis-cli -h cache -a <REDACTED:cli_password> ping'],
      ['htpasswd -b f bob HtPw1', 'htpasswd -b f bob <REDACTED:cli_password>'],
      ['htpasswd -nb bob HtPw2', 'htpasswd -nb bob <REDACTED:cli_password>'],
      ['wget --http-password=WgetPw1 https://x.example.test', 'wget --http-password=<REDACTED:cli_password> https://x.example.test'],
    ];
    for (const [cmd, want] of cases) expect(maskCliSecrets(cmd)).toBe(want);
    // Not secrets: unchanged.
    for (const c of ['BYPASS_CACHE=1 npm test', 'COMPASS=on ./x', 'htpasswd -c f bob', 'redis-cli ping', 'docker run -p 8080:80 img']) expect(maskCliSecrets(c)).toBe(c);
  });

  it('a Bash command that writes JSON config keeps only the verb and the target', () => {
    const d = buildDigest(
      [
        toolUse('w1', 'Bash', { command: 'cat > /work/app/.mcp.json <<EOF\n{"mcpServers":{"db":{"env":{"DB_PASSWORD":"heredocSecret1"}}}}\nEOF' }),
        toolUse('w2', 'Bash', { command: `echo '{"hooks":{"Stop":[{"command":"curl -d tokenX9 https://x"}]}}' | tee .claude/settings.json` }),
        toolUse('w3', 'Bash', { command: 'echo "Use pnpm." >> CLAUDE.md' }),
        toolUse('w4', 'Bash', { command: 'cat .mcp.json' }),
      ],
      { projectDir: '/work/app' },
    ).text;
    expect(d).not.toMatch(/heredocSecret1|tokenX9/);
    expect(d).toContain('TOOL Bash: cat … ./.mcp.json <REDACTED:config_value>');
    expect(d).toContain('TOOL Bash: echo … .claude/settings.json <REDACTED:config_value>');
    expect(d).toContain('TOOL Bash: echo "Use pnpm." >> CLAUDE.md');
    expect(d).toContain('TOOL Bash: cat .mcp.json');
  });
});

describe('lower-case short password names (round-3 review)', () => {
  it('masks db_pass= and pw= but not pass_through=', async () => {
    const { maskCliSecrets } = await import('./digest.js');
    expect(maskCliSecrets('db_pass=hunter2 ./run')).not.toContain('hunter2');
    expect(maskCliSecrets('pw=s3cret ./run')).not.toContain('s3cret');
    expect(maskCliSecrets('./tool --x pass_through=true')).toContain('pass_through=true');
  });
});
