/**
 * Redaction engine: secret span detection (shared by {@link redact} and
 * {@link scanSecrets}), identity-term replacement and the entropy helpers.
 *
 * Pure, synchronous, node-built-in free.
 *
 * @module redact
 */
import {
  ENV_DUMP_COMMAND_RE,
  FAIL_CLOSED_THRESHOLD,
  RULES,
  type IdentitySources,
  type IdentityTerms,
  type RedactOptions,
  type RedactResult,
  type SecretHit,
} from './rules.js';

const MARKER_BY_ID: Record<string, string> = Object.fromEntries(RULES.map((r) => [r.id, r.marker]));
const KIND_BY_ID: Record<string, string> = Object.fromEntries(RULES.map((r) => [r.id, r.kind]));

/** Global variant of MARKER_RE (kept local so `MARKER_RE.test` stays stateless). */
const MARKER_G = /<(?:REDACTED:[a-z0-9_]{1,40}|USER|EMAIL|HOST|ORG|PROJECT|TERM|IP)>/g;

/* ============================================================ entropy */

/** Shannon entropy in bits per character (0 for `''`). */
export function shannonEntropy(text: string): number {
  if (!text) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const n = [...text].length;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PREFIXED_ID_RE = /^[a-z]{1,4}_[0-9A-HJKMNP-TV-Z]{26}$/;
const HEX_RE = /^[0-9a-fA-F]+$/;

/**
 * Whether one whitespace-delimited token looks like a secret: length ≥
 * `minLength` (24), entropy ≥ `minBitsPerChar` (4.0; 3.0 for pure hex of
 * length ≥ 32), at least two character classes. Never flags: 40/64-char hex
 * (git/sha hashes), UUIDs, ULIDs/prefixed Y ids, file paths, URLs
 * without credentials, or letter-only runs (identifiers and words).
 */
export function looksLikeSecret(token: string, opts?: RedactOptions['entropy']): boolean {
  const minLength = opts?.minLength ?? 24;
  const minBits = opts?.minBitsPerChar ?? 4.0;
  const t = token.replace(/^[=:"'`]+|[=:"'`.,;]+$/g, '');
  if (UUID_RE.test(t) || ULID_RE.test(t) || PREFIXED_ID_RE.test(t)) return false;
  if (/:\/\//.test(t)) return false;
  if (HEX_RE.test(t)) {
    if (t.length < 32) return false;
    if (t.length === 40 || t.length === 64) return false;
    if (!/[a-fA-F]/.test(t) || !/\d/.test(t)) return false;
    return shannonEntropy(t) >= 3.0;
  }
  if (t.length < minLength) return false;
  // Paths: any slash-separated token whose segments are each path-like words.
  if (t.includes('/')) {
    const segs = t.split('/').filter(Boolean);
    if (t.startsWith('/') || t.startsWith('~/') || t.startsWith('./') || t.startsWith('../')) return false;
    if (segs.length >= 2 && segs.every((s) => /^[A-Za-z0-9._@-]+$/.test(s) && !looksLikeSecret(s, opts))) return false;
  }
  // Letter-only (plus separators) runs are identifiers or prose.
  if (!/\d/.test(t)) return false;
  if (!/[A-Za-z]/.test(t)) return false;
  // Dotted versions / numbers-with-words (`v1.2.3-alpha.20240101`).
  if (/^[A-Za-z]*\d+(?:[._-][A-Za-z0-9]+)*$/.test(t) && shannonEntropy(t) < 4.2) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(t)).length;
  if (classes < 2) return false;
  return shannonEntropy(t) >= minBits;
}

/* ============================================================ spans */

interface Span {
  start: number;
  end: number;
  ruleId: string;
}

interface Matcher {
  id: string;
  re: RegExp;
  /** Capture group to replace (default: whole match). Needs the `d` flag. */
  group?: number;
  validate?: (value: string) => boolean;
}

const hasDigit = (s: string) => /\d/.test(s);

/** Specific secret rules in RULES order (env_dump and PEM are handled separately). */
const SPECIFIC: Matcher[] = [
  { id: 'aws_access_key', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  {
    id: 'aws_secret_key',
    re: /(?:aws_?secret_?(?:access_?)?key|secretAccessKey)["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/dgi,
    group: 1,
  },
  { id: 'github_pat', re: /\bgithub_pat_[A-Za-z0-9_]{22,255}/g },
  { id: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { id: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  {
    id: 'openai_key',
    re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
    validate: (v) => !v.startsWith('sk-ant-') && hasDigit(v) && shannonEntropy(v) > 3.5,
  },
  { id: 'stripe_key', re: /\b(?:(?:sk|rk)_(?:live|test)|pk_live)_[A-Za-z0-9]{10,}\b/g },
  { id: 'stripe_webhook', re: /\bwhsec_[A-Za-z0-9+/=]{20,}/g },
  { id: 'slack_token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { id: 'slack_webhook', re: /https?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]+/g },
  { id: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g },
  { id: 'y_token', re: /\bpcl_agt_[A-Za-z0-9_-]{16,}/g },
  { id: 'npm_token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    id: 'bearer_token',
    re: /\b[Bb]earer\s+([A-Za-z0-9._~+/=-]{16,})/dg,
    group: 1,
    validate: (v) => hasDigit(v) || shannonEntropy(v) > 3.5,
  },
];

const URL_CRED: Matcher = {
  id: 'url_credentials',
  // The password may contain `/` (`postgres://admin:s3cr/etP4ss@db`) unless it
  // starts like a port and path (`https://host:443/@scope/pkg`, `http://localhost:3000/u/a@b.c`).
  re: /\b[a-zA-Z][a-zA-Z0-9+.-]{1,20}:\/\/([^\s:/@<>"'`]+:(?:[^\s@/<>"'`]+|(?!\d{1,5}\/)[^\s@<>"'`]+))@/dg,
  group: 1,
};

/**
 * `generic_assignment`: `<key containing a keyword>["']? <op> ["']?<value ≥ 8>["']?`.
 *
 * Same matches as the regex
 * `\b[A-Za-z0-9_.-]*(?:KEYWORDS)[A-Za-z0-9_.-]*["']?\s*(?::=|=>|=|:)\s*(["']?)([^\s"'`,;()[\]{}<>]{8,})\1`
 * (flags `gi`, value = group 2), in linear time. That regex backtracks
 * cubically on runs like `token-token-token-…`, because its prefix and suffix
 * classes both contain the keyword. Here the key is always the whole
 * `[A-Za-z0-9_.-]` run (an operator can't start inside one), the match starts
 * at the run's first word character (its only usable `\b`), and the tail is
 * matched once per run.
 */
const GENERIC_ID = 'generic_assignment';
const GENERIC_KEYWORD_RE =
  /password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?key|private[_-]?key|client[_-]?secret|credentials?/i;
const GENERIC_KEY_RUN_SRC = '[A-Za-z0-9_.-]+';
const GENERIC_TAIL_SRC = String.raw`["']?\s*(?::=|=>|=|:)\s*(["']?)([^\s"'` + '`' + String.raw`,;()[\]{}<>]{8,})\1`;

/** A key naming a password (`DB_PASSWORD`, `admin.passwd`, `pwd`). */
const PASSWORD_KEY_RE = /(?:password|passwd|pwd)$/i;
/** Identifiers and member expressions (`passwordField`, `cfg.db.pass`). */
const IDENTIFIER_LIKE_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
/** Placeholder words in a value (`your-password-here`, `not.a.real.secret`). */
const PLACEHOLDER_WORD_RE = /example|placeholder|changeme|change[-_.]me|your[-_.]|redacted|dummy|sample|fake|test|todo|xxx|secret|password|here/i;

/**
 * A quoted, digit-free passphrase assigned to a password key
 * (`DB_PASSWORD="correct-horse-battery-staple"`). Identifiers, paths,
 * placeholders and short values are not.
 */
function quotedPassphraseOk(key: string, v: string): boolean {
  if (!PASSWORD_KEY_RE.test(key) || v.length < 12) return false;
  if (IDENTIFIER_LIKE_RE.test(v) || /[/\\]|^[.~]/.test(v)) return false;
  if (/^\$|^process\.env\b|^env\./.test(v) || PLACEHOLDER_WORD_RE.test(v)) return false;
  return shannonEntropy(v) > 3;
}

function genericValueOk(v: string, key = '', quoted = false): boolean {
  if (!hasDigit(v)) return quoted && quotedPassphraseOk(key, v); // identifiers / member expressions / types
  if (/^\$|^process\.env\b|^env\./.test(v)) return false;
  if (/^(?:x+|\*+|changeme|example\w*|placeholder\w*)$/i.test(v)) return false;
  return shannonEntropy(v) > 3.5;
}

/** Internal (exported for tests): value spans of generic assignments, in text order. */
export function genericAssignmentMatches(text: string): { start: number; end: number; value: string }[] {
  return genericAssignmentHits(text).map(({ start, end, value }) => ({ start, end, value }));
}

/** {@link genericAssignmentMatches} plus the key and whether the value was quoted. */
function genericAssignmentHits(text: string): { start: number; end: number; value: string; key: string; quoted: boolean }[] {
  const out: { start: number; end: number; value: string; key: string; quoted: boolean }[] = [];
  const runs = new RegExp(GENERIC_KEY_RUN_SRC, 'g');
  const tailRe = new RegExp(GENERIC_TAIL_SRC, 'dy');
  for (let m = runs.exec(text); m; m = runs.exec(text)) {
    const run = m[0];
    if (!GENERIC_KEYWORD_RE.test(run)) continue;
    const runEnd = m.index + run.length;
    tailRe.lastIndex = runEnd;
    const tail = tailRe.exec(text) as (RegExpExecArray & { indices?: ([number, number] | undefined)[] }) | null;
    const idx = tail?.indices?.[2];
    if (!tail || !idx || tail[2] === undefined) continue;
    out.push({ start: idx[0], end: idx[1], value: tail[2], key: run, quoted: Boolean(tail[1]) });
    // Like matchAll: continue after the whole match (it never ends inside a key run).
    runs.lastIndex = runEnd + tail[0].length;
  }
  return out;
}

function addGeneric(text: string, taken: Span[], out: Span[]): void {
  for (const { start, end, value, key, quoted } of genericAssignmentHits(text)) {
    if (!genericValueOk(value, key, quoted)) continue;
    if (overlaps(taken, start, end)) continue;
    const span = { start, end, ruleId: GENERIC_ID };
    taken.push(span);
    out.push(span);
  }
}

const PEM_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]{0,16384}?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|[A-Za-z0-9+/=\s⏎]*)/g;

const ENTROPY_CANDIDATE_RE = /[A-Za-z0-9+/_\-.=~]{20,}/g;

const ENV_LINE_RE = /^\s*(?:export\s+)?[A-Z_][A-Z0-9_]{1,}=\S*/;
const TOOL_BASH_RE = /^TOOL Bash: (.*)$/;
const RESULT_BASH_RE = /^((?:OK|ERROR) Bash: )(.+)$/;

function overlaps(spans: readonly Span[], start: number, end: number): boolean {
  for (const s of spans) if (start < s.end && end > s.start) return true;
  return false;
}

function addMatcher(text: string, m: Matcher, taken: Span[], out: Span[]): void {
  m.re.lastIndex = 0;
  for (const match of text.matchAll(m.re)) {
    let start = match.index;
    let end = start + match[0].length;
    let value = match[0];
    if (m.group !== undefined) {
      const idx = (match as RegExpMatchArray & { indices?: [number, number][] }).indices?.[m.group];
      const g = match[m.group];
      if (!idx || g === undefined) continue;
      [start, end] = idx;
      value = g;
    }
    if (m.validate && !m.validate(value)) continue;
    if (overlaps(taken, start, end)) continue;
    const span = { start, end, ruleId: m.id };
    taken.push(span);
    out.push(span);
  }
}

/** Env dump spans: outputs of env-dump commands in digests and runs of ≥3 `KEY=value` lines. */
function envDumpSpans(text: string, taken: Span[], out: Span[]): void {
  const lines = text.split('\n');
  let pos = 0;
  const offsets = lines.map((l) => {
    const o = pos;
    pos += l.length + 1;
    return o;
  });
  for (let i = 0; i < lines.length; i++) {
    const tool = TOOL_BASH_RE.exec(lines[i]!);
    if (!tool || !ENV_DUMP_COMMAND_RE.test(tool[1]!)) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const r = RESULT_BASH_RE.exec(lines[j]!);
      if (!r) continue;
      const start = offsets[j]! + r[1]!.length;
      const end = offsets[j]! + lines[j]!.length;
      if (!overlaps(taken, start, end)) {
        const span = { start, end, ruleId: 'env_dump' };
        taken.push(span);
        out.push(span);
      }
      break;
    }
  }
  // Runs of ≥3 env-style assignment segments separated by newlines or ` ⏎ `.
  const segRe = /[^\n⏎]+/g;
  const segs: { start: number; end: number; env: boolean }[] = [];
  for (const m of text.matchAll(segRe)) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const s = m.index + lead;
    const e = m.index + raw.trimEnd().length;
    if (e <= s) continue;
    const seg = text.slice(s, e).replace(/^(?:OK|ERROR) [A-Za-z]+: /, '');
    segs.push({ start: s, end: e, env: ENV_LINE_RE.test(seg) });
  }
  for (let i = 0; i < segs.length; ) {
    if (!segs[i]!.env) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < segs.length && segs[j + 1]!.env) j++;
    if (j - i + 1 >= 3) {
      const start = segs[i]!.start;
      const end = segs[j]!.end;
      if (!overlaps(taken, start, end)) {
        const span = { start, end, ruleId: 'env_dump' };
        taken.push(span);
        out.push(span);
      }
    }
    i = j + 1;
  }
}

function entropySpans(text: string, entropy: RedactOptions['entropy'], taken: Span[], out: Span[]): void {
  ENTROPY_CANDIDATE_RE.lastIndex = 0;
  for (const m of text.matchAll(ENTROPY_CANDIDATE_RE)) {
    // Trim trailing sentence punctuation.
    const raw = m[0].replace(/[.\-~]+$/, '');
    const start = m.index;
    const end = start + raw.length;
    if (!looksLikeSecret(raw, entropy)) continue;
    if (overlaps(taken, start, end)) continue;
    const span = { start, end, ruleId: 'entropy' };
    taken.push(span);
    out.push(span);
  }
}

/** All secret spans (non-identity), in rule priority order, non-overlapping. */
function findSecretSpans(text: string, entropy?: RedactOptions['entropy']): Span[] {
  const taken: Span[] = [];
  MARKER_G.lastIndex = 0;
  for (const m of text.matchAll(MARKER_G)) taken.push({ start: m.index, end: m.index + m[0].length, ruleId: '' });
  const out: Span[] = [];
  envDumpSpans(text, taken, out);
  addMatcher(text, { id: 'pem_private_key', re: PEM_RE }, taken, out);
  for (const m of SPECIFIC) addMatcher(text, m, taken, out);
  addMatcher(text, URL_CRED, taken, out);
  addGeneric(text, taken, out);
  entropySpans(text, entropy, taken, out);
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Find secrets without replacing them (all non-identity rules). Used by
 * pass 2 on LLM output fields and by `@y/safety`'s DLP. Existing
 * `<REDACTED:…>` markers are not hits.
 */
export function scanSecrets(text: string, opts?: Pick<RedactOptions, 'entropy'>): SecretHit[] {
  if (!text) return [];
  return findSecretSpans(text, opts?.entropy).map(({ ruleId, start, end }) => ({ ruleId, start, end }));
}

/* ============================================================ identity */

const COMMON_WORDS = new Set([
  'src', 'app', 'api', 'test', 'main', 'web', 'server', 'client', 'lib', 'core', 'home', 'user', 'admin',
  'dev', 'me', 'root', 'local', 'localhost', 'the', 'and', 'docs', 'code', 'data', 'repo', 'project',
  'github', 'gitlab', 'com', 'org', 'www', 'tmp', 'node', 'packages', 'apps', 'users',
]);
const GENERIC_LOCAL_PARTS = new Set(['dev', 'me', 'admin', 'info', 'hello', 'contact', 'mail', 'noreply', 'no-reply', 'git', 'root', 'user']);

function cleanTerms(xs: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of xs) {
    const t = raw?.trim();
    if (!t || t.length < 3) continue;
    const k = t.toLowerCase();
    if (COMMON_WORDS.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

function parseRemote(remote: string): { owner?: string; repo?: string } {
  const r = remote.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?[^/:]+(?::\d+)?[:/](.+)$/i.exec(r);
  if (!m) return {};
  const parts = m[1]!.split('/').filter(Boolean);
  if (parts.length < 2) return { repo: parts[0] };
  return { owner: parts[parts.length - 2], repo: parts[parts.length - 1] };
}

/**
 * Derive identity terms (user name parts, email local part, host and its
 * first label, remote owner/repo, package scope/name, dirname, denylist).
 * Terms are trimmed, de-duplicated case-insensitively, and dropped when
 * shorter than 3 characters or a common word.
 */
export function identityTermsFrom(sources: IdentitySources): IdentityTerms {
  const user: (string | undefined)[] = [];
  if (sources.gitUser) {
    user.push(sources.gitUser, ...sources.gitUser.split(/\s+/));
  }
  const local = sources.gitEmail?.split('@')[0];
  if (local && !GENERIC_LOCAL_PARTS.has(local.toLowerCase())) user.push(local);
  const host: (string | undefined)[] = [];
  if (sources.hostname) host.push(sources.hostname, sources.hostname.split('.')[0]);
  const org: (string | undefined)[] = [];
  const project: (string | undefined)[] = [];
  if (sources.remote) {
    const { owner, repo } = parseRemote(sources.remote);
    org.push(owner);
    project.push(repo);
  }
  if (sources.packageName) {
    const m = /^(?:@([^/]+)\/)?(.+)$/.exec(sources.packageName.trim());
    if (m) {
      org.push(m[1]);
      project.push(m[2]);
    }
  }
  project.push(sources.dirname);
  return {
    user: cleanTerms(user),
    email: cleanTerms([sources.gitEmail]),
    host: cleanTerms(host),
    org: cleanTerms(org),
    project: cleanTerms(project),
    denylist: cleanTerms(sources.denylist ?? []),
  };
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const HOME_RE = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)(?!Shared\b)([^/\\\s"'`<>:]+)/g;
const IPV4_RE = /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\w]|\.\d)/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace with private-use placeholders so later passes can't touch inserted markers. */
class Masker {
  private readonly saved: string[] = [];
  mask(marker: string): string {
    this.saved.push(marker);
    return `\uE000${this.saved.length - 1}\uE001`;
  }
  unmask(text: string): string {
    return text.replace(/\uE000(\d+)\uE001/g, (_, i: string) => this.saved[Number(i)] ?? '');
  }
}

function applyIdentity(text: string, terms: IdentityTerms | undefined, hits: Record<string, number>): string {
  const mk = new Masker();
  const bump = (id: string) => (hits[id] = (hits[id] ?? 0) + 1);
  let t = text.replace(MARKER_G, (m) => mk.mask(m));
  t = t.replace(EMAIL_RE, () => {
    bump('identity_email');
    return mk.mask('<EMAIL>');
  });
  t = t.replace(HOME_RE, () => {
    bump('identity_user');
    return '~';
  });
  t = t.replace(IPV4_RE, (ip) => {
    if (ip === '0.0.0.0' || ip.startsWith('127.')) return ip;
    bump('identity_ip');
    return mk.mask('<IP>');
  });
  if (terms) {
    const all: { term: string; id: string }[] = [];
    const add = (xs: readonly string[], id: string) => {
      for (const x of xs) if (x.trim().length >= 3) all.push({ term: x.trim(), id });
    };
    add(terms.email, 'identity_email');
    add(terms.user, 'identity_user');
    add(terms.host, 'identity_host');
    add(terms.org, 'identity_org');
    add(terms.project, 'identity_project');
    add(terms.denylist, 'identity_term');
    all.sort((a, b) => b.term.length - a.term.length);
    for (const { term, id } of all) {
      const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRe(term)}(?![A-Za-z0-9_])`, 'gi');
      t = t.replace(re, () => {
        bump(id);
        return mk.mask(MARKER_BY_ID[id]!);
      });
    }
  }
  return mk.unmask(t);
}

/* ============================================================ redact */

/**
 * Redact secrets and identity terms. Order: env-dump blocks, PEM blocks,
 * specific secret rules, URL credentials, generic assignments, entropy, then
 * emails, home paths (`/Users/x` → `~`), IPv4 addresses and identity terms
 * (longest first, word-boundary, case-insensitive). Existing markers are
 * never re-redacted or counted, so the function is idempotent. More than
 * `failClosedThreshold` non-identity hits drops the text (`dropped: true`).
 */
export function redact(text: string, opts?: RedactOptions): RedactResult {
  const hitsByRule: Record<string, number> = {};
  if (!text) return { text: '', hitsByRule, dropped: false };
  const spans = findSecretSpans(text, opts?.entropy);
  let out = '';
  let pos = 0;
  let secretHits = 0;
  for (const s of spans) {
    out += text.slice(pos, s.start) + (MARKER_BY_ID[s.ruleId] ?? '<REDACTED:entropy>');
    pos = s.end;
    hitsByRule[s.ruleId] = (hitsByRule[s.ruleId] ?? 0) + 1;
    if (KIND_BY_ID[s.ruleId] !== 'identity') secretHits++;
  }
  out += text.slice(pos);
  const threshold = opts?.failClosedThreshold ?? FAIL_CLOSED_THRESHOLD;
  if (secretHits > threshold) return { text: '', hitsByRule, dropped: true };
  out = applyIdentity(out, opts?.identityTerms, hitsByRule);
  return { text: out, hitsByRule, dropped: false };
}

/**
 * Redact a command's output: if `command` matches {@link ENV_DUMP_COMMAND_RE}
 * the whole output becomes `<REDACTED:env_dump>` (one `env_dump` hit);
 * otherwise this is `redact(output, opts)`.
 */
export function redactCommandOutput(command: string, output: string, opts?: RedactOptions): RedactResult {
  if (ENV_DUMP_COMMAND_RE.test(command)) {
    return { text: '<REDACTED:env_dump>', hitsByRule: { env_dump: 1 }, dropped: false };
  }
  return redact(output, opts);
}

/**
 * True when `text` contains a marker. Distill validators drop LLM output
 * that echoes markers ("residual redaction markers").
 */
export function hasResidualMarkers(text: string): boolean {
  MARKER_G.lastIndex = 0;
  return MARKER_G.test(text);
}
