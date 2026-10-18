/**
 * P7 (PLAN §5 "Builder discovery"): match the project's own dependencies
 * against the public list of verified builder claims, locally. Only the
 * claim list is fetched (no auth, cached 24 h in `state/`); dependency names
 * never leave the machine. A match becomes `{template_id:'P7', params:
 * {dep_index, product_id}}`, and the name is substituted only when the
 * pointer is rendered here (I3).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PackageName, ProductId } from '@y/schema/common';
import type { PointerOf } from '@y/schema/pointers';
import { httpJson, readJson, writeJsonAtomic, type FetchLike, type Paths } from './runtime.js';

export const CLAIMS_MAX_AGE_MS = 24 * 3600_000;
/** After a failed fetch, wait this long before trying again (the old cache, if any, keeps serving). */
const CLAIMS_RETRY_MS = 3600_000;
/** At most this many P7 pointers per session start (they rank last anyway). */
export const MAX_P7 = 3;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_DEPS = 2000;

export type Ecosystem = 'npm' | 'pypi';

export interface LocalDep {
  ecosystem: Ecosystem;
  name: string;
}

export interface BuilderClaim {
  kind: Ecosystem;
  value: string;
  product_id: string;
}

/** `state/builder-claims.json`. */
export interface ClaimsCache {
  fetchedAt: number;
  /** Last failed fetch (ms epoch), for backoff. */
  failedAt?: number;
  claims: BuilderClaim[];
}

export function claimsFile(p: Paths): string {
  return path.join(p.state, 'builder-claims.json');
}

/** Validate claims entry by entry: one bad row never drops the rest. */
export function sanitizeClaims(raw: unknown): BuilderClaim[] {
  const list = raw && typeof raw === 'object' ? (raw as { claims?: unknown }).claims : undefined;
  if (!Array.isArray(list)) return [];
  return list.slice(0, 10_000).flatMap((c) => {
    if (!c || typeof c !== 'object') return [];
    const { kind, value, product_id } = c as Record<string, unknown>;
    if (kind !== 'npm' && kind !== 'pypi') return [];
    if (!PackageName.safeParse(value).success || !ProductId.safeParse(product_id).success) return [];
    return [{ kind, value: value as string, product_id: product_id as string }];
  });
}

export function readClaimsCache(p: Paths): ClaimsCache | undefined {
  const c = readJson<ClaimsCache>(claimsFile(p));
  if (!c || typeof c !== 'object' || typeof c.fetchedAt !== 'number') return undefined;
  return {
    fetchedAt: c.fetchedAt,
    ...(typeof c.failedAt === 'number' ? { failedAt: c.failedAt } : {}),
    claims: sanitizeClaims(c),
  };
}

/**
 * The claim list: the cache when younger than 24 h, else a fresh fetch of
 * `GET /api/v1/builders/claims` (no token, nothing about this project sent).
 * On failure the stale cache still serves.
 */
export async function loadClaims(opts: {
  fetch: FetchLike;
  apiUrl: string;
  paths: Paths;
  now: number;
  timeoutMs: number;
}): Promise<BuilderClaim[]> {
  const cached = readClaimsCache(opts.paths);
  if (cached && opts.now - cached.fetchedAt < CLAIMS_MAX_AGE_MS) return cached.claims;
  if (cached?.failedAt && opts.now - cached.failedAt < CLAIMS_RETRY_MS) return cached.claims;
  if (opts.timeoutMs < 50) return cached?.claims ?? [];
  try {
    const res = await httpJson(opts.fetch, 'GET', `${opts.apiUrl}/api/v1/builders/claims`, { timeoutMs: opts.timeoutMs });
    if (res.status < 200 || res.status >= 300) throw new Error(`status ${res.status}`);
    const claims = sanitizeClaims(res.body);
    try {
      writeJsonAtomic(claimsFile(opts.paths), { fetchedAt: opts.now, claims } satisfies ClaimsCache);
    } catch {
      /* cache is best effort */
    }
    return claims;
  } catch {
    try {
      writeJsonAtomic(claimsFile(opts.paths), { fetchedAt: cached?.fetchedAt ?? 0, failedAt: opts.now, claims: cached?.claims ?? [] });
    } catch {
      /* best effort */
    }
    return cached?.claims ?? [];
  }
}

/* ======================================================== local manifests */

