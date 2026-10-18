/**
 * Shared runtime for the plugin's hook scripts: config from the environment,
 * the data-dir layout, atomic file helpers, HTTP with deadlines, stdin, and
 * the detached child spawner. Node built-ins only.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Fallback when plugin.json can't be read (tests, odd installs). */
const BUILT_VERSION = '0.1.2';

/**
 * The installed version, from the plugin's own .claude-plugin/plugin.json, so a
 * release only has to bump that file (CI does it on every plugin change to
 * main; Claude Code updates when the version changes).
 */
export const PLUGIN_VERSION: string = readPluginVersion(process.env) ?? BUILT_VERSION;

export function readPluginVersion(env: NodeJS.ProcessEnv): string | undefined {
  const roots: string[] = [];
  if (env.CLAUDE_PLUGIN_ROOT) roots.push(env.CLAUDE_PLUGIN_ROOT);
  // The bundles live in scripts/dist, the sources in src: walk up to the plugin root.
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 3; i++, dir = path.dirname(dir)) roots.push(dir);
  for (const root of roots) {
    try {
      const v = (JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: unknown }).version;
      if (typeof v === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(v)) return v;
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}

/**
 * Whether Claude Code auto-updates the marketplace this plugin came from.
 * Off by default for third-party marketplaces; the user turns it on in
 * /plugin. Returns the marketplace name when it is off, or undefined when
 * it is on or unknown (a dev checkout, an unexpected layout).
 */
export function autoUpdateOffFor(env: NodeJS.ProcessEnv): string | undefined {
  const root = env.CLAUDE_PLUGIN_ROOT;
  if (!root) return undefined;
  const parts = path.resolve(root).split(path.sep);
  const i = parts.lastIndexOf('cache');
  const name = i >= 0 ? parts[i + 1] : undefined;
  if (!name || !/^[A-Za-z0-9._-]{1,64}$/.test(name)) return undefined;
  const base = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const read = (f: string): Record<string, unknown> | undefined => {
    try {
      const v = JSON.parse(fs.readFileSync(f, 'utf8')) as unknown;
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  // A settings entry wins over the /plugin toggle (Claude Code docs, plugin loading).
  const extra = read(path.join(base, 'settings.json'))?.extraKnownMarketplaces as Record<string, { autoUpdate?: unknown }> | undefined;
  if (typeof extra?.[name]?.autoUpdate === 'boolean') return extra[name]!.autoUpdate ? undefined : name;
  const known = read(path.join(base, 'plugins', 'known_marketplaces.json'))?.[name] as { autoUpdate?: unknown } | undefined;
  if (!known) return undefined;
  return known.autoUpdate === true ? undefined : name;
}

export type ShareModeSetting = 'stats' | 'auto-team' | 'off';
export type WakeSetting = 'teammates' | 'owner-only' | 'off';

/** Runtime config resolved from the environment Claude Code gives hooks. */
export interface Config {
  token: string | undefined;
  apiUrl: string;
  dataDir: string;
  shareMode: ShareModeSetting;
  wakeOnDm: WakeSetting;
  headless: boolean;
  pluginRoot: string | undefined;
  /**
   * `api_url` is plain http:// to a public host (not this machine and not a
   * private network, see `cleartextApiUrl`). The agent token is then withheld
   * (`token` is undefined), so neither it nor any digest crosses the internet
   * in cleartext. `Y_ALLOW_INSECURE_URL=1` opts out.
   */
  insecureApiUrl?: boolean;
  /**
   * `api_url` is plain http:// to a private-network host (RFC 1918 or
   * link-local address, `host.docker.internal`, a single-label name, `.lan`,
   * `.local`, `.internal`, `.home.arpa`). The token is kept so LAN, Docker and
   * devcontainer setups keep working, and SessionStart warns.
   */
  cleartextApiUrl?: boolean;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** True for an http:// URL whose host is not loopback (https and loopback http are fine). */
export function isInsecureUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase();
    return !(LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost') || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host));
  } catch {
    return false;
  }
}

/** True for an http:// URL whose host is on a private network (see {@link Config.cleartextApiUrl}); false for loopback and public hosts. */
export function isPrivateNetworkUrl(raw: string): boolean {
  if (!isInsecureUrl(raw)) return false;
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
    if (v4) {
      const a = Number(v4[1]);
      const b = Number(v4[2]);
      return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
    }
    if (host.includes(':')) return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
    if (!host.includes('.')) return true;
    return /\.(?:lan|local|internal|home\.arpa|localdomain)$/.test(host);
  } catch {
    return false;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const apiUrl = (env.CLAUDE_PLUGIN_OPTION_API_URL?.trim() || 'http://localhost:8787').replace(/\/+$/, '');
  const optOut = env.Y_ALLOW_INSECURE_URL === '1';
  const cleartextApiUrl = !optOut && isPrivateNetworkUrl(apiUrl);
  const insecureApiUrl = isInsecureUrl(apiUrl) && !optOut && !cleartextApiUrl;
  const token = insecureApiUrl ? undefined : env.CLAUDE_PLUGIN_OPTION_AGENT_TOKEN?.trim() || undefined;
  const dataDir = env.CLAUDE_PLUGIN_DATA || env.Y_DATA_DIR || path.join(os.homedir(), '.y');
  const sm = env.CLAUDE_PLUGIN_OPTION_SHARE_MODE;
  const shareMode: ShareModeSetting = sm === 'off' || sm === 'auto-team' ? sm : 'stats';
  const wk = env.CLAUDE_PLUGIN_OPTION_WAKE_ON_DM;
  const wakeOnDm: WakeSetting = wk === 'off' || wk === 'owner-only' ? wk : 'teammates';
  const headless = env.Y_MODE === 'ci' || env.CI === 'true' || env.CI === '1';
  return { token, apiUrl, dataDir, shareMode, wakeOnDm, headless, pluginRoot: env.CLAUDE_PLUGIN_ROOT, ...(insecureApiUrl ? { insecureApiUrl } : {}), ...(cleartextApiUrl ? { cleartextApiUrl } : {}) };
}

/**
 * The agent token Claude Code has stored now. A session keeps the token it
 * started with in its env, so long-lived sessions still hold a revoked one
 * after a reconnect; the uploader retries with this on a 401. Claude Code
 * keeps sensitive plugin options under `pluginSecrets` in the macOS keychain
 * item "Claude Code-credentials", or in ~/.claude/.credentials.json elsewhere.
 * Only this plugin's agent_token is read out.
 */
export function storedToken(env: NodeJS.ProcessEnv): string | undefined {
  let raw: string | undefined;
  try {
    raw =
      process.platform === 'darwin'
        ? execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
            encoding: 'utf8',
            timeout: 3000,
            stdio: ['ignore', 'pipe', 'ignore'],
          })
        : fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json'), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const secrets = (JSON.parse(raw) as { pluginSecrets?: Record<string, { agent_token?: unknown }> }).pluginSecrets ?? {};
    for (const [key, v] of Object.entries(secrets)) {
      if (key.startsWith('y@') && typeof v?.agent_token === 'string' && v.agent_token.trim()) return v.agent_token.trim();
    }
  } catch {
    /* unreadable store */
  }
  return undefined;
}

