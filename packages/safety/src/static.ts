/**
 * Static checks SC001–SC018 for shared skills and CLAUDE.md blocks (PLAN §10).
 *
 * @module static
 */
import { INVISIBLE_CHARS_SOURCE, STATIC_RULES, type StaticFinding, type StaticOutcome, type StaticRuleId } from '@y/schema';
import { isDiscussionContext, lintCommands } from './commands.js';
import { l0Scan } from './l0.js';

/** Result of {@link staticCheckSkill}. */
export interface StaticReport {
  outcome: StaticOutcome;
  findings: StaticFinding[];
  /**
   * The content as it would be applied: frontmatter keys `allowed-tools`,
   * `hooks` and `context` removed (each removal is an SC010 warn finding).
   * `null` when the outcome is `fail` (never applied).
   */
  sanitized: string | null;
}

/** Limits enforced by SC015. */
export const STATIC_LIMITS = { maxBytes: 32_000, maxLines: 600, maxLineLength: 2_000 } as const;

const CMD_TO_SC: Readonly<Record<string, StaticRuleId>> = {
  'cmd.curl_pipe_sh': 'SC001',
  'cmd.base64_decode_pipe': 'SC002',
  'cmd.eval': 'SC002',
  'cmd.ssh_dir': 'SC003',
  'cmd.aws_credentials': 'SC003',
  'cmd.credential_store': 'SC003',
  'cmd.cat_env': 'SC003',
  'cmd.env_dump': 'SC004',
  'cmd.egress': 'SC005',
  'cmd.config_write': 'SC006',
  'cmd.git_config_global': 'SC006',
  'cmd.skip_permissions': 'SC013',
  'cmd.tls_disable': 'SC005',
  'cmd.rm_rf_root': 'SC002',
};

const STRIPPED_FRONTMATTER_KEYS = ['allowed-tools', 'hooks', 'context'] as const;

interface LineRule {
  rule: StaticRuleId;
  re: RegExp;
  message: string;
  /** Skip when the line reads as security discussion and is not in a code fence. */
  discussable?: boolean;
}

const LINE_RULES: readonly LineRule[] = [
  {
    rule: 'SC006',
    re: /\b(?:add|append|write|insert|edit|modify|update|change|put|overwrite)\b[^\n.]{0,60}\b(?:to|in|into)\s+(?:your\s+|the\s+)?(?:~\/)?(?:\.claude\/settings(?:\.local)?\.json|\.claude\/|CLAUDE(?:\.local)?\.md|\.mcp\.json|AGENTS\.md|\.bashrc|\.zshrc|settings\.json|\.codex\/)/i,
    message: 'Instructs editing agent config or shell rc files.',
    discussable: true,
  },
  { rule: 'SC009', re: /!`[^`\n]+`/, message: 'Skill bang-exec line (!`cmd`).' },
  {
    rule: 'SC013',
    re: /\bBash\(\s*\*\s*\)|\ballowed-tools\s*:\s*["']?\*|"permissions"\s*:\s*\{[^}]*"\*"|\bbypassPermissions\b/i,
    message: 'Permission wildcard.',
  },
  {
    rule: 'SC012',
    re: /"hooks"\s*:|\b(?:PreToolUse|PostToolUse|SessionStart|UserPromptSubmit)\b\s*["']?\s*:/,
    message: 'Hook or settings content (display only, never applied).',
  },
  {
    rule: 'SC016',
    re: /\b(?:send|post|email|dm|message|tweet|notify|ping|open\s+(?:an?\s+)?(?:issue|pr|pull\s+request))\b[^\n]{0,50}\b(?:to|on|at)\s+(?:@[\w-]+|https?:\/\/|[\w.+-]+@[\w-]+\.[\w.]+|slack|discord|twitter|x\.com|github\s+issues?)|\b(?:call|use)\s+`?(?:send_message|ask_builder|post_activity)\b/i,
    message: 'Tells the agent to contact third parties.',
    discussable: true,
  },
  {
    rule: 'SC017',
    re: /\b(?:curl|wget|fetch|download|read|load)\b[^\n]{0,80}https?:\/\/\S+[^\n]{0,60}\b(?:and|then)\s+(?:follow|execute|run|apply|obey)\b|\b(?:fetch|download|load|read)\s+(?:the\s+)?(?:latest\s+|current\s+|updated\s+)?(?:instructions|rules|prompt|skill|config)\s+from\s+https?:/i,
    message: 'Fetches instructions or code at runtime.',
    discussable: true,
  },
  {
    rule: 'SC007',
    re: /\b(?:you\s+must|first|before\s+(?:using|running)[^\n]{0,30}|required:?)\s+(?:install|download)\b[^\n]{0,80}https?:\/\/(?!(?:www\.)?(?:github\.com|npmjs\.com|pypi\.org|nodejs\.org)\b)/i,
    message: 'Instructs installing a "required" tool from an unofficial source.',
    discussable: true,
  },
];

const INVISIBLE_RE = new RegExp(INVISIBLE_CHARS_SOURCE);

function finding(rule: StaticRuleId, line: number, message: string): StaticFinding {
  return { rule, severity: STATIC_RULES[rule].severity, line, message: message.slice(0, 300) };
}

/** Strip `allowed-tools`, `hooks` and `context` (with their indented continuation lines) from YAML frontmatter. */
function stripFrontmatter(content: string, findings: StaticFinding[]): string {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return content;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return content;
  const kept: string[] = [lines[0] ?? '---'];
  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? '';
    const key = /^([A-Za-z_-]+)\s*:/.exec(line)?.[1]?.toLowerCase();
    if (key && (STRIPPED_FRONTMATTER_KEYS as readonly string[]).includes(key)) {
      findings.push(finding('SC010', i + 1, `Frontmatter key ${key} stripped before apply.`));
      while (i + 1 < end && /^(?:\s+|-\s)/.test(lines[i + 1] ?? '')) i++;
      continue;
    }
    kept.push(line);
  }
  return [...kept, ...lines.slice(end)].join('\n');
}

