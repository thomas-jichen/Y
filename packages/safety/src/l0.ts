/**
 * L0: deterministic rules (< 10 ms), inline everywhere (PLAN §10).
 *
 * @module l0
 */
import { scanSecrets } from '@y/redact';
import { INVISIBLE_CHARS_SOURCE, TOOL_NAMES, type ContentClass, type L0Finding, type L0Result, type Label } from '@y/schema';
import { isDiscussionContext, lintCommands } from './commands.js';
import { normalizeUntrusted } from './normalize.js';

/** Options for {@link l0Scan}. */
export interface L0Options {
  /** Extra allowlisted hosts (e.g. the Y host, docs domains of claimed products). */
  allowedHosts?: readonly string[];
}

/** Hosts whose URLs are not flagged. Subdomains of these are allowed too. */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
  'github.com',
  'npmjs.com',
  'npmjs.org',
  'pypi.org',
  'python.org',
  'nodejs.org',
  'developer.mozilla.org',
  'typescriptlang.org',
  'stackoverflow.com',
  'y.dev',
  'localhost',
  '127.0.0.1',
];

/** Agent-callable tools that write or send (calling these on someone's say-so is an attack signal). */
const WRITE_TOOLS = new Set([
  'send_message',
  'post_activity',
  'propose_setup_change',
  'update_thread',
  'ask_builder',
  'report_outcome',
  'create_post',
  'scroll_action',
]);
const ALL_TOOLS = (TOOL_NAMES as readonly string[]).join('|');

interface PhraseRule {
  rule: string;
  category: L0Finding['category'];
  severity: 'warn' | 'block';
  re: RegExp;
  /** Can be downgraded to warn in a security-discussion context. */
  discussable?: boolean;
}

