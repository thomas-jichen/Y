/**
 * Transcript reading (byte cursor) and tolerant Claude Code record parsing.
 * @module transcript
 */
import { open, stat } from 'node:fs/promises';
import type {
  ClaudeRecord,
  ContentBlock,
  ParseResult,
  ReadDeltaOptions,
  TranscriptCursor,
  TranscriptDelta,
  Usage,
} from './types.js';

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const NL = 0x0a;

/**
 * Read the complete lines appended to a JSONL file since `cursor`. A trailing
 * partial line is left for the next call. Restarts at 0 (`reset: true`) when
 * the inode changed or the file shrank below the cursor. Missing file → empty.
 */
export async function readTranscriptDelta(
  path: string,
  cursor: TranscriptCursor | null | undefined,
  opts?: ReadDeltaOptions,
): Promise<TranscriptDelta> {
  const maxBytes = Math.max(1, opts?.maxBytes ?? DEFAULT_MAX_BYTES);
  let st;
  try {
    st = await stat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { lines: [], cursor: cursor ?? { offset: 0 }, reset: false, more: false };
    }
    throw e;
  }
  let offset = cursor?.offset ?? 0;
  let reset = false;
  if (cursor && ((cursor.ino !== undefined && cursor.ino !== st.ino) || st.size < cursor.offset)) {
    offset = 0;
    reset = true;
  }
  const size = st.size;
  if (offset >= size) {
    return { lines: [], cursor: { offset, ino: st.ino, size }, reset, more: false };
  }
  const fh = await open(path, 'r');
  try {
    // Read up to maxBytes; if no newline in that window, keep extending so a
    // single huge line can't stall the cursor forever.
    let want = Math.min(maxBytes, size - offset);
    let buf = Buffer.alloc(0);
    let lastNl = -1;
    for (;;) {
      const chunk = Buffer.alloc(want - buf.length);
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, offset + buf.length);
      buf = Buffer.concat([buf, chunk.subarray(0, bytesRead)]);
      lastNl = buf.lastIndexOf(NL);
      if (lastNl >= 0 || bytesRead === 0 || offset + buf.length >= size) break;
      want = Math.min(buf.length + maxBytes, size - offset);
    }
    if (lastNl < 0) {
      return { lines: [], cursor: { offset, ino: st.ino, size }, reset, more: false };
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(0, lastNl));
    const lines = text
      .split('\n')
      .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
      .filter((l) => l.trim().length > 0);
    const newOffset = offset + lastNl + 1;
    // `more` = bytes beyond what we consumed that contain another complete line
    // we didn't read because of maxBytes.
    const more = newOffset < size && offset + buf.length < size;
    return { lines, cursor: { offset: newOffset, ino: st.ino, size }, reset, more };
  } finally {
    await fh.close();
  }
}

/* ================================================================ parsing */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

function flattenToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (isObj(c) && c.type === 'text' && typeof c.text === 'string' ? c.text : typeof c === 'string' ? c : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function parseBlock(b: unknown): ContentBlock | undefined {
  if (typeof b === 'string') return { type: 'text', text: b };
  if (!isObj(b)) return undefined;
  const t = str(b.type) ?? 'unknown';
  switch (t) {
    case 'text':
      return { type: 'text', text: str(b.text) ?? '' };
    case 'tool_use':
    case 'server_tool_use':
      return { type: 'tool_use', id: str(b.id) ?? '', name: str(b.name) ?? 'unknown', input: b.input ?? {} };
    case 'tool_result':
      return {
        type: 'tool_result',
        toolUseId: str(b.tool_use_id) ?? str(b.toolUseId) ?? '',
        isError: b.is_error === true || b.isError === true,
        text: flattenToText(b.content),
      };
    case 'thinking':
    case 'redacted_thinking':
      return { type: 'thinking' };
    case 'image':
    case 'document':
      return { type: 'image' };
    default:
      return { type: 'other', rawType: t.slice(0, 64) };
  }
}

function parseUsage(u: unknown): Usage | undefined {
  if (!isObj(u)) return undefined;
  return {
    inputTokens: num(u.input_tokens ?? u.inputTokens),
    outputTokens: num(u.output_tokens ?? u.outputTokens),
    cacheReadInputTokens: num(u.cache_read_input_tokens ?? u.cacheReadInputTokens),
    cacheCreationInputTokens: num(u.cache_creation_input_tokens ?? u.cacheCreationInputTokens),
  };
}

function patchFrom(tur: unknown): { linesAdded: number; linesRemoved: number } | undefined {
  if (!isObj(tur)) return undefined;
  const sp = tur.structuredPatch;
  if (!Array.isArray(sp)) return undefined;
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const hunk of sp) {
    if (!isObj(hunk) || !Array.isArray(hunk.lines)) continue;
    for (const l of hunk.lines) {
      if (typeof l !== 'string') continue;
      if (l.startsWith('+')) linesAdded++;
      else if (l.startsWith('-')) linesRemoved++;
    }
  }
  return { linesAdded, linesRemoved };
}

