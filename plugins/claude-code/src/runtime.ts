/**
 * Shared runtime for the plugin's hook scripts: config from the environment,
 * the data-dir layout, atomic file helpers, HTTP with deadlines, stdin, and
 * the detached child spawner. Node built-ins only.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_VERSION = '0.1.0';

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
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const token = env.CLAUDE_PLUGIN_OPTION_AGENT_TOKEN?.trim() || undefined;
  const apiUrl = (env.CLAUDE_PLUGIN_OPTION_API_URL?.trim() || 'http://localhost:8787').replace(/\/+$/, '');
  const dataDir = env.CLAUDE_PLUGIN_DATA || env.Y_DATA_DIR || path.join(os.homedir(), '.y');
  const sm = env.CLAUDE_PLUGIN_OPTION_SHARE_MODE;
  const shareMode: ShareModeSetting = sm === 'off' || sm === 'auto-team' ? sm : 'stats';
  const wk = env.CLAUDE_PLUGIN_OPTION_WAKE_ON_DM;
  const wakeOnDm: WakeSetting = wk === 'off' || wk === 'owner-only' ? wk : 'teammates';
  const headless = env.Y_MODE === 'ci' || env.CI === 'true' || env.CI === '1';
  return { token, apiUrl, dataDir, shareMode, wakeOnDm, headless, pluginRoot: env.CLAUDE_PLUGIN_ROOT };
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
  let n = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const v = Number(name);
      if (Number.isInteger(v) && v >= n) n = v + 1;
    }
  } catch {
    /* empty */
  }
  for (;;) {
    try {
      fs.mkdirSync(path.join(dir, String(n)));
      return n;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      n++;
    }
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