const PHRASE_RULES: readonly PhraseRule[] = [
  {
    rule: 'inj.ignore_previous',
    category: 'injection_phrase',
    severity: 'block',
    discussable: true,
    re: /\b(?:ignore|disregard|forget|override|bypass)\s+(?:(?:all|any|the|your|my|of|these|those)\s+)*(?:(?:previous|prior|above|earlier|preceding|initial|original|system|safety|existing|developer|current)\s+)+(?:instructions?|prompts?|rules|guidelines|directives|guardrails|messages?|context)\b|\b(?:ignore|disregard|forget)\s+(?:(?:all|any|the|your|my)\s+)*(?:instructions?|guardrails|directives)\b/gi,
  },
  {
    rule: 'inj.you_are_now',
    category: 'injection_phrase',
    severity: 'block',
    discussable: true,
    re: /\byou\s+are\s+now\s+(?:an?\s+(?:\w+\s+)?(?:ai|assistant|agent|model|bot|hacker|admin|root|unrestricted|unfiltered)\b|in\s+(?:developer|god|admin|debug|dan|jailbreak|unrestricted)\s+mode|dan\b|jailbroken|unrestricted|unfiltered|free\s+(?:from|of)|no\s+longer\s+(?:bound|restricted|an?\s+))/gi,
  },
  {
    rule: 'inj.system_prompt',
    category: 'injection_phrase',
    severity: 'block',
    discussable: true,
    re: /\b(?:reveal|print|show|output|repeat|leak|dump|share|ignore|override|disregard|tell\s+me|what\s+is)\s+(?:me\s+)?(?:your|the)\s+(?:full\s+|entire\s+|hidden\s+|original\s+|initial\s+)?system\s+prompt\b|\bnew\s+system\s+prompt\b|\bsystem\s+prompt\s*(?:override|update)\s*:/gi,
  },
  { rule: 'inj.system_prompt_mention', category: 'injection_phrase', severity: 'warn', re: /\bsystem\s+prompt\b/gi },
  {
    rule: 'inj.developer_mode',
    category: 'injection_phrase',
    severity: 'block',
    discussable: true,
    re: /\b(?:developer|god|admin|dan|jailbreak|unrestricted)\s+mode\s+(?:is\s+)?(?:now\s+)?(?:enabled|activated|on)\b|\b(?:enable|enter|activate)\s+(?:developer|god|dan|jailbreak|unrestricted)\s+mode\b/gi,
  },
  { rule: 'inj.jailbreak_mention', category: 'injection_phrase', severity: 'warn', re: /\bjailbr(?:eak|oken)\w*\b/gi },
  {
    rule: 'inj.role_tag',
    category: 'injection_phrase',
    severity: 'block',
    re: /<\/?\s*(?:system|assistant|human|instructions?|im_start|im_end|system-reminder)\s*>|\[\/?INST\]|<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>|<<\/?SYS>>|^\s*#{1,3}\s*(?:system|new\s+instructions?)\s*:/gim,
  },
  {
    rule: 'inj.delimiter_spoof',
    category: 'injection_phrase',
    severity: 'block',
    re: /[<‹]\/?\s*(?:untrusted|y)[\w-]*/gi,
  },
  {
    rule: 'inj.envelope_spoof',
    category: 'injection_phrase',
    severity: 'block',
    re: /["']?(?:y_?envelope|untrusted_?content)["']?\s*:/gi,
  },
  {
    rule: 'inj.fake_pointer',
    category: 'injection_phrase',
    severity: 'block',
    re: /(?:^|\n)[ \t>*-]*y\s*:|\by\s*:\s*[^\n]{0,160}\b(?:call|run|tell\s+your\s+human|stop\s+using)\b/gi,
  },
  {
    rule: 'agent.addressed',
    category: 'agent_imperative',
    severity: 'block',
    re: /\bas\s+an?\s+(?:ai|llm|language\s+model|coding\s+agent|ai\s+agent|agent|assistant)\b[^.\n]{0,40}\b(?:you|must|should|need|are\s+required)\b|\bif\s+you\s+are\s+an?\s+(?:ai|llm|language\s+model|agent|assistant|bot|coding\s+agent|ai\s+agent)\b|\b(?:attention|note|message|instructions?)\s+(?:to|for)\s+(?:the\s+|any\s+|all\s+)?(?:ai|llm|agent|assistant|claude|codex|model)s?\b|\b(?:dear|hey|hi|hello|attention)\s+(?:ai|llm|agent|assistant|claude|codex|model)\b|\b(?:ai|llm|coding)\s+(?:agents?|assistants?|models?)\s+(?:reading|processing|parsing|seeing|that\s+reads?)\s+this|\b(?:any|all|other)?\s*(?:ai\s+)?agents?\s+(?:reading|that\s+reads?|seeing|processing)\s+this\b|\bto\s+(?:the\s+)?(?:ai|agent|assistant|model)\s+reading\s+this/gi,
  },
  {
    rule: 'agent.tool_call',
    category: 'agent_imperative',
    severity: 'block',
    re: new RegExp(String.raw`\b(?:call|use|invoke|run|trigger)\s+(?:the\s+)?\x60?(?:${ALL_TOOLS})\x60?(?:\s+tool)?\b`, 'gi'),
  },
  {
    rule: 'agent.exfil_request',
    category: 'agent_imperative',
    severity: 'block',
    discussable: true,
    // Each whitespace run has one owner (the original `\s+(?:me|…)?\s*(?:back\s+)?…(?:your|…)?\s*`
    // accepted the same strings but backtracked cubically on a verb followed by many spaces).
    re: /\b(?:send|post|upload|share|paste|give|email|forward|leak|dm|reply\s+with|include)\s+(?:(?:me|us|it|them|back)\s*)?(?:back\s+)?(?:the\s+contents\s+of\s+)?(?:(?:your|the|all|any)\s*)?(?:own\s+)?(?:api[\s_-]?keys?|access\s+tokens?|auth\s+tokens?|tokens?|credentials?|secrets?|passwords?|env(?:ironment)?\s+(?:vars?|variables?|file)|\.env(?:\s+file)?|ssh\s+keys?|private\s+keys?|id_rsa|cookies?|session\s+tokens?|aws\s+keys?)\b|\bexfiltrat\w*/gi,
  },
  {
    rule: 'agent.conceal',
    category: 'agent_imperative',
    severity: 'warn',
    re: /\b(?:do\s+not|don['’]t|never)\s+(?:tell|inform|mention\s+(?:this|it)\s+to|notify|alert|ask)\s+(?:the\s+|your\s+)?(?:user|human|owner|operator)\b|\bwithout\s+(?:telling|asking|informing|notifying|alerting)\s+(?:the\s+|your\s+)?(?:user|human|owner|operator)\b|\bkeep\s+this\s+(?:secret|hidden|between\s+us)\b|\bsilently\s+(?:run|execute|send|upload|install|apply)\b/gi,
  },
  {
    rule: 'agent.run_following',
    category: 'agent_imperative',
    severity: 'warn',
    re: /\b(?:run|execute|paste|type|exec)\s+(?:the\s+)?(?:following|this|these|below)(?:\s+(?:command|commands|script|code|snippet|line))?\b/gi,
  },
];

/** Rules whose presence means the text addresses or instructs the reading agent (no discussion downgrade). */
const IMPERATIVE_RULES = new Set([
  'agent.addressed',
  'agent.tool_call',
  'agent.conceal',
  'agent.run_following',
  'inj.role_tag',
  'inj.delimiter_spoof',
  'inj.envelope_spoof',
  'inj.fake_pointer',
]);

const BLOB_RES: readonly { rule: string; re: RegExp }[] = [
  { rule: 'blob.base64', re: /[A-Za-z0-9+/_-]{200,}={0,2}/g },
  { rule: 'blob.hex', re: /\b(?:0x)?[0-9a-fA-F]{200,}\b/g },
  { rule: 'blob.data_uri', re: /\bdata:[a-z]+\/[a-z0-9.+-]+;base64,/gi },
];

const URL_RE = /\bhttps?:\/\/([^\s<>"'`)\]/?#:]+)[^\s<>"'`)\]]*/gi;

const INVISIBLE_G = new RegExp(INVISIBLE_CHARS_SOURCE, 'g');

/** Same-length confusable fold (Cyrillic/Greek look-alikes → Latin) so spans stay valid. */
const CONFUSABLES: Readonly<Record<string, string>> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', һ: 'h', ԁ: 'd', ɡ: 'g', ո: 'n',
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', І: 'I',
  ο: 'o', α: 'a', ε: 'e', ι: 'i', ν: 'v', κ: 'k', ρ: 'p', τ: 't', υ: 'u', Ο: 'O', Α: 'A', Ε: 'E', Ι: 'I', Κ: 'K', Ν: 'N', Ρ: 'P', Τ: 'T',
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'g');
function foldConfusables(text: string): { text: string; folded: number } {
  let folded = 0;
  const out = text.replace(CONFUSABLE_RE, (c) => {
    folded++;
    return CONFUSABLES[c] ?? c;
  });
  return { text: out, folded };
}

/** More look-alikes, folded only in the {@link deepView} (dotless i, palochka, lunate sigma, Latin alpha, Armenian o/u/h, Cyrillic qa/we). */
const EXTRA_CONFUSABLES: Readonly<Record<string, string>> = {
  ı: 'i', ɩ: 'i', ӏ: 'l', Ӏ: 'I', ϲ: 'c', Ϲ: 'C', ɑ: 'a', օ: 'o', Օ: 'O', ս: 'u', հ: 'h', ԛ: 'q', ԝ: 'w', ѵ: 'v',
};
/** Dropped from the deep view: variation selectors (emoji/ideographic variants), combining marks, invisible/bidi and tag characters. */
const DEEP_DROP_RE = new RegExp(`^(?:[\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}\\u{E0000}-\\u{E007F}]|\\p{M}|${INVISIBLE_CHARS_SOURCE})$`, 'u');

/** A second scanning view with a map from each of its code units back to the original text. */
interface DeepView {
  text: string;
  /** Original start / end offsets of the character each view code unit came from. */
  from: number[];
  to: number[];
}

/**
 * The deep view: like the confusable fold, but also drops variation
 * selectors, combining marks (after NFD, so `ė` reads as `e`) and invisible
 * characters, and folds {@link EXTRA_CONFUSABLES}. It can be shorter than the
 * text, so spans are mapped back. `null` when it adds nothing (ASCII text, or
 * the same as the plain fold). Findings from it are added to, never
 * replace, the plain view's (folding can also remove a word boundary).
 */
function deepView(text: string, plain: string): DeepView | null {
  if (!/[^\x00-\x7F]/.test(text)) return null;
  let out = '';
  const from: number[] = [];
  const to: number[] = [];
  let pos = 0;
  for (const ch of text) {
    const start = pos;
    pos += ch.length;
    if (DEEP_DROP_RE.test(ch)) continue;
    let piece = ch;
    if (/[^\x00-\x7F]/.test(ch)) {
      const nfd = ch.normalize('NFD');
      const base = nfd.replace(/\p{M}/gu, '');
      if (base && base !== nfd) piece = base;
      piece = [...piece].map((c) => CONFUSABLES[c] ?? EXTRA_CONFUSABLES[c] ?? c).join('');
    }
    out += piece;
    for (let k = 0; k < piece.length; k++) {
      from.push(start);
      to.push(pos);
    }
  }
  return out === plain ? null : { text: out, from, to };
}

/** Raw rule hits over one view (phrases, commands, blobs), spans in that view. */
function viewHits(view: string): L0Finding[] {
  const out: L0Finding[] = [];
  for (const r of PHRASE_RULES) {
    r.re.lastIndex = 0;
    for (const m of view.matchAll(r.re)) {
      const start = m.index ?? 0;
      if (r.rule === 'agent.tool_call') {
        const tool = /(?:call|use|invoke|run|trigger)\s+(?:the\s+)?`?([a-z_]+)/i.exec(m[0])?.[1]?.toLowerCase() ?? '';
        out.push({ rule: r.rule, category: r.category, severity: WRITE_TOOLS.has(tool) ? 'block' : 'warn', span: { start, end: start + m[0].length } });
        continue;
      }
      out.push({ rule: r.rule, category: r.category, severity: r.severity, span: { start, end: start + m[0].length } });
    }
  }
  return out;
}

function commandAndBlobHits(view: string): L0Finding[] {
  const out: L0Finding[] = [];
  for (const c of lintCommands(view)) {
    out.push({ rule: c.rule, category: 'command', severity: c.severity, span: { start: c.start, end: c.end } });
  }
  for (const { rule, re } of BLOB_RES) {
    re.lastIndex = 0;
    for (const m of view.matchAll(re)) {
      if (rule === 'blob.base64' && !/[0-9]/.test(m[0])) continue;
      const start = m.index ?? 0;
      out.push({ rule, category: 'blob', severity: 'block', span: { start, end: start + m[0].length } });
    }
  }
  return out;
}

const squashedHit = (view: string) => SQUASHED_RE.test(view.toLowerCase().replace(/[^a-z]/g, ''));

/** Squashed (letters only) phrases that survive spacing/punctuation splitting tricks. */
const SQUASHED_RE = /(?:ignore|disregard|forget)(?:all|any|the|your)*(?:previous|prior|above|earlier)+(?:instructions?|prompts?|rules)|youarenow(?:dan|jailbroken|unrestricted)|revealyoursystemprompt/;

/** Local fallback secret patterns, used only if `@y/redact` is unavailable (throws). */
const FALLBACK_SECRET_RES: readonly { ruleId: string; re: RegExp }[] = [
  { ruleId: 'github_pat', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g },
  { ruleId: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { ruleId: 'openai_key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { ruleId: 'aws_access_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { ruleId: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { ruleId: 'stripe_key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g },
  { ruleId: 'private_key', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g },
  { ruleId: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];

/** A secret hit (span only). */
export interface SecretSpan {
  ruleId: string;
  start: number;
  end: number;
}

/**
 * Secrets via `@y/redact`'s `scanSecrets`; if that throws (not
 * available), a small local pattern set so detection never silently drops
 * to zero (I8: a failed check never raises trust).
 */
export function findSecrets(text: string): SecretSpan[] {
  try {
    const hits = scanSecrets(text);
    if (Array.isArray(hits)) return hits.map((h) => ({ ruleId: h.ruleId, start: h.start, end: h.end }));
  } catch {
    // fall through to the local patterns
  }
  const out: SecretSpan[] = [];
  for (const { ruleId, re } of FALLBACK_SECRET_RES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) out.push({ ruleId, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

/** Make an arbitrary id fit the L0Finding rule grammar (`^[a-z0-9]+(?:[._][a-z0-9]+)*$`, ≤ 64). */
export function ruleId(prefix: string, raw: string): string {
  const body = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${prefix}.${body || 'unknown'}`.slice(0, 64).replace(/[._]+$/, '');
}

function hostAllowed(host: string, extra: readonly string[] | undefined): boolean {
  const h = host.toLowerCase();
  if (/^docs?\./.test(h)) return true;
  return listedHost(h, extra);
}

function listedHost(host: string, extra: readonly string[] | undefined): boolean {
  const h = host.toLowerCase();
  return [...DEFAULT_ALLOWED_HOSTS, ...(extra ?? [])].some((a) => h === a || h.endsWith(`.${a}`));
}

/** Whether a content class always goes to L2 (setups, stranger DMs and builder answers do). */
export function requiresL2(contentClass: ContentClass): boolean {
  return contentClass === 'shared_component' || contentClass === 'dm_stranger' || contentClass === 'builder_answer';
}

/** Raw findings for `text` (no discussion downgrade, no label). */
function collectFindings(text: string, opts?: L0Options): L0Finding[] {
  const findings: L0Finding[] = [];
  const push = (f: L0Finding) => {
    if (findings.length < 200) findings.push(f);
  };
  const { text: view } = foldConfusables(text);

  for (const f of viewHits(view)) push(f);
  const splitPhrase = () => !findings.some((f) => f.rule === 'inj.ignore_previous' || f.rule === 'inj.you_are_now' || f.rule === 'inj.split_phrase');
  if (splitPhrase() && squashedHit(view)) {
    push({ rule: 'inj.split_phrase', category: 'injection_phrase', severity: 'block' });
  }
  for (const f of commandAndBlobHits(view)) push(f);

  // Deep view (variation selectors, combining marks, more look-alikes): extra hits only.
  const deep = deepView(text, view);
  if (deep) {
    const key = (f: L0Finding) => `${f.rule}:${f.span?.start ?? -1}:${f.span?.end ?? -1}`;
    const seen = new Set(findings.map(key));
    const mapSpan = (f: L0Finding): L0Finding => {
      if (!f.span) return f;
      const { start, end } = f.span;
      const s = deep.from[start] ?? text.length;
      const e = end > start ? (deep.to[end - 1] ?? text.length) : s;
      return { ...f, span: { start: s, end: Math.max(s, e) } };
    };
    for (const f of [...viewHits(deep.text), ...commandAndBlobHits(deep.text)].map(mapSpan)) {
      if (seen.has(key(f))) continue;
      seen.add(key(f));
      push(f);
    }
    if (splitPhrase() && squashedHit(deep.text)) {
      push({ rule: 'inj.split_phrase', category: 'injection_phrase', severity: 'block' });
    }
  }

  // URLs are found on the folded view, but the host is checked as written:
  // a look-alike host (`gіthub.com` with a Cyrillic і) is a different domain.
  URL_RE.lastIndex = 0;
  for (const m of view.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const hostAt = start + m[0].indexOf('//') + 2;
    const host = text.slice(hostAt, hostAt + (m[1] ?? '').length);
    if (hostAllowed(host, opts?.allowedHosts)) {
      // `docs.*` hosts stay unlabeled, but still count as a link payload for agent-addressed text.
      if (!listedHost(host, opts?.allowedHosts)) {
        push({ rule: 'url.docs_host', category: 'url', severity: 'info', span: { start, end: start + m[0].length } });
      }
      continue;
    }
    push({ rule: 'url.not_allowlisted', category: 'url', severity: 'warn', span: { start, end: start + m[0].length } });
  }
  for (const s of findSecrets(text)) {
    push({ rule: ruleId('secret', s.ruleId), category: 'secret', severity: 'block', span: { start: s.start, end: s.end } });
  }
  INVISIBLE_G.lastIndex = 0;
  const invisible = [...text.matchAll(INVISIBLE_G)].filter((m) => m[0] !== '‍');
  if (invisible.length > 0) {
    const first = invisible[0]?.index ?? 0;
    push({ rule: 'hidden.invisible_chars', category: 'invisible_chars', severity: 'warn', span: { start: first, end: first + 1 } });
  }
  if (/<!--/.test(text)) push({ rule: 'hidden.html_comment', category: 'invisible_chars', severity: 'warn' });
  // code shape is informational at L0 (DLP enforces it on outbound bodies)
  if (/^\s*(?:```|~~~)/m.test(text) || /^\s*(?:import\s.+\sfrom\s|(?:const|let|var)\s+\w+\s*=\s*require\()/m.test(text)) {
    push({ rule: 'code.shape', category: 'code_shape', severity: 'info' });
  }
  return findings;
}

/** Apply the security-discussion downgrade (block → warn) when nothing addresses the reading agent. */
function applyDiscussion(text: string, findings: L0Finding[]): L0Finding[] {
  const imperative = findings.some((f) => IMPERATIVE_RULES.has(f.rule) && f.severity !== 'info');
  if (imperative) return findings;
  const discussable = new Set(PHRASE_RULES.filter((r) => r.discussable).map((r) => r.rule));
  return findings.map((f) => {
    if (f.severity !== 'block' || !f.span) return f;
    if (!(f.category === 'command' || discussable.has(f.rule))) return f;
    return isDiscussionContext(text, f.span.start) ? { ...f, severity: 'warn' } : f;
  });
}

/**
 * Label from findings:
 * - `malicious`: a block-severity injection phrase or agent-addressed
 *   imperative together with a payload (command, blob, URL, exfil request,
 *   concealment, secret) or with each other (e.g. "if you are an AI…" +
 *   "call send_message");
 * - `sensitive`: otherwise, whenever a secret is among the block findings
 *   (alone, or with e.g. a command or blob): the sender's secret is held for
 *   the sender rather than delivered to the recipient's quarantine;
 * - `suspicious`: any other block finding;
 * - `warn`: warn findings only; else `clean`.
 */
export function labelFromFindings(findings: readonly L0Finding[]): Label {
  const blocks = findings.filter((f) => f.severity === 'block');
  if (blocks.length === 0) return findings.some((f) => f.severity === 'warn') ? 'warn' : 'clean';
  if (blocks.every((f) => f.category === 'secret')) return 'sensitive';
  const inj = blocks.some((f) => f.category === 'injection_phrase');
  const addressed = blocks.some((f) => f.rule === 'agent.addressed');
  const action = blocks.some((f) => f.rule === 'agent.tool_call' || f.rule === 'agent.exfil_request');
  const agent = addressed || action;
  const payload =
    blocks.some((f) => f.category === 'command' || f.category === 'blob' || f.rule === 'agent.exfil_request') ||
    findings.some((f) => f.category === 'url' || f.rule === 'agent.conceal' || f.category === 'secret');
  if ((inj || agent) && (payload || (inj && agent) || (addressed && action))) return 'malicious';
  if (blocks.some((f) => f.category === 'secret')) return 'sensitive';
  return 'suspicious';
}

/**
 * L0 scan (< 10 ms for 4,000 chars) on **normalized** text. Rule families
 * (`L0Category`): injection phrases, agent-addressed imperatives, blobs,
 * non-allowlisted URLs (warn), secrets (`@y/redact`, local fallback),
 * the {@link lintCommands} command linter, leftover invisible characters
 * and HTML comments (callers that skipped normalization), code shape (info).
 * Confusable Cyrillic/Greek letters are folded before matching; a second
 * view that also drops variation selectors, combining marks and invisible
 * characters (and folds more look-alikes) can only add findings. URL hosts
 * are checked as written, so a look-alike host is never allowlisted; `docs.*`
 * hosts are not labeled but count as a link payload (`url.docs_host`, info).
 *
 * Security-themed developer content is labeled, not blocked: when nothing in
 * the text addresses or instructs the reading agent, block-severity commands
 * and injection phrases that sit in a discussion context ("never run …",
 * "our linter flags …") are downgraded to `warn`.
 *
 * `needsL2`: true when {@link requiresL2} says so for the class, or label ≠ clean.
 * Findings carry spans, never the matched text.
 */
export function l0Scan(text: string, contentClass: ContentClass, opts?: L0Options): L0Result {
  const input = typeof text === 'string' ? text : '';
  const findings = applyDiscussion(input, collectFindings(input, opts));
  const label = labelFromFindings(findings);
  return {
    label,
    findings,
    needsL2: requiresL2(contentClass) || label !== 'clean',
    normalizedChanged: normalizeUntrusted(input).text !== input,
  };
}

/** Internal: findings for hidden payloads (no spans; never downgraded). */
export function hiddenFindings(hidden: readonly string[], opts?: L0Options): L0Finding[] {
  const out: L0Finding[] = [];
  for (const h of hidden) {
    for (const f of collectFindings(h, opts)) {
      if (f.category === 'code_shape' || f.category === 'invisible_chars') continue;
      const { span: _span, ...rest } = f;
      out.push(rest);
    }
  }
  return out;
}
