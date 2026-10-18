/**
 * The command linter (PLAN §10 L0) and shared context heuristics.
 *
 * @module commands
 */

/** One command-linter hit. `rule` ids are stable (`cmd.curl_pipe_sh`). */
export interface CommandFinding {
  rule: string;
  severity: 'warn' | 'block';
  start: number;
  end: number;
}

interface CommandRule {
  rule: string;
  severity: 'warn' | 'block';
  re: RegExp;
}

const CONFIG_TARGET =
  String.raw`["']?(?:~\/|\$HOME\/|\$\{HOME\}\/|\.\/)?(?:[^\s"'|;&>]*\/)?(?:\.claude(?:\/|\b)|CLAUDE(?:\.local)?\.md\b|\.mcp\.json\b|AGENTS\.md\b|\.codex\/|\.bashrc\b|\.zshrc\b|\.bash_profile\b|\.zprofile\b|\.profile\b|\.paceline\b|\.cursorrules\b|\.git\/hooks\/)`;

/** Rules in evaluation order. All `block` except sudo, --no-verify and push --force. */
export const COMMAND_RULES: readonly CommandRule[] = [
  {
    rule: 'cmd.curl_pipe_sh',
    severity: 'block',
    re: /\b(?:curl|wget|iwr|invoke-webrequest)\b[^\n|]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:sh|bash|zsh|dash|ksh|fish|python[0-9.]*|perl|ruby|node|iex)\b|\b(?:sh|bash|zsh)\s+(?:-c\s+)?["']?\$\(\s*(?:curl|wget)\b|\b(?:bash|sh|zsh|source)\s+<\(\s*(?:curl|wget)\b/gi,
  },
  {
    rule: 'cmd.base64_decode_pipe',
    severity: 'block',
    re: /\bbase64\s+(?:-d|--decode|-D)\b[^\n]*\||\|\s*base64\s+(?:-d|--decode|-D)\b/gi,
  },
  {
    rule: 'cmd.eval',
    severity: 'block',
    re: /\beval\s+(?:"\$\(|\$\(|`|"\$|\$[A-Za-z_{])|\beval\s*\(\s*(?:atob|Buffer|decodeURIComponent|unescape|String\.fromCharCode|fetch|require|await)\b/gi,
  },
  {
    rule: 'cmd.env_dump',
    severity: 'block',
    re: /(?:^|[;&|(`]\s*|\$\(\s*)(?:printenv|env|export\s+-p|set)(?=\s*(?:$|[|>;&)`]))|\bprintenv\s*(?=$|[|>;&)`])|\bJSON\.stringify\(\s*process\.env\s*\)|\bos\.environ\b(?!\s*(?:\[|\.get))/gim,
  },
  {
    rule: 'cmd.cat_env',
    severity: 'block',
    re: /\b(?:cat|less|more|head|tail|bat|nl|strings|xxd|base64|scp|source)\s+(?:[^\n|;&`]*?[\s/'"])?\.env(?!\.(?:example|sample|template|dist)\b)(?:\.[\w-]+)?(?![\w/])/gi,
  },
  {
    rule: 'cmd.ssh_dir',
    severity: 'block',
    re: /\b(?:cat|less|more|head|tail|cp|scp|rsync|tar|zip|base64|xxd|curl|nc|read|print|send|upload|share|paste|open)\b[^\n]{0,80}\.ssh\/(?![\w.-]*\.pub\b|known_hosts\b|config\b)[\w.-]+|\bid_(?:rsa|ed25519|ecdsa|dsa)\b(?!\.pub)|~\/\.ssh\/?(?=\s|$|["'`])/gi,
  },
  {
    rule: 'cmd.aws_credentials',
    severity: 'block',
    re: /\.aws\/credentials\b/gi,
  },
  {
    rule: 'cmd.credential_store',
    severity: 'block',
    re: /~\/\.netrc\b|\.git-credentials\b|~\/\.docker\/config\.json\b|\.config\/gh\/hosts\.yml\b|\bsecurity\s+find-(?:generic|internet)-password\b|~\/\.npmrc\b(?=[^\n]*(?:cat|curl|base64|send))/gi,
  },
  {
    rule: 'cmd.config_write',
    severity: 'block',
    re: new RegExp(
      String.raw`(?:>>?|\btee\s+(?:-a\s+)?|\b(?:cp|mv|ln\s+-s\w*|install)\s+(?:-\S+\s+)*\S+\s+|\bsed\s+-i\S*\s+(?:'[^'\n]*'|"[^"\n]*"|\S+)\s+)\s*${CONFIG_TARGET}`,
      'gi',
    ),
  },
  {
    rule: 'cmd.git_config_global',
    severity: 'block',
    re: /\bgit\s+config\s+(?:--global|--system)\b/gi,
  },
  {
    rule: 'cmd.tls_disable',
    severity: 'block',
    re: /\bNODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|\bGIT_SSL_NO_VERIFY\s*=\s*['"]?(?:1|true)|\bPYTHONHTTPSVERIFY\s*=\s*['"]?0|\bcurl\b[^\n]*\s(?:-k|--insecure)\b/gi,
  },
  {
    rule: 'cmd.skip_permissions',
    severity: 'block',
    re: /--dangerously-skip-permissions\b|\bbypassPermissions\b|--permission-mode\s+bypass\w*/gi,
  },
  {
    rule: 'cmd.egress',
    severity: 'block',
    re: /\b(?:nc|ncat|netcat)\b[^\n]*\s-e\s|\/dev\/tcp\/|\bcurl\b[^\n]*\s(?:-d|--data(?:-binary|-raw|-urlencode)?|-F|--form|-T|--upload-file)\s+["']?@|\bcurl\b[^\n]*\$\(\s*(?:cat|env|printenv|base64)\b/gi,
  },
  {
    rule: 'cmd.rm_rf_root',
    severity: 'block',
    re: /\brm\s+-(?:rf|fr|Rf|fR)\s+(?:--no-preserve-root\s+)?(?:\/|~|\$HOME|\*)(?=\s|$|\/\*|\/\s)/g,
  },
  { rule: 'cmd.sudo', severity: 'warn', re: /\bsudo\s+(?!-l\b)[a-z-]/gi },
  { rule: 'cmd.no_verify', severity: 'warn', re: /--no-verify\b/gi },
  { rule: 'cmd.push_force', severity: 'warn', re: /\bgit\s+push\b[^\n]*\s(?:--force(?:-with-lease)?\b|-f\b)/gi },
];

/**
 * The command linter (PLAN §10 L0): finds dangerous shell patterns in any
 * text (fenced or inline): `curl|wget … | sh|bash|zsh|python`,
 * `base64 -d|--decode … |`, `eval`, `printenv`/`env` dumps, `cat .env*`,
 * `~/.ssh`, `.aws/credentials`, writes (`>`, `>>`, `tee`, `cp`, `mv`, `sed -i`)
 * to agent config or rc files (`.claude/`, `CLAUDE*.md`, `.mcp.json`,
 * `AGENTS.md`, `~/.codex/`, `~/.bashrc`, `~/.zshrc`, `~/.profile`,
 * `~/.paceline`), `git config --global`, `--no-verify`, `push --force` /
 * `-f`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `sudo`,
 * `--dangerously-skip-permissions`. All `block` except `sudo`,
 * `--no-verify` and `push --force` (`warn`). Also used by the PreToolUse
 * guard on Bash commands when the session is tainted.
 */
export function lintCommands(text: string): CommandFinding[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const out: CommandFinding[] = [];
  for (const { rule, severity, re } of COMMAND_RULES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      out.push({ rule, severity, start, end: start + m[0].length });
      if (out.length >= 150) return out;
    }
  }
  return out.sort((a, b) => a.start - b.start || a.rule.localeCompare(b.rule));
}

/** Words that mark prose *about* a pattern (security discussion) rather than an instruction to perform it. */
const DISCUSSION_RE =
  /\b(?:never|don['’]t|do\s+not|avoid|beware|warn(?:s|ing)?|attack(?:er|ers|s)?|malicious|exploit\w*|vulnerab\w*|phishing|threat|dangerous|risky|unsafe|insecure|e\.g\.|such\s+as|for\s+example|pattern|signature|detect\w*|flag(?:s|ged)?|block(?:s|ed)?|lint(?:er|s)?|classifier|rule|quarantin\w*|reject(?:s|ed)?|should\s+not|shouldn['’]t|must\s+not|stop\s+using)\b/i;

/**
 * True when the text just before `start` (the current sentence and the one
 * before it, up to 200 chars) reads as discussion of the pattern rather than
 * an instruction. Used to keep security-themed developer content at `warn`.
 */
export function isDiscussionContext(text: string, start: number): boolean {
  const windowStart = Math.max(0, start - 200);
  let prefix = text.slice(windowStart, start);
  // keep at most the current and previous sentence/line
  const cuts = [...prefix.matchAll(/[.!?](?:\s|$)|\n/g)].map((m) => (m.index ?? 0) + m[0].length);
  if (cuts.length >= 2) prefix = prefix.slice(cuts[cuts.length - 2] ?? 0);
  return DISCUSSION_RE.test(prefix);
}
