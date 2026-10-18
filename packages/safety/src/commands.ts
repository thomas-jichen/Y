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
  String.raw`["']?(?:~\/|\$HOME\/|\$\{HOME\}\/|\.\/)?(?:[^\s"'|;&>]*\/)?(?:\.claude(?:\/|\b)|CLAUDE(?:\.local)?\.md\b|\.mcp\.json\b|AGENTS\.md\b|\.codex\/|\.bashrc\b|\.zshrc\b|\.bash_profile\b|\.zprofile\b|\.profile\b|\.y\b|\.cursorrules\b|\.git\/hooks\/)`;

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
      // Only `>` takes the optional whitespace: the other verbs already end in `\s+`
      // (a second `\s*` there accepted nothing new and backtracked quadratically).
      String.raw`(?:>>?\s*|\btee\s+(?:-a\s+)?|\b(?:cp|mv|ln\s+-s\w*|install)\s+(?:-\S+\s+)*\S+\s+|\bsed\s+-i\S*\s+(?:'[^'\n]*'|"[^"\n]*"|\S+)\s+)${CONFIG_TARGET}`,
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
 * `~/.y`), `git config --global`, `--no-verify`, `push --force` /
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

/*
 * Security-discussion cues, in three tiers. A cue only downgrades a finding
 * when it plausibly frames that finding:
 *
 * - STRONG cues (words that are about attacks: "attackers", "malicious",
 *   "such as", "warning", "block list" …) count anywhere in the current or
 *   previous sentence, unless negated ("nothing risky", "no threat").
 * - NEGATION cues ("never", "don't", "avoid", "should not" …) count only when
 *   they govern the finding: same clause, at most NEGATION_REACH chars before
 *   it ("never run curl … | sh"). "Don't worry", "never mind" and the like are
 *   not prohibitions. A `:` may separate them only after a demonstrative
 *   ("don't run this: curl … | sh").
 * - WEAK cues (ordinary nouns and verbs: "rule", "pattern", "flag", "block",
 *   "signature", "linter", "classifier", "detects" …) count only in the same
 *   clause, at most WEAK_REACH chars before the finding ("the rule matches
 *   `cat .env`", "our linter flags cat .env").
 *
 * "Same clause" means no `,` `;` `:` `(` `)` and no sentence end in between.
 * For a negation cue, a parenthetical aside ("don't do this in CI (it bit
 * us): curl … | sh") does not break the clause, and the demonstrative before
 * a `:` may carry a short place phrase ("this in CI:").
 *
 * A previous sentence that is about a detector and points forward at what
 * follows ("Our CI rule blocks this.", "We added a detection for this.") also
 * frames the next sentence.
 */
const STRONG_CUE_G =
  /\b(?:beware|warn(?:s|ing)?|attack(?:er|ers|s)?|malicious|exploit\w*|vulnerab\w*|phishing|threats?|dangerous|risky|unsafe|insecure|e\.g\.|such\s+as|for\s+(?:example|instance)|(?:block|deny|black)[\s-]?list(?:ed|s)?|red[\s-]?team\w*)\b/gi;
