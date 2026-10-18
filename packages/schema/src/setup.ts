/**
 * Setup snapshot (client → core, allowlisted metadata only) and the setup
 * card shown with every activity (PLAN §7, UI.md §4).
 *
 * The snapshot **never** contains MCP env, headers or args, hook commands,
 * skill bodies or CLAUDE.md text: only names, hashes and redacted
 * descriptions/headings. Component content is shared only when opted in per
 * component (`shared_components`).
 *
 * @module setup
 */
import { z } from 'zod';
import {
  ComponentName,
  Effort,
  Hostname,
  ModelId,
  PermissionMode,
  Sha256Hex,
  SetupVersionId,
  SharedComponentId,
  VersionString,
  singleLine,
} from './common.js';

/** Where a component is configured. */
export const SetupScope = z.enum(['user', 'project', 'local', 'plugin', 'managed']);
export type SetupScope = z.infer<typeof SetupScope>;

/** MCP transport. Hosts are recorded only for remote transports. */
export const McpTransport = z.enum(['stdio', 'http', 'sse', 'ws', 'sdk', 'unknown']);
export type McpTransport = z.infer<typeof McpTransport>;

/** Hook implementation type. */
export const HookType = z.enum(['command', 'http', 'prompt', 'agent', 'mcp_tool', 'unknown']);
export type HookType = z.infer<typeof HookType>;

/** An enabled plugin (`name@marketplace`, version). */
export const SnapshotPlugin = z.object({
  name: ComponentName,
  marketplace: ComponentName.optional(),
  version: VersionString.optional(),
});
export type SnapshotPlugin = z.infer<typeof SnapshotPlugin>;

/** A skill: name, redacted description and the SHA-256 of its SKILL.md body. */
export const SnapshotSkill = z.object({
  name: ComponentName,
  scope: SetupScope,
  plugin: ComponentName.optional(),
  descriptionRedacted: singleLine(300),
  bodySha256: Sha256Hex,
});
export type SnapshotSkill = z.infer<typeof SnapshotSkill>;

/** An MCP server: name, transport and, for remote servers on public hosts only, the host. */
export const SnapshotMcpServer = z.object({
  name: ComponentName,
  scope: SetupScope,
  transport: McpTransport,
  publicHost: Hostname.optional(),
});
export type SnapshotMcpServer = z.infer<typeof SnapshotMcpServer>;

/** A hook: event, matcher, type and the SHA-256 of its command/URL/prompt. */
export const SnapshotHook = z.object({
  event: z.string().regex(/^[A-Za-z]{1,40}$/),
  matcher: singleLine(200),
  type: HookType,
  scope: SetupScope,
  commandSha256: Sha256Hex,
});
export type SnapshotHook = z.infer<typeof SnapshotHook>;

/**
 * CLAUDE.md (or AGENTS.md for Codex): SHA-256 over the instruction files the
 * harness loads, in load order, joined with `"\n\0\n"`, plus their redacted
 * H2 headings in order. `CLAUDE.local.md` is excluded.
 */
export const SnapshotInstructions = z.object({
  sha256: Sha256Hex,
  headings: z.array(singleLine(120)).max(60),
});
export type SnapshotInstructions = z.infer<typeof SnapshotInstructions>;

/** The allowlisted setup snapshot (`setup_versions.snapshot`). */
export const SetupSnapshot = z.object({
  v: z.literal(1),
  plugins: z.array(SnapshotPlugin).max(100),
  skills: z.array(SnapshotSkill).max(300),
  mcpServers: z.array(SnapshotMcpServer).max(100),
  hooks: z.array(SnapshotHook).max(200),
  claudeMd: SnapshotInstructions.optional(),
  model: ModelId,
  effort: Effort.optional(),
  permissionMode: PermissionMode.optional(),
  outputStyle: ComponentName.optional(),
  subagents: z.array(ComponentName).max(100),
});
export type SetupSnapshot = z.infer<typeof SetupSnapshot>;