/**
 * Static checks SC001–SC018 (`STATIC_RULES` in the schema) over a shared
 * skill or CLAUDE.md block. Line numbers are 1-based (0 = whole file).
 * `outcome` is `fail` if any finding has severity `fail`, `warn` if any
 * `warn`, else `pass`. Security-themed prose (explaining an attack) is not
 * flagged unless it contains an executable instruction (a command inside a
 * code fence, or a command/instruction outside a discussion context).
 * Deterministic. Not implemented yet: SC011 (typosquats).
 */
export function staticCheckSkill(content: string, kind: 'skill' | 'claude_md_block' = 'skill'): StaticReport {
  const text = typeof content === 'string' ? content : '';
  const findings: StaticFinding[] = [];
  const seen = new Set<string>();
  const add = (f: StaticFinding) => {
    const key = `${f.rule}:${f.line}`;
    if (seen.has(key) || findings.length >= 200) return;
    seen.add(key);
    findings.push(f);
  };

  // SC014 binary, SC015 size
  if (/\u0000/.test(text) || (text.match(/[\u0001-\u0008\u000E-\u001F]/g)?.length ?? 0) > 8) add(finding('SC014', 0, 'Binary or non-text content.'));
  const bytes = new TextEncoder().encode(text).length;
  const lines = text.split('\n');
  if (bytes > STATIC_LIMITS.maxBytes) add(finding('SC015', 0, `Exceeds ${STATIC_LIMITS.maxBytes} bytes.`));
  if (lines.length > STATIC_LIMITS.maxLines) add(finding('SC015', 0, `Exceeds ${STATIC_LIMITS.maxLines} lines.`));

  // Fence map and line offsets.
  const inFence: boolean[] = [];
  const offsets: number[] = [];
  {
    let fence = false;
    let pos = 0;
    for (const l of lines) {
      const isFence = /^\s*(?:```|~~~)/.test(l);
      inFence.push(fence || isFence);
      if (isFence) fence = !fence;
      offsets.push(pos);
      pos += l.length + 1;
    }
  }
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((offsets[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  lines.forEach((l, i) => {
    if (l.length > STATIC_LIMITS.maxLineLength) add(finding('SC015', i + 1, `Line exceeds ${STATIC_LIMITS.maxLineLength} chars.`));
  });

  // Commands (SC001–SC006, SC013 …)
  for (const c of lintCommands(text)) {
    const sc = CMD_TO_SC[c.rule];
    if (!sc) continue;
    const li = lineOf(c.start);
    if (!inFence[li] && isDiscussionContext(text, c.start)) continue;
    add(finding(sc, li + 1, `${STATIC_RULES[sc].description} (${c.rule})`));
  }

  // Line rules
  lines.forEach((l, i) => {
    for (const r of LINE_RULES) {
      const m = r.re.exec(l);
      if (!m) continue;
      if (r.discussable && !inFence[i] && isDiscussionContext(text, (offsets[i] ?? 0) + (m.index ?? 0))) continue;
      add(finding(r.rule, i + 1, r.message));
    }
  });

  // SC008 obfuscation: long blobs, mixed-script words, string splitting of commands.
  lines.forEach((l, i) => {
    if (/[A-Za-z0-9+/_-]{200,}={0,2}/.test(l) || /\b[0-9a-fA-F]{200,}\b/.test(l)) add(finding('SC008', i + 1, 'Long encoded blob.'));
    if (/(?=[^\s]*[A-Za-z])(?=[^\s]*[Ѐ-ӿͰ-Ͽ])[^\s]{3,}/.test(l) && /\b[A-Za-z]*[Ѐ-ӿͰ-Ͽ]+[A-Za-z]+|[A-Za-z]+[Ѐ-ӿͰ-Ͽ]+/.test(l)) {
      add(finding('SC008', i + 1, 'Mixed-script (homoglyph) word.'));
    }
    if (/["'](?:c|cu|cur)["']\s*\+\s*["'](?:rl|url|l)["']|["'](?:ev|e)["']\s*\+\s*["'](?:al|val)["']|\$\{?IFS\}?/.test(l)) {
      add(finding('SC008', i + 1, 'String splitting to evade review.'));
    }
  });

  // SC018 hidden or agent-addressed override text.
  lines.forEach((l, i) => {
    if (INVISIBLE_RE.test(l) || /[\u{E0000}-\u{E007F}]/u.test(l)) add(finding('SC018', i + 1, 'Invisible or bidi-control characters.'));
    if (/<!--/.test(l)) add(finding('SC018', i + 1, 'HTML comment (hidden from rendered view).'));
  });
  const l0 = l0Scan(text, 'shared_component');
  for (const f of l0.findings) {
    if (f.severity !== 'block' || !f.span) continue;
    if (f.category !== 'injection_phrase' && f.rule !== 'agent.addressed') continue;
    add(finding('SC018', lineOf(f.span.start) + 1, `Agent-addressed override text (${f.rule}).`));
  }

  let sanitized: string | null = stripFrontmatter(text, findings);
  if (kind === 'claude_md_block' && /^---\n/.test(text)) add(finding('SC012', 1, 'Frontmatter in a CLAUDE.md block (display only).'));
  findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
  const outcome: StaticOutcome = findings.some((f) => f.severity === 'fail') ? 'fail' : findings.some((f) => f.severity === 'warn') ? 'warn' : 'pass';
  if (outcome === 'fail') sanitized = null;
  return { outcome, findings, sanitized };
}