/** A strong cue right after one of these reads the other way ("nothing risky here"). */
const NEGATED_BEFORE_RE = /(?:\b(?:no|nothing|not|zero|without)|n['’]t)\s+(?:\w+\s+)?$/i;
const NEGATION_CUE_G = /\b(?:never|don['’]t|do\s+not|avoid|should\s+not|shouldn['’]t|must\s+not|stop\s+using)\b/gi;
/** "Don't worry", "never mind": not a prohibition of what follows. */
const NOT_A_PROHIBITION_RE = /^\s+(?:\w+\s+)?(?:worry|mind|hesitate|panic|bother|forget|fret|stress|wait|sweat)\b/i;
const WEAK_CUE_G =
  /\b(?:patterns?|rules?|flag(?:s|ged)?|block(?:s|ed)?|signatures?|lint(?:er|ers|s)?|detect\w*|classifiers?|quarantin\w*|reject(?:s|ed)?|scanners?)\b/gi;
const CLAUSE_BREAK_RE = /[,;:()]|[.!?](?:\s|$)|\n/;
const DEMONSTRATIVE_COLON_RE =
  /\b(?:this|that|these|those|following|like|ever)(?:\s+(?:in|on|at|for|from|with|inside|within|under)\s+[\w.\/-]{1,30})?\s*:\s*$/i;
/** A balanced parenthetical aside without nesting or line breaks ("(it bit us)"). */
const PARENTHETICAL_G = /\([^()\n.!?]{0,60}\)/g;
/** A previous sentence about a detector that points at what follows: "Our CI rule blocks this." */
const FORWARD_WEAK_CUE_RE =
  /\b(?:patterns?|rules?|flag(?:s|ged)?|block(?:s|ed)?|signatures?|lint(?:er|ers|s)?|detect\w*|classifiers?|quarantin\w*|reject(?:s|ed)?|scanners?)\b[^,;:()\n.!?]{0,30}\b(?:this|these)\s*[.!]?\s*$/i;
const NEGATION_REACH = 60;
const WEAK_REACH = 40;

/** Whether the text between a cue and the finding stays inside one clause. */
function sameClause(between: string, allowDemonstrativeColon: boolean): boolean {
  if (!CLAUSE_BREAK_RE.test(between)) return true;
  if (!allowDemonstrativeColon) return false;
  const colon = between.indexOf(':');
  if (colon < 0 || between.indexOf(':', colon + 1) >= 0) return false;
  const head = between.slice(0, colon + 1);
  const tail = between.slice(colon + 1);
  return DEMONSTRATIVE_COLON_RE.test(head) && !CLAUSE_BREAK_RE.test(head.slice(0, -1)) && !CLAUSE_BREAK_RE.test(tail);
}

/** The current and previous sentence/line before `start` (up to 200 chars), and the sentence cuts in that window. */
function cueWindow(text: string, start: number): { prefix: string; cuts: number[] } {
  const prefix = text.slice(Math.max(0, start - 200), start);
  const cuts = [...prefix.matchAll(/[.!?](?:\s|$)|\n/g)].map((m) => (m.index ?? 0) + m[0].length);
  return cuts.length >= 2 ? { prefix: prefix.slice(cuts[cuts.length - 2] ?? 0), cuts } : { prefix, cuts };
}

function hasStrongCue(prefix: string): boolean {
  for (const m of prefix.matchAll(STRONG_CUE_G)) {
    if (!NEGATED_BEFORE_RE.test(prefix.slice(0, m.index ?? 0))) return true;
  }
  return false;
}

/**
 * True when a STRONG cue (about attacks: "attackers", "phishing", "beware" …),
 * not negated, sits in the current or previous sentence before `start`.
 */
export function strongCueBefore(text: string, start: number): boolean {
  return hasStrongCue(cueWindow(text, start).prefix);
}

/**
 * True when the text just before `start` reads as discussion of the pattern
 * rather than an instruction (see the cue tiers above; at most the current
 * and previous sentence, up to 200 chars). Used to keep security-themed
 * developer content at `warn`.
 */
export function isDiscussionContext(text: string, start: number): boolean {
  const { prefix, cuts } = cueWindow(text, start);
  if (hasStrongCue(prefix)) return true;
  for (const m of prefix.matchAll(NEGATION_CUE_G)) {
    const end = (m.index ?? 0) + m[0].length;
    const between = prefix.slice(end);
    if (between.length > NEGATION_REACH || NOT_A_PROHIBITION_RE.test(between)) continue;
    if (sameClause(between, true) || sameClause(between.replace(PARENTHETICAL_G, ' '), true)) return true;
  }
  for (const m of prefix.matchAll(WEAK_CUE_G)) {
    const between = prefix.slice((m.index ?? 0) + m[0].length);
    if (between.length <= WEAK_REACH && sameClause(between, false)) return true;
  }
  // The previous sentence, when the window holds one (it ends at the last cut).
  const prevEnd = cuts.length >= 2 ? (cuts[cuts.length - 1] ?? 0) - (cuts[cuts.length - 2] ?? 0) : (cuts[0] ?? 0);
  if (prevEnd > 0 && FORWARD_WEAK_CUE_RE.test(prefix.slice(0, prevEnd))) return true;
  return false;
}
