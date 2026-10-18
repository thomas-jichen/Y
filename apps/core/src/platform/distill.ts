/**
 * Deterministic heuristic distiller (no LLM; I9: no tools, no viewer data).
 * Reads the digest's ERROR/OK windows (packages/capture buildDigest format):
 *   TOOL <name>: <arg>      ERROR <name>: <failed result>      OK <name>: <result>
 * and produces at most 2 `fix` highlight drafts:
 *   problem = normalized error signature, steps = successful TOOL lines inside the
 *   window, pitfalls = TOOL lines that were followed by an ERROR, verification = the OK line.
 * Steps and pitfalls that carry a URL, host name, IP, e-mail, home or machine path, a
 * credential-looking file or variable name, or a remote-shell command are left out (PLAN §7: no
 * paths or URLs); error text and the signature shown in title/summary/problem have those
 * masked, and such OK output is replaced by templated text.
 */
import { HighlightDraft, type ErrorEpisode, type HighlightDraft as HighlightDraftT } from '@y/schema';

export const MAX_HEURISTIC_DRAFTS = 2;

interface Line {
  kind: 'TOOL' | 'ERROR' | 'OK' | 'OTHER';
  tool: string;
  text: string;
}

const LINE_RE = /^(TOOL|ERROR|OK) ([^:]{1,80}): ?(.*)$/;

function parseLines(digest: string): Line[] {
  return digest.split('\n').map((raw) => {
    const m = LINE_RE.exec(raw.trim());
    if (!m) return { kind: 'OTHER', tool: '', text: raw.trim() };
    return { kind: m[1] as Line['kind'], tool: (m[2] ?? '').trim(), text: (m[3] ?? '').trim() };
  });
}

