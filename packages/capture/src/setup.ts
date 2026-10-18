/**
 * Claude Code setup snapshot: allowlisted metadata only (names, hashes,
 * redacted descriptions/headings). Never env, headers, args, hook commands,
 * skill bodies or CLAUDE.md text. Reads files defensively.
 * @module setup
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Effort,
  PermissionMode,
  SetupScope,
  SetupSnapshot,
  SnapshotHook,
  SnapshotMcpServer,
  SnapshotPlugin,
  SnapshotSkill,
} from '@y/schema';
import type { SnapshotSetupOptions } from './types.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function readJson(path: string): Promise<Obj | undefined> {
  const t = await readText(path);
  if (t === undefined) return undefined;
  try {
    const v: unknown = JSON.parse(t);
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

async function listDir(path: string): Promise<{ name: string; dir: boolean }[]> {
  try {
    const ents = await readdir(path, { withFileTypes: true });
    return ents.map((e) => ({ name: e.name, dir: e.isDirectory() || e.isSymbolicLink() }));
  } catch {
    return [];
  }
}

/** Sanitize to `ComponentName`: invalid chars → `_`, leading non-alnum stripped, cut to 64. */
export function sanitizeComponentName(name: string): string | undefined {
  const s = name
    .trim()
    .replace(/[^A-Za-z0-9._:@/+-]/g, '_')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 64);
  return s || undefined;
}

/** Single line, no control characters, cut to `max`. */
function single(text: string, max: number): string {
  const s = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** Minimal YAML-ish frontmatter reader (`key: value` lines, quoted or folded `>`). */
function frontmatter(md: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let v = kv[2]!.trim();
    if (v === '>' || v === '|' || v === '>-' || v === '|-') {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
      v = parts.join(' ');
    }
    out[kv[1]!] = v.replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const HOOK_TYPES = new Set(['command', 'http', 'prompt', 'agent', 'mcp_tool']);
const TRANSPORTS = new Set(['stdio', 'http', 'sse', 'ws', 'sdk']);
const HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PRIVATE_SUFFIX_RE = /(?:^|\.)(?:localhost|local|internal|lan|home|corp|intranet|localdomain|test|example|invalid)$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,79}$/;

/** Host of a remote MCP URL when it is a public DNS name; never IPs or private names. */
export function publicHostOf(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (!HOSTNAME_RE.test(host) || host.length > 253) return undefined; // also rejects IPv4 (last label must start with a letter) and IPv6
  if (PRIVATE_SUFFIX_RE.test(host)) return undefined;
  return host;
}

interface Settings {
  scope: SetupScope;
  data: Obj;
}

function mcpFrom(servers: unknown, scope: SetupScope, out: SnapshotMcpServer[]): void {
  if (!isObj(servers)) return;
  for (const [rawName, cfg] of Object.entries(servers)) {
    const name = sanitizeComponentName(rawName);
    if (!name || !isObj(cfg)) continue;
    const type = typeof cfg.type === 'string' ? cfg.type.toLowerCase() : undefined;
    let transport: SnapshotMcpServer['transport'];
    if (type === 'streamable-http' || type === 'streamablehttp') transport = 'http';
    else if (type && TRANSPORTS.has(type)) transport = type as SnapshotMcpServer['transport'];
    else if (typeof cfg.command === 'string') transport = 'stdio';
    else if (typeof cfg.url === 'string') transport = /^wss?:/i.test(cfg.url) ? 'ws' : 'http';
    else transport = 'unknown';
    const entry: SnapshotMcpServer = { name, scope, transport };
    if (transport === 'http' || transport === 'sse' || transport === 'ws') {
      const host = publicHostOf(cfg.url);
      if (host) entry.publicHost = host;
    }
    out.push(entry);
  }
}

function hooksFrom(hooks: unknown, scope: SetupScope, out: SnapshotHook[]): void {
  if (!isObj(hooks)) return;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!/^[A-Za-z]{1,40}$/.test(event) || !Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!isObj(g)) continue;
      const matcher = single(typeof g.matcher === 'string' ? g.matcher : '', 200);
      const list = Array.isArray(g.hooks) ? g.hooks : [];
      for (const h of list) {
        if (!isObj(h)) continue;
        const t = typeof h.type === 'string' && HOOK_TYPES.has(h.type) ? (h.type as SnapshotHook['type']) : 'unknown';
        const body = [h.command, h.url, h.prompt, h.tool].find((x) => typeof x === 'string') as string | undefined;
        out.push({ event, matcher, type: t, scope, commandSha256: sha256(body ?? '') });
      }
    }
  }
}