/** True when this process is a Y child (hooks must exit 0 immediately). */
export function isChild(env: NodeJS.ProcessEnv): boolean {
  return env.Y_CHILD === '1';
}

/* ================================================================ layout */

export interface Paths {
  root: string;
  outbox: string;
  dead: string;
  cursors: string;
  state: string;
  seq: string;
  episodes: string;
  log: string;
  brief: string;
  pulse: string;
  uploaderLock: string;
}

export function paths(dataDir: string): Paths {
  const outbox = path.join(dataDir, 'outbox');
  const state = path.join(dataDir, 'state');
  return {
    root: dataDir,
    outbox,
    dead: path.join(outbox, 'dead'),
    cursors: path.join(dataDir, 'cursors'),
    state,
    seq: path.join(dataDir, 'seq'),
    episodes: path.join(dataDir, 'episodes'),
    log: path.join(dataDir, 'log'),
    brief: path.join(state, 'brief.json'),
    pulse: path.join(state, 'pulse.json'),
    uploaderLock: path.join(outbox, '.lock'),
  };
}

/** Session ids are used in file names; keep only a safe subset. */
export function safeSid(sid: string): string {
  const s = sid.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
  return s.length > 0 && s !== '.' && s !== '..' ? s : 'unknown';
}

/* ================================================================ files */

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Write a file atomically (tmp in the same dir → rename). */
export function writeFileAtomic(file: string, data: string): void {
  ensureDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, JSON.stringify(value));
}

