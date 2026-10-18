/**
 * Product claim verification (PLAN §5 "Builder discovery"): core fetches a
 * marker only the claimed package/repo/domain's maintainers can publish.
 *
 * - domain: `https://<value>/.well-known/y.json` → `{"products":[slug]}` or `{"product":slug}`
 * - github_repo: `https://raw.githubusercontent.com/<owner>/<repo>/HEAD/.well-known/y.json` (same JSON)
 * - npm: `https://registry.npmjs.org/<name>/latest` → package.json `"y": {"product": slug}`
 * - pypi: `https://pypi.org/pypi/<name>/json` → a project URL named "Y" ending in `/p/<slug>`,
 *   or `y-product: <slug>` in the description
 *
 * HTTPS only, no redirects followed, 5 s timeout (DNS included), 512 KiB cap
 * (32 MiB for PyPI, whose project JSON lists every release's files). The
 * default fetch resolves the host ONCE, refuses private, loopback, link-local,
 * CGNAT, benchmark, NAT64, documentation and multicast answers, and connects
 * to exactly the address it checked (no second lookup to rebind). Tests inject
 * a fake fetch (no network).
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import type { ClaimKind, VerifyFailure } from '@y/schema';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const VERIFY_TIMEOUT_MS = 5_000;
export const VERIFY_MAX_BYTES = 512 * 1024;
export const VERIFY_MAX_BYTES_PYPI = 32 * 1024 * 1024;

/** The response size cap for a claim kind. */
export function verifyMaxBytes(kind: ClaimKind): number {
  return kind === 'pypi' ? VERIFY_MAX_BYTES_PYPI : VERIFY_MAX_BYTES;
}

export type VerifyResult = { ok: true; url: string } | { ok: false; reason: VerifyFailure; url: string };

/** The marker URL for a claim. */
export function markerUrl(kind: ClaimKind, value: string): string {
  switch (kind) {
    case 'domain':
      return `https://${value}/.well-known/y.json`;
    case 'github_repo':
      return `https://raw.githubusercontent.com/${value}/HEAD/.well-known/y.json`;
    case 'npm':
      return `https://registry.npmjs.org/${encodeURIComponent(value).replace(/^%40/, '@')}/latest`;
    case 'pypi':
      return `https://pypi.org/pypi/${encodeURIComponent(value)}/json`;
  }
}

/** IPv4 ranges that are not public unicast (RFC 6890 and friends), as [network, prefix]. */
const V4_BLOCKED: readonly [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
];

function v4Int(addr: string): number {
  return addr.split('.').reduce((n, o) => n * 256 + Number(o), 0);
}

function v4Blocked(addr: string): boolean {
  const n = v4Int(addr);
  return V4_BLOCKED.some(([net, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4Int(net) / 2 ** (32 - bits)));
}

/** The eight 16-bit words of an IPv6 address (zone and embedded IPv4 handled); null when malformed. */
function v6Words(addr: string): number[] | null {
  let a = addr.toLowerCase().replace(/%.*$/, '');
  let tail: number[] = [];
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (dotted) {
    if (isIP(dotted[2]!) !== 4) return null;
    const o = dotted[2]!.split('.').map(Number) as [number, number, number, number];
    tail = [o[0] * 256 + o[1], o[2] * 256 + o[3]];
    a = dotted[1]!.endsWith('::') ? dotted[1]! : dotted[1]!.slice(0, -1);
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string) => (h === '' ? [] : h.split(':').map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN)));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const n = head.length + rest.length + tail.length;
  const words = halves.length === 2 ? (n > 7 ? null : [...head, ...new Array<number>(8 - n).fill(0), ...rest, ...tail]) : [...head, ...tail];
  if (!words || words.length !== 8 || words.some(Number.isNaN)) return null;
  return words;
}

/** True for anything but a public unicast address (unparseable counts as private). */
export function isPrivateAddress(addr: string): boolean {
  if (isIP(addr) === 4) return v4Blocked(addr);
  const w = v6Words(addr);
  if (!w) return true;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the IPv4 address.
  if (w.slice(0, 5).every((x) => x === 0) && (w[5] === 0xffff || w[5] === 0)) {
    return v4Blocked(`${w[6]! >> 8}.${w[6]! & 255}.${w[7]! >> 8}.${w[7]! & 255}`);
  }
  // Only global unicast (2000::/3) passes, minus 2001::/23 (Teredo, benchmarking, ORCHID),
  // 2001:db8::/32 and 3fff::/20 (documentation) and 2002::/16 (6to4). NAT64 (64:ff9b::/96,
  // 64:ff9b:1::/48), ULA, link-local, multicast, loopback and :: all fall outside 2000::/3.
  const w0 = w[0]!;
  const w1 = w[1]!;
  if ((w0 & 0xe000) !== 0x2000) return true;
  if (w0 === 0x2001 && (w1 < 0x200 || w1 === 0xdb8)) return true;
  if (w0 === 0x2002 || (w0 === 0x3fff && w1 < 0x1000)) return true;
  return false;
}