function costFrom(r: Obj): number | undefined {
  const c = r.costUSD ?? r.costUsd ?? r.cost_usd ?? (isObj(r.cost) ? (r.cost.total_cost_usd ?? r.cost.totalCostUsd) : undefined);
  return typeof c === 'number' && Number.isFinite(c) && c >= 0 ? c : undefined;
}

const KINDS = new Set(['user', 'assistant', 'system', 'summary']);
const INTERRUPT_RE = /^\[Request interrupted by user/;

function parseOne(line: string): ClaudeRecord | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObj(raw) || typeof raw.type !== 'string') return undefined;
  const type = raw.type;
  const kind = (KINDS.has(type) ? type : 'other') as ClaudeRecord['kind'];
  const msg = isObj(raw.message) ? raw.message : undefined;
  const roleRaw = str(msg?.role);
  const role = roleRaw === 'user' || roleRaw === 'assistant' ? roleRaw : undefined;
  const content: ContentBlock[] = [];
  const mc = msg?.content;
  if (typeof mc === 'string') content.push({ type: 'text', text: mc });
  else if (Array.isArray(mc)) for (const b of mc) {
    const p = parseBlock(b);
    if (p) content.push(p);
  }
  const isSidechain = raw.isSidechain === true;
  const isMeta = raw.isMeta === true;
  const firstText = content.find((b): b is { type: 'text'; text: string } => b.type === 'text')?.text ?? '';
  const hasToolResult = content.some((b) => b.type === 'tool_result');
  const isInterrupt = kind === 'user' && INTERRUPT_RE.test(firstText.trimStart());
  const isApiError = raw.isApiErrorMessage === true || raw.isApiError === true;
  const isHumanPrompt =
    kind === 'user' &&
    (role ?? 'user') === 'user' &&
    !isMeta &&
    !isSidechain &&
    !hasToolResult &&
    !isInterrupt &&
    firstText.trim().length > 0 &&
    !/^<(?:local-command-std(?:out|err)|system-reminder|command-stdout)>/.test(firstText.trimStart());
  const rec: ClaudeRecord = {
    kind,
    isSidechain,
    isMeta,
    content,
    isApiError,
    isInterrupt,
    isHumanPrompt,
  };
  const set = <K extends keyof ClaudeRecord>(k: K, v: ClaudeRecord[K] | undefined) => {
    if (v !== undefined) rec[k] = v;
  };
  set('uuid', str(raw.uuid));
  set('parentUuid', str(raw.parentUuid));
  set('timestamp', str(raw.timestamp));
  set('sessionId', str(raw.sessionId) ?? str(raw.session_id));
  set('version', str(raw.version));
  set('origin', str(raw.origin) ?? (isObj(raw.origin) ? str(raw.origin.kind) : undefined));
  set('messageId', str(msg?.id));
  set('role', role);
  set('model', str(msg?.model));
  set('usage', kind === 'assistant' ? parseUsage(msg?.usage) : undefined);
  set('costUsd', costFrom(raw));
  set('patch', patchFrom(raw.toolUseResult));
  return rec;
}

/**
 * Parse Claude Code transcript lines. Never throws; non-JSON lines,
 * non-objects and records without a string `type` are counted in `skipped`.
 * Unknown record types become `kind: 'other'`; unknown blocks `{type:'other'}`.
 */
export function parseClaudeRecords(lines: readonly string[]): ParseResult {
  const records: ClaudeRecord[] = [];
  let skipped = 0;
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    const r = parseOne(line);
    if (r) records.push(r);
    else skipped++;
  }
  return { records, skipped };
}