function readSmall(file: string): string | undefined {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** PEP 503 normalized name (case and runs of `-_.` folded). */
export function normalizePypi(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** Comparison key for a package in its ecosystem. */
function depKey(ecosystem: Ecosystem, name: string): string {
  return `${ecosystem}:${ecosystem === 'pypi' ? normalizePypi(name) : name.toLowerCase()}`;
}

/** The leading project name of a PEP 508 requirement (`requests[socks]>=2; python_version>"3"` → `requests`). */
function pep508Name(spec: string): string | undefined {
  const m = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/.exec(spec);
  return m?.[1];
}

function npmDeps(dir: string): string[] {
  const text = readSmall(path.join(dir, 'package.json'));
  if (!text) return [];
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    const out: string[] = [];
    for (const field of ['dependencies', 'devDependencies']) {
      const deps = pkg[field];
      if (deps && typeof deps === 'object' && !Array.isArray(deps)) out.push(...Object.keys(deps));
    }
    return out;
  } catch {
    return [];
  }
}

function requirementsDeps(dir: string): string[] {
  const text = readSmall(path.join(dir, 'requirements.txt'));
  if (!text) return [];
  return text.split(/\r?\n/).flatMap((line) => {
    const l = line.replace(/(^|\s)#.*$/, '').trim();
    if (!l || l.startsWith('-') || /^[a-z+]+:\/\//i.test(l)) return []; // options, includes, URLs
    const n = pep508Name(l);
    return n ? [n] : [];
  });
}

/**
 * Names from `pyproject.toml`, simple shapes only: `[project] dependencies =
 * ["x>=1", ...]` and the keys of `[tool.poetry.dependencies]` (minus python).
 * Not a TOML parser; anything unusual is skipped.
 */
function pyprojectDeps(dir: string): string[] {
  const text = readSmall(path.join(dir, 'pyproject.toml'));
  if (!text) return [];
  const out: string[] = [];
  let section = '';
  let inArray = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header && !inArray) {
      section = header[1]!.trim();
      continue;
    }
    if (section === 'project') {
      if (!inArray && /^dependencies\s*=\s*\[/.test(line)) {
        inArray = true;
      }
      if (inArray) {
        for (const m of line.matchAll(/["']([^"']+)["']/g)) {
          const n = pep508Name(m[1]!);
          if (n) out.push(n);
        }
        if (line.includes(']')) inArray = false;
      }
    } else if (section === 'tool.poetry.dependencies' || section === 'tool.poetry.dev-dependencies' || /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section)) {
      const m = /^["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*=/.exec(line);
      if (m && m[1]!.toLowerCase() !== 'python') out.push(m[1]!);
    }
  }
  return out;
}

/**
 * The project's own dependency list, in a stable order (npm first, then
 * PyPI; de-duplicated). P7's `dep_index` indexes into this list.
 */
export function localDependencies(cwd: string | undefined): LocalDep[] {
  if (!cwd || !path.isAbsolute(cwd)) return [];
  const seen = new Set<string>();
  const out: LocalDep[] = [];
  const add = (ecosystem: Ecosystem, name: string) => {
    const key = depKey(ecosystem, name);
    if (seen.has(key) || out.length >= MAX_DEPS || !PackageName.safeParse(name).success) return;
    seen.add(key);
    out.push({ ecosystem, name });
  };
  for (const n of npmDeps(cwd)) add('npm', n);
  for (const n of [...requirementsDeps(cwd), ...pyprojectDeps(cwd)]) add('pypi', n);
  return out;
}

/** Match locally: one P7 per product, in dependency order, at most {@link MAX_P7}. */
export function matchBuilders(deps: readonly LocalDep[], claims: readonly BuilderClaim[]): PointerOf<'P7'>[] {
  const byKey = new Map<string, string>();
  for (const c of claims) {
    const key = depKey(c.kind, c.value);
    if (!byKey.has(key)) byKey.set(key, c.product_id);
  }
  const out: PointerOf<'P7'>[] = [];
  const products = new Set<string>();
  deps.forEach((d, i) => {
    if (out.length >= MAX_P7 || i > 9999) return;
    const productId = byKey.get(depKey(d.ecosystem, d.name));
    if (!productId || products.has(productId)) return;
    products.add(productId);
    out.push({ template_id: 'P7', params: { dep_index: i, product_id: productId } });
  });
  return out;
}
