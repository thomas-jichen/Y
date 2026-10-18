/**
 * Deterministic heuristic distiller (no LLM; I9: no tools, no viewer data).
 * Reads the digest's ERROR/OK windows (packages/capture buildDigest format):
 *   TOOL <name>: <arg>      ERROR <name>: <failed result>      OK <name>: <result>
 * and produces at most 2 `fix` highlight drafts:
 *   problem = normalized error signature, steps = successful TOOL lines inside the
 *   window, pitfalls = TOOL lines that were followed by an ERROR, verification = the OK line.
 * Steps and pitfalls that carry a URL, host name, IP, e-mail, absolute or home path, or a
 * credential-looking file or variable name are left out (PLAN §7: no paths or URLs), and such
 * error text or OK output is replaced by templated text.
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

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S/i;
/** Absolute (POSIX or Windows) or home-relative paths; package specifiers like `@types/node` or `vitest/config` are not. */
const PATH_RE = /(?:^|[\s'"`=(:,])(?:~[\w.-]*|\$HOME|\$\{HOME\})?\/[^\s/'"`]+|(?:^|[\s'"`=(:,])~[\w.-]*(?:[\s'"`]|$)|\b[A-Za-z]:\\[^\s]|%USERPROFILE%/;
const HOST_RE =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|dev|app|ai|co|cloud|internal|local|localhost|corp|lan|intranet|home|gov|edu|us|uk|de|eu|info|biz|tech|xyz)\b/i;
const IP_RE = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/;
const EMAIL_RE = /[\w.+-]+@[a-z0-9-]*[a-z][a-z0-9-]*\.[a-z]{2,}/i;
const SECRET_FILE_RE = /(?:^|[^\w.])\.env\b|\bid_(?:rsa|ed25519|ecdsa|dsa)\b|\.(?:ssh|aws|gnupg|kube|docker)\b|\.(?:npmrc|netrc|pgpass|git-credentials)\b|\bcredentials\b/i;
const SECRET_VAR_RE = /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|DATABASE_URL|DSN)[A-Z0-9_]*\b/;

/** True when a line would leak where or what (a URL, host, IP, e-mail, path or credential name) if published. */
export function revealsEnvironment(text: string): boolean {
  return [URL_RE, PATH_RE, HOST_RE, IP_RE, EMAIL_RE, SECRET_FILE_RE, SECRET_VAR_RE].some((re) => re.test(text));
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

    // Failed attempts: TOOL lines (same tool) immediately followed by an ERROR, from just before the window to the fix.
    const pitfalls: { tried: string; whyFailed: string }[] = [];
    const steps: string[] = [];
    const windowStart = (() => {
      let s = i;
      while (s > 0 && lines[s - 1]!.kind === 'TOOL') s--;
      return s;
    })();
    // Raw error text that names a host, path or credential falls back to the (normalized) signature.
    const failedBecause = (text: string) =>
      text && !revealsEnvironment(text) ? text : sig && !revealsEnvironment(sig) ? sig : 'Failed with the same error';
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
      title: clip(`Fix: ${sig}`, 90).padEnd(8, '.'),
      summary: clip(
        `Resolved "${clip(sig, 160)}" with ${clip(steps[0]!, 160)} after ${pitfalls.length} failed attempt(s); verified by a passing ${okLine.tool} run.`,
        400,
      ),
      body: {
        problem: clip(sig, 600),
        steps: steps.slice(0, 8),
        pitfalls: pitfalls.slice(0, 5),
        verification: clip(
          revealsEnvironment(okLine.text) ? `Verified by a passing ${okLine.tool} run` : `${okLine.tool}: ${okLine.text}`,
          300,
        ),
        appliesWhen: clip(`The error signature matches: ${sig}`, 300),
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