async function skillsIn(
  dir: string,
  scope: SetupScope,
  redactText: (t: string) => string,
  out: SnapshotSkill[],
  plugin?: string,
): Promise<void> {
  for (const ent of await listDir(dir)) {
    if (!ent.dir) continue;
    const text = await readText(join(dir, ent.name, 'SKILL.md'));
    if (text === undefined) continue;
    const fm = frontmatter(text);
    const name = sanitizeComponentName(fm.name || ent.name);
    if (!name) continue;
    let desc = '';
    try {
      desc = single(redactText(single(fm.description ?? '', 2000)), 300);
    } catch {
      desc = '';
    }
    const skill: SnapshotSkill = { name, scope, descriptionRedacted: desc, bodySha256: sha256(text) };
    if (plugin) skill.plugin = plugin;
    out.push(skill);
  }
}

async function agentsIn(dir: string, out: string[]): Promise<void> {
  for (const ent of await listDir(dir)) {
    if (ent.dir || !ent.name.endsWith('.md')) continue;
    const text = (await readText(join(dir, ent.name))) ?? '';
    const name = sanitizeComponentName(frontmatter(text).name || ent.name.replace(/\.md$/, ''));
    if (name && !out.includes(name)) out.push(name);
  }
}

function h2Headings(md: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

/** Installed plugin registry → `name@marketplace` → { version, installPath }. */
function pluginRegistry(reg: Obj | undefined): Map<string, { version?: string; installPath?: string }> {
  const out = new Map<string, { version?: string; installPath?: string }>();
  const plugins = reg && isObj(reg.plugins) ? reg.plugins : undefined;
  if (!plugins) return out;
  for (const [key, val] of Object.entries(plugins)) {
    const v = Array.isArray(val) ? val[val.length - 1] : val;
    if (!isObj(v)) continue;
    const e: { version?: string; installPath?: string } = {};
    if (typeof v.version === 'string') e.version = v.version;
    if (typeof v.installPath === 'string') e.installPath = v.installPath;
    out.set(key, e);
  }
  return out;
}

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/;

/**
 * Snapshot the Claude Code setup as allowlisted metadata (PLAN §7): enabled
 * plugins with versions, skills (name, redacted description, SKILL.md
 * sha256), MCP servers (name, transport, public host only), hooks (event,
 * matcher, type, sha256 of command/url/prompt), CLAUDE.md (sha256 + redacted
 * H2 headings), model, effort, permission mode, output style, subagents.
 * Missing or unparsable files are skipped; arrays are sorted by name.
 */
export async function snapshotSetup(opts: SnapshotSetupOptions): Promise<SetupSnapshot> {
  const configDir = opts.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(opts.homeDir, '.claude');
  const projectDir = opts.projectDir;
  const settings: Settings[] = [];
  for (const [scope, path] of [
    ['user', join(configDir, 'settings.json')],
    ['project', join(projectDir, '.claude', 'settings.json')],
    ['local', join(projectDir, '.claude', 'settings.local.json')],
  ] as const) {
    const data = await readJson(path);
    if (data) settings.push({ scope, data });
  }
  /** Last (most specific) scalar wins. */
  const pick = (get: (d: Obj) => unknown): unknown => {
    let v: unknown;
    for (const s of settings) {
      const x = get(s.data);
      if (x !== undefined && x !== null) v = x;
    }
    return v;
  };

  // Plugins.
  const enabled = new Map<string, boolean>();
  for (const s of settings) {
    if (!isObj(s.data.enabledPlugins)) continue;
    for (const [k, v] of Object.entries(s.data.enabledPlugins)) enabled.set(k, v === true);
  }
  const registry = pluginRegistry(await readJson(join(configDir, 'plugins', 'installed_plugins.json')));
  const plugins: SnapshotPlugin[] = [];
  const pluginDirs: { name: string; path: string }[] = [];
  for (const [key, on] of enabled) {
    if (!on) continue;
    const at = key.lastIndexOf('@');
    const name = sanitizeComponentName(at > 0 ? key.slice(0, at) : key);
    if (!name) continue;
    const p: SnapshotPlugin = { name };
    const mkt = at > 0 ? sanitizeComponentName(key.slice(at + 1)) : undefined;
    if (mkt) p.marketplace = mkt;
    const reg = registry.get(key);
    if (reg?.version && VERSION_RE.test(reg.version)) p.version = reg.version;
    if (reg?.installPath) pluginDirs.push({ name, path: reg.installPath });
    plugins.push(p);
  }

  // Skills.
  const skills: SnapshotSkill[] = [];
  await skillsIn(join(configDir, 'skills'), 'user', opts.redactText, skills);
  await skillsIn(join(projectDir, '.claude', 'skills'), 'project', opts.redactText, skills);
  for (const pd of pluginDirs) await skillsIn(join(pd.path, 'skills'), 'plugin', opts.redactText, skills, pd.name);

  // MCP servers.
  const mcpServers: SnapshotMcpServer[] = [];
  const dotMcp = await readJson(join(projectDir, '.mcp.json'));
  mcpFrom(dotMcp?.mcpServers, 'project', mcpServers);
  for (const s of settings) mcpFrom(s.data.mcpServers, s.scope, mcpServers);
  const claudeJson = await readJson(join(opts.homeDir, '.claude.json'));
  if (claudeJson) {
    mcpFrom(claudeJson.mcpServers, 'user', mcpServers);
    const proj = isObj(claudeJson.projects) ? claudeJson.projects[projectDir] : undefined;
    if (isObj(proj)) mcpFrom(proj.mcpServers, 'local', mcpServers);
  }
  for (const pd of pluginDirs) {
    const pm = await readJson(join(pd.path, '.mcp.json'));
    mcpFrom(pm?.mcpServers ?? pm, 'plugin', mcpServers);
  }

  // Hooks.
  const hooks: SnapshotHook[] = [];
  for (const s of settings) hooksFrom(s.data.hooks, s.scope, hooks);
  for (const pd of pluginDirs) {
    const hj = await readJson(join(pd.path, 'hooks', 'hooks.json'));
    hooksFrom(hj?.hooks, 'plugin', hooks);
  }

  // CLAUDE.md.
  const mdFiles: string[] = [];
  for (const p of [join(configDir, 'CLAUDE.md'), join(projectDir, 'CLAUDE.md'), join(projectDir, '.claude', 'CLAUDE.md')]) {
    const t = await readText(p);
    if (t !== undefined) mdFiles.push(t);
  }

  // Subagents.
  const subagents: string[] = [];
  await agentsIn(join(configDir, 'agents'), subagents);
  await agentsIn(join(projectDir, '.claude', 'agents'), subagents);

  const byName = <T extends { name: string }>(xs: T[]): T[] => xs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const snap: SetupSnapshot = {
    v: 1,
    plugins: byName(plugins).slice(0, 100),
    skills: byName(skills).slice(0, 300),
    mcpServers: byName(mcpServers).slice(0, 100),
    hooks: hooks
      .sort((a, b) => (`${a.event}\0${a.matcher}` < `${b.event}\0${b.matcher}` ? -1 : `${a.event}\0${a.matcher}` > `${b.event}\0${b.matcher}` ? 1 : 0))
      .slice(0, 200),
    model: 'default',
    subagents: subagents.sort().slice(0, 100),
  };
  if (mdFiles.length > 0) {
    const headings: string[] = [];
    for (const md of mdFiles) {
      for (const h of h2Headings(md)) {
        if (headings.length >= 60) break;
        let r = '';
        try {
          r = single(opts.redactText(single(h, 500)), 120);
        } catch {
          r = '';
        }
        headings.push(r);
      }
    }
    snap.claudeMd = { sha256: sha256(mdFiles.join('\n\0\n')), headings };
  }
  const model = opts.model ?? pick((d) => d.model);
  if (typeof model === 'string' && MODEL_RE.test(model)) snap.model = model;
  const effort = pick((d) => d.effortLevel ?? d.effort);
  if (typeof effort === 'string' && EFFORTS.has(effort)) snap.effort = effort as Effort;
  const mode = pick((d) => (isObj(d.permissions) ? d.permissions.defaultMode : undefined));
  if (typeof mode === 'string' && PERMISSION_MODES.has(mode)) snap.permissionMode = mode as PermissionMode;
  const style = pick((d) => d.outputStyle);
  if (typeof style === 'string') {
    const s = sanitizeComponentName(style);
    if (s) snap.outputStyle = s;
  }
  return snap;
}