/** Kind of a component on a setup card. */
export const SetupComponentKind = z.enum([
  'plugin',
  'skill',
  'mcp_server',
  'hook',
  'claude_md_block',
  'subagent',
  'setting',
]);
export type SetupComponentKind = z.infer<typeof SetupComponentKind>;

/** One component on a setup card (UI.md §4). */
export const SetupComponent = z.object({
  kind: SetupComponentKind,
  name: singleLine(240, 1),
  version: VersionString.optional(),
  descriptionRedacted: singleLine(300).optional(),
  contentShared: z.boolean(),
  sharedComponentId: SharedComponentId.optional(),
});
export type SetupComponent = z.infer<typeof SetupComponent>;

/** The setup card ("gear") posted with an activity. `hash` = setup hash. */
export const SetupCard = z.object({
  id: SetupVersionId,
  hash: Sha256Hex,
  model: ModelId,
  effort: Effort.optional(),
  permissionMode: PermissionMode.optional(),
  components: z.array(SetupComponent).max(1000),
});
export type SetupCard = z.infer<typeof SetupCard>;

/**
 * Deterministic component list for a snapshot (before sharing state is
 * known; every component starts `contentShared: false`). Order: plugins,
 * skills, MCP servers, hooks, CLAUDE.md headings, subagents, settings
 * (`outputStyle`). Hook names are `"<event> <matcher>"` (or just the event);
 * CLAUDE.md headings become `claude_md_block` components.
 */
export function componentsFromSnapshot(snapshot: SetupSnapshot): SetupComponent[] {
  const out: SetupComponent[] = [];
  for (const p of snapshot.plugins) {
    const c: SetupComponent = {
      kind: 'plugin',
      name: p.marketplace ? `${p.name}@${p.marketplace}` : p.name,
      contentShared: false,
    };
    if (p.version) c.version = p.version;
    out.push(c);
  }
  for (const s of snapshot.skills) {
    out.push({ kind: 'skill', name: s.name, descriptionRedacted: s.descriptionRedacted, contentShared: false });
  }
  for (const m of snapshot.mcpServers) {
    const c: SetupComponent = { kind: 'mcp_server', name: m.name, contentShared: false };
    if (m.publicHost) c.descriptionRedacted = `${m.transport} · ${m.publicHost}`;
    else c.descriptionRedacted = m.transport;
    out.push(c);
  }
  for (const h of snapshot.hooks) {
    out.push({ kind: 'hook', name: h.matcher ? `${h.event} ${h.matcher}` : h.event, contentShared: false });
  }
  for (const heading of snapshot.claudeMd?.headings ?? []) {
    out.push({ kind: 'claude_md_block', name: heading || '(untitled)', contentShared: false });
  }
  for (const a of snapshot.subagents) out.push({ kind: 'subagent', name: a, contentShared: false });
  if (snapshot.outputStyle) {
    out.push({ kind: 'setting', name: `outputStyle=${snapshot.outputStyle}`, contentShared: false });
  }
  return out;
}

/**
 * Value whose canonical JSON SHA-256 is the setup hash. Arrays are sorted by
 * name so that reordering config files doesn't change the hash; everything
 * else is used verbatim. Hash with `sha256(canonicalJson(setupHashInput(s)))`.
 */
export function setupHashInput(snapshot: SetupSnapshot): SetupSnapshot {
  const byName = <T extends { name: string }>(xs: readonly T[]): T[] =>
    [...xs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const hooks = [...snapshot.hooks].sort((a, b) => {
    const ka = `${a.event}\u0000${a.matcher}\u0000${a.commandSha256}`;
    const kb = `${b.event}\u0000${b.matcher}\u0000${b.commandSha256}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return {
    ...snapshot,
    plugins: byName(snapshot.plugins),
    skills: byName(snapshot.skills),
    mcpServers: byName(snapshot.mcpServers),
    hooks,
    subagents: [...snapshot.subagents].sort(),
  };
}