export type Resolver = (host: string) => Promise<LookupAddress[]>;

const systemResolve: Resolver = (host) =>
  new Promise((resolve, reject) => dnsLookup(host, { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs))));

/** A socket lookup that resolves once, refuses private answers and returns exactly the address it checked. */
export function pinnedLookup(resolve: Resolver = systemResolve): LookupFunction {
  return ((hostname: string, options: { all?: boolean }, cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void) => {
    resolve(hostname).then(
      (addrs) => {
        const pick = addrs[0];
        if (!pick || addrs.some((x) => isPrivateAddress(x.address))) return cb(new Error('refused: private address'), '', 0);
        if (options.all) cb(null, [{ address: pick.address, family: pick.family }]);
        else cb(null, pick.address, pick.family);
      },
      (err: Error) => cb(err, '', 0),
    );
  }) as unknown as LookupFunction;
}

/**
 * HTTPS GET for claim markers over node:https with a pinned lookup (above).
 * Redirects are returned, never followed; `init.signal` bounds DNS, connect
 * and body alike. The body is not decompressed (no accept-encoding is sent).
 */
export function makeGuardedFetch(resolve: Resolver = systemResolve): FetchLike {
  const lookup = pinnedLookup(resolve);
  return (url, init = {}) => new Promise<Response>((done, fail) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') return fail(new Error('refused: https only'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    // An IP literal never goes through the lookup: check it here.
    if (isIP(host) && isPrivateAddress(host)) return fail(new Error('refused: private address'));
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    delete headers['accept-encoding'];
    const req = httpsRequest({
      host, port: u.port || 443, path: `${u.pathname}${u.search}`, method: init.method ?? 'GET', headers,
      lookup, agent: false, timeout: VERIFY_TIMEOUT_MS, ...(isIP(host) ? {} : { servername: host }),
      ...(init.signal ? { signal: init.signal } : {}),
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status > 599) {
        res.destroy();
        return fail(new Error(`unexpected status ${status}`));
      }
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined) continue;
        for (const x of Array.isArray(v) ? v : [v]) h.append(k, x);
      }
      const empty = status === 204 || status === 205 || status === 304;
      if (empty) res.resume();
      done(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, headers: h }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', fail);
    req.end();
  });
}

/** The production fetch for claim verification (see makeGuardedFetch). */
export const guardedFetch: FetchLike = makeGuardedFetch();

/** Read at most `max` bytes of a body as text; null when larger. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function namesSlug(doc: unknown, slug: string): boolean {
  if (!doc || typeof doc !== 'object') return false;
  const d = doc as { products?: unknown; product?: unknown };
  if (d.product === slug) return true;
  return Array.isArray(d.products) && d.products.includes(slug);
}

function markerFound(kind: ClaimKind, doc: unknown, slug: string): boolean {
  if (kind === 'domain' || kind === 'github_repo') return namesSlug(doc, slug);
  if (!doc || typeof doc !== 'object') return false;
  if (kind === 'npm') return namesSlug((doc as { y?: unknown }).y, slug);
  const info = (doc as { info?: { project_urls?: unknown; description?: unknown } }).info;
  if (!info) return false;
  const urls = info.project_urls && typeof info.project_urls === 'object' ? Object.entries(info.project_urls as Record<string, unknown>) : [];
  const suffix = `/p/${slug}`;
  if (urls.some(([k, v]) => k.trim().toLowerCase() === 'y' && typeof v === 'string' && v.replace(/\/+$/, '').endsWith(suffix))) return true;
  const desc = typeof info.description === 'string' ? info.description : '';
  return new RegExp(`(^|\\n)\\s*y-product:\\s*${slug}\\s*($|\\n)`, 'i').test(desc);
}

/** Fetch and check the marker for one claim. Never throws. */
export async function verifyClaimMarker(fetchImpl: FetchLike, kind: ClaimKind, value: string, slug: string): Promise<VerifyResult> {
  const url = markerUrl(kind, value);
  if (!url.startsWith('https://')) return { ok: false, reason: 'fetch_failed', url };
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json', 'user-agent': 'y-claim-verifier/1' },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'fetch_failed', url };
  }
  if (res.status >= 300 && res.status < 400) return { ok: false, reason: 'redirect', url };
  if (res.status === 404 || res.status === 410) return { ok: false, reason: 'not_found', url };
  if (!res.ok) return { ok: false, reason: 'fetch_failed', url };
  const max = verifyMaxBytes(kind);
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > max) return { ok: false, reason: 'too_large', url };
  let text: string | null;
  try {
    text = await readCapped(res, max);
  } catch {
    return { ok: false, reason: 'fetch_failed', url };
  }
  if (text === null) return { ok: false, reason: 'too_large', url };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid_response', url };
  }
  return markerFound(kind, doc, slug) ? { ok: true, url } : { ok: false, reason: 'marker_missing', url };
}
