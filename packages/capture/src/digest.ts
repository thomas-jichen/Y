/**
 * Deterministic digest builder and error-signature normalization (PLAN §7).
 * The digest is NOT redacted here; run `@y/redact` on `text`.
 * @module digest
 */
import { lineCount, lineDelta, splitMcpName } from './stats.js';
import type { ClaudeRecord, Digest, DigestOptions } from './types.js';

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\u001b[@-Z\\-_]/g;

/** Collapse to one line (`\n` → ` ⏎ `) and cut to `max` chars with `…`. */
function oneLine(text: string, max: number): string {
  const s = text
    .replace(ANSI_RE, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/[ \t]*\r?\n\s*/g, ' ⏎ ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .replace(/(?: ⏎)+$/, '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const CONFIG_PATH_RE = /(?:^|\/)(?:\.claude\/.+|CLAUDE[^/]*\.md|\.mcp\.json|AGENTS\.md)$/;

function relPath(path: string, projectDir?: string): string {
  const p = path.replace(/\\/g, '/');
  if (projectDir) {
    const root = projectDir.replace(/\\/g, '/').replace(/\/+$/, '');
    if (p === root) return '.';
    if (p.startsWith(`${root}/`)) return p.slice(root.length + 1);
  }
  if (p.startsWith('/') || /^[A-Za-z]:\//.test(p) || p.startsWith('~')) return `<ABS>/${p.replace(/^.*\//, '')}`;
  return p;
}

type Kind = 'USER' | 'ASSISTANT' | 'TOOL' | 'ERROR' | 'OK' | 'CONFIG' | 'FINAL';
interface Entry {
  kind: Kind;
  text: string;
  window: boolean;
}

type Input = Record<string, unknown>;
const asInput = (v: unknown): Input => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Input) : {});
const s = (v: unknown): string => (typeof v === 'string' ? v : '');

function toolArg(name: string, input: Input, projectDir?: string): string {
  switch (name) {
    case 'Bash': {
      const root = projectDir?.replace(/\/+$/, '');
      const cmd = root ? s(input.command).split(root).join('.') : s(input.command);
      return oneLine(cmd, 300);
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const path = relPath(s(input.file_path) || s(input.notebook_path) || '?', projectDir);
      let added = 0;
      let removed = 0;
      if (name === 'Write') added = lineCount(input.content);
      else if (name === 'MultiEdit' && Array.isArray(input.edits)) {
        for (const e of input.edits) {
          const d = lineDelta(asInput(e).old_string, asInput(e).new_string);
          added += d.added;
          removed += d.removed;
        }
      } else {
        const d = lineDelta(input.old_string, input.new_string ?? input.new_source);
        added = d.added;
        removed = d.removed;
      }
      return `${oneLine(path, 200)} (+${added}/−${removed})`;
    }
    case 'Read':
      return oneLine(relPath(s(input.file_path) || '?', projectDir), 200);
    case 'Grep':
    case 'Glob':
      return oneLine(s(input.pattern), 200);
    case 'Task':
    case 'Agent':
      return oneLine([s(input.subagent_type), s(input.description)].filter(Boolean).join(': '), 200);
    case 'Skill':
      return oneLine(s(input.skill) || s(input.name), 100);
    case 'WebFetch':
      return oneLine(s(input.url).replace(/[?#].*$/, ''), 200);
    case 'WebSearch':
      return oneLine(s(input.query), 200);
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string');
      return typeof first === 'string' ? oneLine(first, 200) : '';
    }
  }
}

function configDiff(name: string, input: Input): string[] {
  const out: string[] = [];
  const pairs: [string, string][] = [];
  if (name === 'Write') pairs.push(['', s(input.content)]);
  else if (name === 'MultiEdit' && Array.isArray(input.edits)) for (const e of input.edits) pairs.push([s(asInput(e).old_string), s(asInput(e).new_string)]);
  else pairs.push([s(input.old_string), s(input.new_string)]);
  for (const [a, b] of pairs) {
    const al = a ? a.split('\n') : [];
    const bl = b ? b.split('\n') : [];
    const common = new Set(al.filter((l) => bl.includes(l)));
    out.push('@@');
    for (const l of al) if (!common.has(l)) out.push(`-${l}`);
    for (const l of bl) if (!common.has(l)) out.push(`+${l}`);
  }
  return out.slice(0, 40).map((l) => (l.length > 200 ? `${l.slice(0, 199)}…` : l));
}

const approx = (entries: readonly Entry[]) => Math.ceil(entries.reduce((n, e) => n + e.text.length + 1, 0) / 4);

/**
 * Build the deterministic digest that Stage A distills. One entry per line:
 * USER / ASSISTANT / TOOL / ERROR + OK (error→fix) / CONFIG diff / FINAL.
 * Over `maxTokens`, drops ASSISTANT lines, then TOOL/CONFIG lines outside
 * error→fix windows, then the oldest USER lines; never ERROR/OK or FINAL.
 */
export function buildDigest(records: readonly ClaudeRecord[], opts?: DigestOptions): Digest {
  const maxTokens = opts?.maxTokens ?? 24_000;
  const entries: Entry[] = [];
  const tools = new Map<string, { name: string; entry: number }>();
  /** Pending errors by tool name: index of the TOOL entry that failed (window start). */
  const pending = new Map<string, number>();
  let errorWindows = 0;
  let lastAssistantText = '';

  for (const r of records) {
    if (r.isSidechain) continue;
    if (r.isHumanPrompt) {
      const text = r.content.filter((b) => b.type === 'text').map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      entries.push({ kind: 'USER', text: `USER: ${oneLine(text, 1000)}`, window: false });
      continue;
    }
    for (const b of r.content) {
      if (r.kind === 'assistant' && b.type === 'text') {
        const t = oneLine(b.text, 600);
        if (!t) continue;
        lastAssistantText = b.text;
        entries.push({ kind: 'ASSISTANT', text: `ASSISTANT: ${t}`, window: false });
      } else if (r.kind === 'assistant' && b.type === 'tool_use') {
        const mcp = splitMcpName(b.name);
        const input = asInput(b.input);
        const line = mcp ? `TOOL mcp:${mcp.server}/${mcp.tool}` : `TOOL ${b.name}: ${toolArg(b.name, input, opts?.projectDir)}`.trimEnd();
        tools.set(b.id, { name: b.name, entry: entries.length });
        entries.push({ kind: 'TOOL', text: line, window: false });
        const path = s(input.file_path) || s(input.notebook_path);
        if (!mcp && /^(?:Edit|MultiEdit|Write)$/.test(b.name) && CONFIG_PATH_RE.test(path.replace(/\\/g, '/'))) {
          const diff = configDiff(b.name, input);
          entries.push({ kind: 'CONFIG', text: `CONFIG ${relPath(path, opts?.projectDir)}:\n${diff.join('\n')}`, window: false });
        }
      } else if (b.type === 'tool_result') {
        const tool = tools.get(b.toolUseId);
        const name = tool?.name ?? 'unknown';
        const label = splitMcpName(name) ? `mcp:${splitMcpName(name)!.server}/${splitMcpName(name)!.tool}` : name;
        if (b.isError) {
          entries.push({ kind: 'ERROR', text: `ERROR ${label}: ${oneLine(b.text, 800)}`, window: true });
          if (tool) entries[tool.entry]!.window = true;
          if (!pending.has(name)) pending.set(name, tool?.entry ?? entries.length - 1);
        } else if (pending.has(name)) {
          entries.push({ kind: 'OK', text: `OK ${label}: ${oneLine(b.text, 300)}`, window: true });
          const start = pending.get(name)!;
          for (let i = start; i < entries.length; i++) if (entries[i]!.kind === 'TOOL') entries[i]!.window = true;
          pending.delete(name);
          errorWindows++;
        }
      }
    }
  }
  const final = opts?.lastAssistantMessage ?? lastAssistantText;
  if (final.trim()) entries.push({ kind: 'FINAL', text: `FINAL: ${oneLine(final, 600)}`, window: true });

  let truncated = false;
  const dropWhere = (pred: (e: Entry) => boolean) => {
    for (let i = 0; i < entries.length && approx(entries) > maxTokens; ) {
      if (pred(entries[i]!)) {
        entries.splice(i, 1);
        truncated = true;
      } else i++;
    }
  };
  if (approx(entries) > maxTokens) {
    dropWhere((e) => e.kind === 'ASSISTANT');
    dropWhere((e) => (e.kind === 'TOOL' || e.kind === 'CONFIG') && !e.window);
    dropWhere((e) => e.kind === 'USER');
  }
  const text = entries.map((e) => e.text).join('\n');
  return { text, approxTokens: Math.ceil(text.length / 4), truncated, errorWindows };
}

/* ======================================================== error signature */

const ERRORISH_RE = /error|fail|exception|panic|\bE[A-Z]{2,}\b/i;
const CODE_RE = /\bE[A-Z]{2,}\b/;

/**
 * Normalize an error message into a stable signature for trigram matching:
 * strip ANSI; pick the first error-ish line; replace URLs, paths (with
 * `:line:col`), UUIDs/hex, IPs, long quoted strings and standalone numbers
 * (ports, durations, counts) with placeholders, keeping error codes such as
 * `etimedout`, `e404` and `ts2345`; lowercase; collapse whitespace; cap 300.
 * Idempotent. Returns `''` for input with no visible text.
 */
export function normalizeErrorSignature(text: string): string {
  const lines = text
    .replace(ANSI_RE, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/[\u0000-\u001f\u007f]/g, ' ').trim())
    .filter(Boolean);
  if (lines.length === 0) return '';
  let line = lines.find((l) => ERRORISH_RE.test(l) && (CODE_RE.test(l) || /error|exception|panic|fail/i.test(l))) ?? lines[0]!;
  line = line
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>)]+/gi, '<url>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<hex>')
    .replace(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g, '<ip>')
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s'"`<>:]+(?::\d+){0,2}/g, '<path>')
    .replace(/(?<![\w<])(?:~|\.{1,2})?\/(?:[^\s/'"`<>():]+\/)*[^\s/'"`<>():]+(?::\d+){0,2}/g, '<path>')
    .replace(/(?<![\w/<])(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,8}(?::\d+){0,2}\b/g, '<path>')
    .replace(/\b[\w.-]+\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|vue|svelte|json|ya?ml|toml|sql|sh)(?::\d+){1,2}\b/g, '<path>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/(["'`])(?:(?!\1).){25,}?\1/g, '<str>')
    .replace(/(?<![A-Za-z0-9_.<])\d+(?:\.\d+)*(?![A-Za-z0-9_])/g, '<n>')
    .replace(/(?<![A-Za-z0-9_.<])\d+(?=(?:ms|s|m|h|kb|mb|gb|b)\b)/gi, '<n>')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > 300 ? line.slice(0, 300).trimEnd() : line;
}