/** One line of at most `n` chars. NFKC first and ASCII dots: envelopes NFKC-normalize text, which would grow '…' past the schema limit. */
function clip(s: string, n: number): string {
  const one = s.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n - 3).trimEnd()}...`;
}

/** Hosts of public code and package registries: naming one says nothing about the user's environment. */
const PUBLIC_HOSTS = new Set([
  'github.com', 'gist.github.com', 'raw.githubusercontent.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org', 'sr.ht',
  'golang.org', 'go.dev', 'pkg.go.dev', 'proxy.golang.org', 'google.golang.org', 'gopkg.in', 'k8s.io', 'sigs.k8s.io',
  'npmjs.com', 'www.npmjs.com', 'npmjs.org', 'registry.npmjs.org', 'yarnpkg.com', 'registry.yarnpkg.com', 'unpkg.com', 'cdn.jsdelivr.net',
  'jsr.io', 'deno.land', 'pypi.org', 'files.pythonhosted.org', 'crates.io', 'docs.rs', 'rubygems.org', 'packagist.org', 'nuget.org',
  'api.nuget.org', 'docker.io', 'hub.docker.com', 'registry-1.docker.io', 'ghcr.io', 'quay.io', 'mcr.microsoft.com',
]);
/** Loopback: a local dev server's address is not identifying. */
const LOOPBACK_RE = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?)(?::\d+)?$/i;

/** TLDs that show up in host names (not ones that read as code: `logger.info`, `arr.at`, `this.store`). */
const TLDS =
  'com|net|org|io|dev|app|ai|co|cloud|internal|local|localhost|corp|lan|intranet|gov|edu|us|uk|de|eu|biz|tech|xyz|' +
  'so|me|tv|gg|fm|ly|ca|au|jp|fr|nl|ru|br|ch|se|es|be|dk|fi|ie|nz|za|kr|cn|tw|hk|sg|il|mx|example|invalid';
/** A dotted host name that ends there (`app.dev.ts` or `index.dev.js` is a file, not a host). */
const HOST_G = new RegExp(String.raw`(?<![.$])\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:${TLDS})\b(?![\w-]|\.[a-z0-9])`, 'gi');
/** `this.app`, `req.session.me`, `state.ai`: a property access on a common receiver, not a host. */
const RECEIVER_RE = /^(?:this|self|super|req|res|ctx|props|state|window|document|globalThis|process|module|exports|opts|options|evt|err|vm)\./i;
/** Well-known library names that are spelled like hosts. */
const LIBRARY_NAMES = new Set(['socket.io', 'engine.io']);
const URL_G = /\b[a-z][a-z0-9+.-]*:\/\/([^\s'"`<>)\]/?#]*)[^\s'"`<>)\]]*/gi;
const EMAIL_G = /[\w.+-]+@[a-z0-9-]*[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi;
/** `user@host` (only in remote-shell text, where `name@x` is not a package version). */
const USER_AT_HOST_G = /\b[\w.-]+@(?!<)[a-z][\w-]*(?:\.[\w-]+)*(?=[\s:'"`]|$)/gi;
const REMOTE_SHELL_RE = /\b(?:ssh|scp|sftp|rsync|mosh|telnet)\b/i;
/** A remote-shell command names a host however it is spelled. */
const REMOTE_CMD_RE = /(?:^|[;&|(]\s*|\s)(?:sudo\s+)?(?:ssh|scp|sftp|rsync|mosh|telnet)\s+\S/i;
/** Host given to a database/network client with `-h`, or as `--host`, `host=`, `to host`. */
const CLIENT_HOST_G =
  /(\b(?:psql|mysql|mysqldump|mariadb|redis-cli|pg_dump|pg_dumpall|pg_restore|pg_isready|mongosh|mongo|clickhouse-client|cqlsh)\b[^;&|\n]*?\s-h\s*['"]?)(?!<)([a-z0-9][\w.-]*)/gi;
const HOST_ARG_G = /((?:^|\s)--host(?:name)?(?:\s+|=)['"]?|\bhost(?:name)?=['"]?|\b(?:to|on) host\s+['"]?)(?!<)([a-z0-9][\w.-]*)/gi;
/** Home-relative paths: `~`, `~/x`, `~user/x`, `$HOME/x`, `%USERPROFILE%\x`. */
const HOME_PATH_G = /(^|[\s'"`=(:,])(?:~(?=[\/\s'"`]|$)|~[a-z_][\w.-]*(?=\/)|\$HOME\b|\$\{HOME\}|%USERPROFILE%|%HOMEPATH%)[^\s'"`]*/gi;
/** Absolute paths under a filesystem root that names users, machines or projects (not `/app`, `/api/...`). */
const ROOT_PATH_G =
  /(^|[\s'"`=(:,])\/(?:Users|home|root|etc|var|tmp|private|opt|srv|mnt|Volumes|media|workspaces?|builds)(?=[\/\s'"`):,]|$)[^\s'"`]*/g;
const WINDOWS_PATH_G = /\b[a-z]:\\[^\s'"`]*|\\\\[\w.-]+\\[^\s'"`]*/gi;
const IPV4_G = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g;
const IPV6_G =
  /(?<![\w:.])(?:(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?|::(?:[0-9a-f]{1,4}:)*[0-9a-f]{1,4})(?![\w:.])/gi;
/** Credential files: `.env*`, ssh keys, `~/.aws` & co, `.npmrc`, `.../credentials`, `*credentials.json`, `secrets.yaml`, key stores. */
const SECRET_FILE_G =
  /(?:^|(?<=[^\w.]))\.env(?!\.(?:example|sample|template|dist)\b)(?:\.[\w-]+)?\b|\bid_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?\b|\.(?:ssh|aws|gnupg|kube|docker)(?=[\/\s'"`]|$)|\.(?:npmrc|netrc|pgpass|git-credentials)\b|\/(?:[\w.-]*[_-])?credentials(?![.\w-])|\b[\w.-]*credentials\.json\b|\bsecrets?\.(?:ya?ml|json|toml|env|txt)\b|\b[\w.-]+\.(?:pem|p12|pfx|kdbx|keystore|jks)\b/gi;
const SECRET_VAR_G = /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|DATABASE_URL|DSN|CREDENTIALS)[A-Z0-9_]*\b|\b[A-Z0-9_]+_PAT\b/g;
/** A name that only describes a credential (its lifetime, length, a count): `TOKEN_TTL`, `MAX_TOKENS`, `PASSWORD_MIN_LENGTH`. */
const SECRET_META_NAME_RE = /(?:^|_)(?:TTL|EXPIRY|EXPIRES|EXPIRATION|TIMEOUT|MAX|MIN|NUM|COUNT|LIMIT|LEN|LENGTH|SIZE)(?:_|$)|TOKENS(?:_|$)/;

function namesSecretVar(text: string): boolean {
  for (const m of text.matchAll(SECRET_VAR_G)) if (!SECRET_META_NAME_RE.test(m[0])) return true;
  return false;
}
const PKG_MANAGERS = 'npm|pnpm|yarn|bun|npx|pnpx|bunx|deno|go|pip3?|pipx|uv|poetry|cargo|gem|bundle|composer|brew|dotnet|nuget|conda|mamba|apt(?:-get)?';
const PKG_VERBS = 'add|install|i|get|remove|rm|uninstall|un|upgrade|update|up|dlx|why|info|view|show|outdated|require|link';
/** The text before a token is a package-manager command that takes package specifiers (`pnpm add socket.io`, `go get github.com/x/y`). */
const PKG_PREFIX_RE = new RegExp(String.raw`(?:^(?:[A-Z][\w-]{0,30}:\s+)?|[;&|(]\s*)(?:sudo\s+)?(?:${PKG_MANAGERS})\s+(?:[^;&|\n]*\s)?(?:${PKG_VERBS})\s+[^;&|\n]*$`, 'i');
/** `module 'socket.io'`, `package socket.io`: a module name, not a host. */
const MODULE_PREFIX_RE = /\b(?:module|package)s?\s+['"`]?$/i;

function isPackageContext(text: string, offset: number): boolean {
  const before = text.slice(0, offset);
  return PKG_PREFIX_RE.test(before) || MODULE_PREFIX_RE.test(before);
}

/**
 * The text with every URL, e-mail, host, IP address, home or machine path and credential file
 * replaced by a placeholder (`<url>`, `<email>`, `<host>`, `<ip>`, `<path>`, `<file>`).
 * Public code hosts, package specifiers, loopback addresses and project-relative paths stay.
 */
export function maskEnvironment(text: string): string {
  let t = text.replace(URL_G, (m, authority: string) => {
    const host = authority.replace(/^[^@]*@/, '');
    return LOOPBACK_RE.test(host) ? m : '<url>';
  });
  t = t.replace(EMAIL_G, '<email>');
  if (REMOTE_SHELL_RE.test(t)) t = t.replace(USER_AT_HOST_G, '<host>');
  const hostArg = (m: string, pre: string, host: string) => (LOOPBACK_RE.test(host) ? m : `${pre}<host>`);
  t = t.replace(CLIENT_HOST_G, hostArg).replace(HOST_ARG_G, hostArg);
  t = t.replace(HOME_PATH_G, '$1<path>').replace(ROOT_PATH_G, '$1<path>').replace(WINDOWS_PATH_G, '<path>');
  t = t.replace(IPV4_G, (m) => (LOOPBACK_RE.test(m) ? m : '<ip>')).replace(IPV6_G, (m) => (m === '::1' ? m : '<ip>'));
  // Credential files first: `.env.local` is a file, not `.` + a host `env.local`.
  t = t.replace(SECRET_FILE_G, '<file>');
  return t.replace(HOST_G, (m, offset: number, whole: string) =>
    PUBLIC_HOSTS.has(m.toLowerCase()) ||
    LIBRARY_NAMES.has(m.toLowerCase()) ||
    RECEIVER_RE.test(m) ||
    /^lib[\w.+-]*\.so$/i.test(m) ||
    isPackageContext(whole, offset)
      ? m
      : '<host>',
  );
}

/**
 * True when a line would leak where or what (a URL, host, IP, e-mail, home or machine path,
 * credential file or variable name, or a remote-shell command) if published.
 */
export function revealsEnvironment(text: string): boolean {
  return maskEnvironment(text) !== text || REMOTE_CMD_RE.test(text) || namesSecretVar(text);
}

/** A client-supplied (local distill) draft with the same masking applied to every published text field. */
export function maskDraftEnvironment<T extends HighlightDraftT>(d: T): T {
  const m = maskEnvironment;
  return {
    ...d,
    title: m(d.title),
    summary: m(d.summary),
    body: {
      ...d.body,
      problem: m(d.body.problem),
      steps: d.body.steps.map(m),
      pitfalls: d.body.pitfalls.map((p) => ({ ...p, tried: m(p.tried), whyFailed: m(p.whyFailed) })),
      verification: m(d.body.verification),
      appliesWhen: m(d.body.appliesWhen),
      notAppliesWhen: m(d.body.notAppliesWhen),
    },
  };
}

export interface HeuristicInput {
  digest: string;
  episodes: readonly ErrorEpisode[];
  /** Signature normalizer (packages/capture normalizeErrorSignature). */
  normalize: (text: string) => string;
}

export type HeuristicDraft = HighlightDraftT & { errorSignature: string };

export function heuristicDrafts(input: HeuristicInput): HeuristicDraft[] {
  const lines = parseLines(input.digest);
  const out: HeuristicDraft[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length && out.length < MAX_HEURISTIC_DRAFTS; i++) {
    const err = lines[i]!;
    if (err.kind !== 'ERROR') continue;
    const okIdx = lines.findIndex((l, j) => j > i && l.kind === 'OK' && l.tool === err.tool);
    if (okIdx < 0) continue;
    const episode = input.episodes.find((e) => e.tool === err.tool && err.text.includes(e.excerpt.slice(0, 40)));
    const sig = clip(episode?.signature ?? input.normalize(err.text), 300);
    if (!sig || seen.has(sig)) continue;
    // What is published (title, summary, problem, appliesWhen) names no host or path; the raw
    // normalized signature stays in errorSignatures / searchQueries for matching (not shown).
    const shownSig = clip(maskEnvironment(sig), 300);

    // Failed attempts: TOOL lines (same tool) immediately followed by an ERROR, from just before the window to the fix.
    const pitfalls: { tried: string; whyFailed: string }[] = [];
    const steps: string[] = [];
    const windowStart = (() => {
      let s = i;
      while (s > 0 && lines[s - 1]!.kind === 'TOOL') s--;
      return s;
    })();
    // Error text has its hosts, paths, URLs and credential files masked (the empty case falls back to the signature).
    const failedBecause = (text: string) => maskEnvironment(text) || shownSig || 'Failed with the same error';
    for (let j = windowStart; j < okIdx; j++) {
      const l = lines[j]!;
      if (l.kind !== 'TOOL' || !l.text) continue;
      // A command that names a host, path, URL or credential is never published.
      if (revealsEnvironment(l.text)) continue;
      const next = lines.slice(j + 1).find((x) => x.kind !== 'OTHER');
      if (next?.kind === 'ERROR') pitfalls.push({ tried: clip(`${l.tool}: ${l.text}`, 200), whyFailed: clip(failedBecause(next.text), 300) });
      else steps.push(clip(`${l.tool}: ${l.text}`, 300));
    }
    const okLine = lines[okIdx]!;
    if (steps.length === 0) {
      // The fix is the last TOOL line before OK when no clean step was found.
      const last = [...lines.slice(i + 1, okIdx)].reverse().find((l) => l.kind === 'TOOL' && l.text && !revealsEnvironment(l.text));
      if (last) steps.push(clip(`${last.tool}: ${last.text}`, 300));
    }
    if (steps.length === 0 || pitfalls.length === 0) continue;

    const draft = {
      kind: 'fix' as const,
      title: clip(`Fix: ${shownSig}`, 90).padEnd(8, '.'),
      summary: clip(
        `Resolved "${clip(shownSig, 160)}" with ${clip(steps[0]!, 160)} after ${pitfalls.length} failed attempt(s); verified by a passing ${okLine.tool} run.`,
        400,
      ),
      body: {
        problem: clip(shownSig, 600),
        steps: steps.slice(0, 8),
        pitfalls: pitfalls.slice(0, 5),
        verification: clip(
          revealsEnvironment(okLine.text) ? `Verified by a passing ${okLine.tool} run` : `${okLine.tool}: ${okLine.text}`,
          300,
        ),
        appliesWhen: clip(`The error signature matches: ${shownSig}`, 300),
        notAppliesWhen: '',
      },
      tags: [] as string[],
      searchQueries: [clip(sig, 200)],
      errorSignatures: [sig],
      confidence: 0.6,
    };
    const parsed = HighlightDraft.safeParse(draft);
    if (!parsed.success) continue;
    seen.add(sig);
    out.push({ ...parsed.data, errorSignature: sig });
    // One draft per error→fix window: ERROR lines inside this window are its pitfalls.
    i = okIdx;
  }
  return out;
}