export function readJson<T = unknown>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Append one line to `log/<name>.log` (best effort, never throws). */
export function logLine(dataDir: string, name: string, msg: string): void {
  try {
    const dir = path.join(dataDir, 'log');
    ensureDir(dir);
    fs.appendFileSync(path.join(dir, `${name}.log`), `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* ignore */
  }
}

/**
 * Allocate the next upload sequence number for a session. Race-free across
 * concurrent hooks (async Stop vs SessionEnd): `mkdir` is atomic, so each
 * number is claimed exactly once.
 */
export function allocSeq(p: Paths, sid: string): number {
  const dir = path.join(p.seq, safeSid(sid));
  ensureDir(dir);
  return claimSeqFrom(dir, maxClaim(dir) + 1);
}

/** The highest claim in `dir`, or -1. */
function maxClaim(dir: string): number {
  let max = -1;
  try {
    for (const name of fs.readdirSync(dir)) {
      const v = Number(name);
      if (Number.isInteger(v) && v > max) max = v;
    }
  } catch {
    /* empty */
  }
  return max;
}

/**
 * Claim the first free number ≥ `n` in `dir` (internal; exported for tests).
 * Claims below the highest are pruned, so a free directory does not prove a
 * number was never used: a hook that read the directory before two others
 * claimed n and n+1 (pruning n) could claim n again. The highest claim is
 * never removed, so a claim that is not the highest after `mkdir` may be a
 * reused number: it is given up and the claim retried above the highest.
 */
export function claimSeqFrom(dir: string, n: number): number {
  for (;;) {
    try {
      fs.mkdirSync(path.join(dir, String(n)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      n++;
      continue;
    }
    const max = maxClaim(dir);
    if (max > n) {
      n = max + 1;
      continue;
    }
    pruneSeq(dir, n);
    return n;
  }
}

/**
 * Remove the claim directories below `keep` (best effort). Only the highest
 * one is needed to continue the sequence, and it is never removed, so numbers
 * stay unique and increasing (see {@link claimSeqFrom}) while the directory
 * no longer grows per chunk.
 */
function pruneSeq(dir: string, keep: number): void {
  try {
    for (const name of fs.readdirSync(dir)) {
      const v = Number(name);
      if (Number.isInteger(v) && String(v) === name && v < keep) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  } catch {
    /* best effort */
  }
}

/* ================================================================ stdin */

/** Read all of stdin, giving up (with what was read) after `timeoutMs`. Returns '' for a TTY. */
export function readStdin(timeoutMs: number, stream: NodeJS.ReadStream = process.stdin): Promise<string> {
  if (stream.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.removeAllListeners('data');
      stream.removeAllListeners('end');
      stream.removeAllListeners('error');
      stream.pause();
      resolve(buf);
    };
    const timer = setTimeout(finish, timeoutMs);
    stream.setEncoding('utf8');
    stream.on('data', (c: string) => {
      buf += c;
      if (buf.length > 4_000_000) finish();
    });
    stream.on('end', finish);
    stream.on('error', finish);
  });
}

/** Hook stdin fields we read (Claude Code sends snake_case; all optional, parsed defensively). */
export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  permission_mode?: string;
  source?: string;
  reason?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  error?: unknown;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  [k: string]: unknown;
}

export function parseHookInput(text: string): HookInput {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as HookInput) : {};
  } catch {
    return {};
  }
}

/* ================================================================ http */

export interface HttpResult {
  status: number;
  body: unknown;
  retryAfterS?: number;
}

export type FetchLike = typeof fetch;

/** JSON request with a hard timeout. Throws on network errors and timeouts. */
export async function httpJson(
  fetchImpl: FetchLike,
  method: 'GET' | 'POST',
  url: string,
  opts: { token?: string; body?: unknown; timeoutMs: number; headers?: Record<string, string> },
): Promise<HttpResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, opts.timeoutMs));
  try {
    const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetchImpl(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    const ra = Number(res.headers.get('retry-after'));
    return { status: res.status, body, ...(Number.isFinite(ra) && ra > 0 ? { retryAfterS: ra } : {}) };
  } finally {
    clearTimeout(timer);
  }
}

/* ================================================================ spawn */

export type DetachedScript = 'uploader';
export type SpawnDetached = (script: DetachedScript, args: string[]) => void;

/** Directory holding the built `*.mjs` bundles. */
export function distDir(env: NodeJS.ProcessEnv): string {
  if (env.CLAUDE_PLUGIN_ROOT) return path.join(env.CLAUDE_PLUGIN_ROOT, 'scripts', 'dist');
  return path.dirname(fileURLToPath(import.meta.url));
}

/** Spawn a bundled script fully detached with `Y_CHILD=1` (survives the hook's exit). */
export function makeSpawnDetached(env: NodeJS.ProcessEnv): SpawnDetached {
  return (script, args) => {
    const file = path.join(distDir(env), `${script}.mjs`);
    if (!fs.existsSync(file)) return;
    const child = spawn(process.execPath, [file, ...args], {
      detached: true,
      stdio: 'ignore',
      env: { ...env, Y_CHILD: '1' },
    });
    child.on('error', () => {});
    child.unref();
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** True when a process with this pid is alive (signal 0 probe). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
