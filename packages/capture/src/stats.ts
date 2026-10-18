/**
 * ActivityStats v1, laps, command classification and test summaries (PLAN §7).
 * Pure functions; stats never contain paths, prompts or output.
 * @module stats
 */
import { emptyStats, type ActivityStats, type CommandStats, type Lap } from '@paceline/schema';
import { PRICING, type ClaudeRecord, type ComputeStatsOptions, type ModelPrice, type Usage } from './types.js';

/* ================================================================ helpers */

/**
 * Sanitize a tool/server/skill name into a `StatKey`: keep
 * `[A-Za-z0-9_.:@/+#-]`, replace anything else with `_`, cut to 128 chars;
 * `''` becomes `_`.
 */
export function sanitizeStatKey(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_.:@/+#-]/g, '_').slice(0, 128);
  return s || '_';
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,79}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/;
const IDLE_GAP_MS = 5 * 60 * 1000;

const ms = (ts: string | undefined): number | undefined => {
  if (!ts) return undefined;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : undefined;
};

const inc = (m: Record<string, number>, k: string, by = 1) => {
  if (!(k in m) && Object.keys(m).length >= 256) return;
  m[k] = (m[k] ?? 0) + by;
};

/** Last usage per `messageId` (records without an id count individually), with the model. */
function dedupedUsage(records: readonly ClaudeRecord[]): { usage: Usage; model?: string }[] {
  const byId = new Map<string, { usage: Usage; model?: string }>();
  let anon = 0;
  for (const r of records) {
    if (r.kind !== 'assistant' || !r.usage) continue;
    const key = r.messageId ?? `\0anon${anon++}`;
    const entry: { usage: Usage; model?: string } = { usage: r.usage };
    if (r.model) entry.model = r.model;
    byId.delete(key); // keep insertion order = last occurrence
    byId.set(key, entry);
  }
  return [...byId.values()];
}

const usageTotal = (u: Usage) => u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;

function priceFor(model: string | undefined, pricing: Readonly<Record<string, ModelPrice>>): ModelPrice | undefined {
  if (!model) return undefined;
  let best: string | undefined;
  for (const prefix of Object.keys(pricing)) {
    if (model.startsWith(prefix) && (!best || prefix.length > best.length)) best = prefix;
  }
  return best ? pricing[best] : undefined;
}

function estimateCost(entries: readonly { usage: Usage; model?: string }[], pricing: Readonly<Record<string, ModelPrice>>): number {
  let usd = 0;
  for (const { usage, model } of entries) {
    const p = priceFor(model, pricing);
    if (!p) continue;
    usd +=
      (usage.inputTokens * p.input +
        usage.outputTokens * p.output +
        usage.cacheReadInputTokens * p.cacheRead +
        usage.cacheCreationInputTokens * p.cacheWrite) /
      1e6;
  }
  return usd;
}

/** Split `mcp__<server>__<tool>`; undefined for non-MCP names. */
export function splitMcpName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith('mcp__')) return undefined;
  const rest = name.slice(5);
  const i = rest.indexOf('__');
  if (i <= 0) return { server: rest || '_', tool: '_' };
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) || '_' };
}

/* ============================================================== commands */

const PKG_MANAGERS = /^(?:npm|pnpm|yarn|bun)$/;

/** Strip `cd x &&`, env assignments, sudo/time/npx/pnpm exec wrappers. */
function firstProgram(command: string): string {
  let c = command.trim();
  // Take the first segment that isn't a `cd`/`export`/`source` prelude.
  const segments = c.split(/\s*(?:&&|\|\||;)\s*/);
  c = segments.find((s) => !/^(?:cd|pushd|export|source|\.|set|echo|clear|true)\b/.test(s.trim()) && s.trim()) ?? segments[0] ?? '';
  c = c.trim().replace(/^\(+/, '');
  for (;;) {
    const before = c;
    c = c.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '');
    c = c.replace(/^(?:sudo|time|nice|command|exec|env)\s+(?:-\S+\s+)*/, '');
    c = c.replace(/^(?:npx|bunx|pnpx)\s+(?:-y\s+|--yes\s+)?/, '');
    c = c.replace(/^(?:pnpm|npm|yarn)\s+(?:exec|dlx)\s+/, '');
    c = c.replace(/^uv\s+run\s+/, '');
    c = c.replace(/^poetry\s+run\s+/, '');
    if (c === before) break;
  }
  return c;
}

/**
 * Classify a Bash command for `stats.commands` by its first meaningful
 * program: test / build / lint / git / install / other.
 */
export function classifyCommand(command: string): keyof CommandStats {
  const c = firstProgram(command);
  const words = c.split(/\s+/);
  const prog = (words[0] ?? '').replace(/^.*\//, '');
  if (PKG_MANAGERS.test(prog)) {
    // Skip flags (and their values for the common ones).
    let i = 1;
    while (i < words.length && words[i]!.startsWith('-')) {
      if (/^(?:--filter|-F|-C|--dir|--prefix|-w|--workspace|--cwd)$/.test(words[i]!)) i += 2;
      else i += 1;
    }
    let sub = words[i] ?? '';
    if (sub === 'run' || sub === 'run-script') sub = words[i + 1] ?? '';
    if (/^(?:install|i|ci|add)$/.test(sub) || (prog === 'yarn' && sub === '')) return 'install';
    if (/^(?:test|tests|t)(?:\b|[:_-])/.test(sub) || /^(?:vitest|jest|mocha)$/.test(sub)) return 'test';
    if (/^(?:build|compile)(?:\b|[:_-])/.test(sub) || sub === 'tsc') return 'build';
    if (/^(?:lint|typecheck|type-check|check-types|format:check|fmt:check)(?:\b|[:_-])?/.test(sub) || /^(?:eslint|biome|prettier)$/.test(sub)) return 'lint';
    return 'other';
  }
  if (/^(?:vitest|jest|mocha|pytest|ava|playwright)$/.test(prog)) return 'test';
  if (/^python3?$/.test(prog) && /\s-m\s+(?:pytest|unittest)\b/.test(c)) return 'test';
  if (prog === 'go') {
    if (words[1] === 'test') return 'test';
    if (words[1] === 'build') return 'build';
    if (words[1] === 'get') return 'install';
    if (words[1] === 'vet') return 'lint';
  }
  if (prog === 'cargo') {
    if (words[1] === 'test' || words[1] === 'nextest') return 'test';
    if (words[1] === 'build') return 'build';
    if (words[1] === 'clippy' || (words[1] === 'fmt' && c.includes('--check'))) return 'lint';
    if (words[1] === 'add' || words[1] === 'install') return 'install';
  }
  if (prog === 'tsc' || prog === 'make' || prog === 'esbuild' || prog === 'webpack' || prog === 'rollup') return 'build';
  if ((prog === 'vite' || prog === 'next' || prog === 'turbo') && words[1] === 'build') return 'build';
  if (prog === 'turbo' && /^(?:test|lint|typecheck)$/.test(words[1] ?? '')) return words[1] === 'test' ? 'test' : 'lint';
  if (/^(?:eslint|biome|ruff|golangci-lint|mypy|pyright|stylelint|shellcheck)$/.test(prog)) return 'lint';
  if (prog === 'prettier' && /--check\b/.test(c)) return 'lint';
  if (prog === 'git' || prog === 'gh') return 'git';
  if (/^pip3?$/.test(prog) && words[1] === 'install') return 'install';
  if (prog === 'uv' && (words[1] === 'add' || (words[1] === 'pip' && words[2] === 'install') || words[1] === 'sync')) return 'install';
  if ((prog === 'brew' || prog === 'apt' || prog === 'apt-get') && words[1] === 'install') return 'install';
  if (prog === 'poetry' && (words[1] === 'add' || words[1] === 'install')) return 'install';
  return 'other';
}

/* ================================================================= tests */

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

function countWord(s: string, word: RegExp): number {
  const m = word.exec(s);
  return m ? Number(m[1]) : 0;
}

/**
 * Parse a test runner's summary from command output (vitest, jest, mocha,
 * pytest, go test, cargo test). Returns the counts of the **last** summary,
 * or `undefined` when none is recognized.
 */
export function parseTestSummary(output: string): { passed: number; failed: number; framework: string } | undefined {
  const text = output.replace(ANSI_RE, '');
  type Hit = { at: number; passed: number; failed: number; framework: string };
  const hits: Hit[] = [];
  // vitest: "Tests  1 failed | 41 passed (42)"
  for (const m of text.matchAll(/^\s*Tests\s{1,}((?:\d+\s+[a-z]+\s*\|?\s*)+)\(\d+\)/gm)) {
    hits.push({ at: m.index, passed: countWord(m[1]!, /(\d+)\s+passed/), failed: countWord(m[1]!, /(\d+)\s+failed/), framework: 'vitest' });
  }
  // jest: "Tests:       1 failed, 41 passed, 42 total"
  for (const m of text.matchAll(/^\s*Tests:\s+(.*?\d+\s+total)/gm)) {
    hits.push({ at: m.index, passed: countWord(m[1]!, /(\d+)\s+passed/), failed: countWord(m[1]!, /(\d+)\s+failed/), framework: 'jest' });
  }
  // mocha: "  42 passing (1s)" [+ "  1 failing"]
  for (const m of text.matchAll(/^\s*(\d+)\s+passing\b.*$(?:\n^\s*\d+\s+pending\b.*$)?(?:\n^\s*(\d+)\s+failing\b)?/gm)) {
    hits.push({ at: m.index, passed: Number(m[1]), failed: m[2] ? Number(m[2]) : 0, framework: 'mocha' });
  }
  // pytest: "==== 2 failed, 40 passed in 1.23s ===="
  for (const m of text.matchAll(/^=+\s*((?:\d+\s+\w+,?\s*)+)\s+in\s+[\d.]+\s*s.*=+\s*$/gm)) {
    const body = m[1]!;
    if (!/passed|failed|error/.test(body)) continue;
    hits.push({
      at: m.index,
      passed: countWord(body, /(\d+)\s+passed/),
      failed: countWord(body, /(\d+)\s+failed/) + countWord(body, /(\d+)\s+errors?/),
      framework: 'pytest',
    });
  }
  // cargo: "test result: ok. 42 passed; 0 failed; ..."
  for (const m of text.matchAll(/^test result: \w+\.\s+(\d+)\s+passed;\s+(\d+)\s+failed/gm)) {
    hits.push({ at: m.index, passed: Number(m[1]), failed: Number(m[2]), framework: 'cargo' });
  }
  // go test: "--- PASS"/"--- FAIL" lines, else "ok  pkg" / "FAIL pkg" package lines.
  const goPkg = [...text.matchAll(/^(ok|FAIL)\s+\S+\s+(?:[\d.]+s|\(cached\))/gm)];
  if (goPkg.length > 0) {
    const pass = (text.match(/^\s*--- PASS:/gm) ?? []).length;
    const fail = (text.match(/^\s*--- FAIL:/gm) ?? []).length;
    const okPkgs = goPkg.filter((m) => m[1] === 'ok').length;
    const failPkgs = goPkg.length - okPkgs;
    hits.push({
      at: goPkg[goPkg.length - 1]!.index,
      passed: pass || okPkgs,
      failed: fail || failPkgs,
      framework: 'go',
    });
  }
  if (hits.length === 0) return undefined;
  hits.sort((a, b) => a.at - b.at);
  const last = hits[hits.length - 1]!;
  return { passed: last.passed, failed: last.failed, framework: last.framework };
}

/* ================================================================= stats */

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const CORRECTION_RE = /^\s*(?:no\b|nope\b|that'?s\s+(?:wrong|not)|not\s+what\s+i|undo\b|revert\b|stop\b|wrong\b)/i;
const PR_URL_RE = /https?:\/\/(?:github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|gitlab\.com\/[\w./-]+\/-\/merge_requests\/\d+)/g;
const GIT_COMMIT_RE = /\bgit\s+(?:-C\s+\S+\s+|-c\s+\S+\s+)*commit\b/;

/** Lines in a file body (a trailing newline doesn't add a line). */
export const lineCount = (s: unknown): number => (typeof s === 'string' && s.length > 0 ? s.replace(/\r?\n$/, '').split('\n').length : 0);

/** Estimate added/removed lines between two strings (multiset line diff). */
export function lineDelta(oldStr: unknown, newStr: unknown): { added: number; removed: number } {
  const a = typeof oldStr === 'string' && oldStr ? oldStr.split('\n') : [];
  const b = typeof newStr === 'string' && newStr ? newStr.split('\n') : [];
  const counts = new Map<string, number>();
  for (const l of a) counts.set(l, (counts.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of b) {
    const c = counts.get(l) ?? 0;
    if (c > 0) counts.set(l, c - 1);
    else added++;
  }
  let removed = 0;
  for (const c of counts.values()) removed += c;
  return { added, removed };
}

function extOf(path: string): string {
  const base = path.replace(/\\/g, '/').replace(/^.*\//, '');
  const i = base.lastIndexOf('.');
  if (i <= 0 || i === base.length - 1) return 'none';
  const ext = base.slice(i + 1).toLowerCase();
  return /^[a-z0-9_+-]{1,16}$/.test(ext) ? ext : 'other';
}

type Input = Record<string, unknown>;
const asInput = (v: unknown): Input => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Input) : {});

interface ToolUse {
  id: string;
  name: string;
  input: Input;
}

/** tool_use blocks of non-sidechain records, de-duplicated by block id. */
function toolUses(records: readonly ClaudeRecord[]): ToolUse[] {
  const seen = new Set<string>();
  const out: ToolUse[] = [];
  for (const r of records) {
    if (r.isSidechain || r.kind !== 'assistant') continue;
    for (const b of r.content) {
      if (b.type !== 'tool_use') continue;
      if (b.id) {
        if (seen.has(b.id)) continue;
        seen.add(b.id);
      }
      out.push({ id: b.id, name: b.name, input: asInput(b.input) });
    }
  }
  return out;
}

interface ToolResult {
  isError: boolean;
  text: string;
  patch?: { linesAdded: number; linesRemoved: number };
}

function toolResults(records: readonly ClaudeRecord[]): Map<string, ToolResult> {
  const out = new Map<string, ToolResult>();
  for (const r of records) {
    if (r.isSidechain) continue;
    for (const b of r.content) {
      if (b.type !== 'tool_result' || !b.toolUseId) continue;
      const res: ToolResult = { isError: b.isError, text: b.text };
      if (r.patch) res.patch = r.patch;
      out.set(b.toolUseId, res);
    }
  }
  return out;
}

/**
 * Compute ActivityStats v1 for one delta of records (see the package docs
 * for the field semantics). Usage is de-duplicated by `message.id` keeping
 * the last line's usage; subagent files are summed into `tokens.subagents`.
 */
export function computeStats(
  main: readonly ClaudeRecord[],
  subagents: readonly (readonly ClaudeRecord[])[],
  opts?: ComputeStatsOptions,
): ActivityStats {
  const lastVersion = [...main].reverse().find((r) => r.version)?.version;
  let harnessVersion = opts?.harnessVersion ?? lastVersion ?? '0';
  if (!VERSION_RE.test(harnessVersion)) harnessVersion = '0';
  const s = emptyStats(harnessVersion);
  if (main.length === 0 && subagents.every((x) => x.length === 0)) return s;
  const pricing = opts?.pricing ?? PRICING;

  // Tokens.
  const mainThread = main.filter((r) => !r.isSidechain);
  const inlineSide = main.filter((r) => r.isSidechain);
  const mainUsage = dedupedUsage(mainThread);
  for (const { usage } of mainUsage) {
    s.tokens.input += usage.inputTokens;
    s.tokens.output += usage.outputTokens;
    s.tokens.cacheRead += usage.cacheReadInputTokens;
    s.tokens.cacheWrite += usage.cacheCreationInputTokens;
  }
  const subUsage = [inlineSide, ...subagents].flatMap((f) => dedupedUsage(f));
  for (const { usage } of subUsage) s.tokens.subagents += usageTotal(usage);
  s.tokens.total = s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite + s.tokens.subagents;

  // Cost.
  const costs = main.map((r) => r.costUsd).filter((c): c is number => c !== undefined);
  if (costs.length > 0) {
    s.costUsd = Math.max(0, costs[costs.length - 1]! - (opts?.previousCostUsd ?? 0));
    s.costSource = 'harness';
  } else {
    s.costUsd = estimateCost([...mainUsage, ...subUsage], pricing);
    s.costSource = 'estimate';
  }

  // Tools.
  const uses = toolUses(main);
  const results = toolResults(main);
  const files = new Map<string, string>();
  const skills: string[] = [];
  const subTypes: string[] = [];
  let lastTest: { summary?: ReturnType<typeof parseTestSummary>; status?: boolean } | undefined;
  for (const u of uses) {
    const mcp = splitMcpName(u.name);
    if (mcp) {
      const server = sanitizeStatKey(mcp.server);
      if (!s.mcp[server] && Object.keys(s.mcp).length >= 64) continue;
      s.mcp[server] ??= {};
      inc(s.mcp[server], sanitizeStatKey(mcp.tool));
      continue;
    }
    inc(s.toolCalls, sanitizeStatKey(u.name));
    const res = results.get(u.id);
    if (u.name === 'Skill') {
      const name = String(u.input.skill ?? u.input.name ?? u.input.command ?? '').trim();
      if (name) {
        const k = sanitizeStatKey(name);
        if (!skills.includes(k) && skills.length < 100) skills.push(k);
      }
    } else if (u.name === 'Task' || u.name === 'Agent') {
      s.subagents.count++;
      const t = typeof u.input.subagent_type === 'string' ? u.input.subagent_type : '';
      if (t) {
        const k = sanitizeStatKey(t);
        if (!subTypes.includes(k) && subTypes.length < 50) subTypes.push(k);
      }
    } else if (EDIT_TOOLS.has(u.name)) {
      if (res?.isError) continue;
      const path = String(u.input.file_path ?? u.input.notebook_path ?? u.input.path ?? '');
      if (path) files.set(path, extOf(path));
      if (res?.patch) {
        s.filesChanged.linesAdded += res.patch.linesAdded;
        s.filesChanged.linesRemoved += res.patch.linesRemoved;
      } else if (u.name === 'Write') {
        s.filesChanged.linesAdded += lineCount(u.input.content);
      } else if (u.name === 'MultiEdit' && Array.isArray(u.input.edits)) {
        for (const e of u.input.edits) {
          const d = lineDelta(asInput(e).old_string, asInput(e).new_string);
          s.filesChanged.linesAdded += d.added;
          s.filesChanged.linesRemoved += d.removed;
        }
      } else {
        const d = lineDelta(u.input.old_string, u.input.new_string ?? u.input.new_source);
        s.filesChanged.linesAdded += d.added;
        s.filesChanged.linesRemoved += d.removed;
      }
    } else if (u.name === 'Bash') {
      const cmd = typeof u.input.command === 'string' ? u.input.command : '';
      if (!cmd) continue;
      const cat = classifyCommand(cmd);
      s.commands[cat]++;
      if (cat === 'test') {
        s.tests.runs++;
        lastTest = {};
        if (res) {
          lastTest.status = !res.isError;
          const summary = parseTestSummary(res.text);
          if (summary) lastTest.summary = summary;
        }
      }
      if (GIT_COMMIT_RE.test(cmd) && res && !res.isError) s.gitCommits = (s.gitCommits ?? 0) + 1;
    }
  }
  s.skillsInvoked = skills;
  s.subagents.types = subTypes;
  s.filesChanged.count = files.size;
  for (const ext of files.values()) inc(s.filesChanged.byExt, ext);

  if (lastTest) {
    if (lastTest.summary) {
      s.tests.last = lastTest.summary;
      s.tests.greenAtEnd = lastTest.summary.failed === 0 && lastTest.summary.passed > 0 && lastTest.status !== false;
      s.tests.confidence = 0.9;
    } else if (lastTest.status !== undefined) {
      s.tests.greenAtEnd = lastTest.status;
      s.tests.confidence = 0.5;
    } else {
      s.tests.greenAtEnd = false;
      s.tests.confidence = 0.2;
    }
  }

  // Errors, PR urls.
  const prUrls = new Set<string>();
  for (const r of mainThread) {
    if (r.isApiError) s.errors.apiErrors++;
    if (r.isInterrupt) s.errors.interrupts++;
    for (const b of r.content) {
      if (b.type === 'tool_result') {
        if (b.isError) s.errors.toolFailures++;
        for (const m of b.text.matchAll(PR_URL_RE)) prUrls.add(m[0].toLowerCase());
      }
    }
  }
  s.prUrlsCount = prUrls.size;

  // Turns, corrections, time.
  const prompts = mainThread.filter((r) => r.isHumanPrompt);
  s.turns = prompts.length;
  s.userCorrections = prompts.slice(1).filter((r) => {
    const t = r.content.find((b) => b.type === 'text');
    return t?.type === 'text' && CORRECTION_RE.test(t.text);
  }).length;
  const timed = mainThread.map((r) => ({ t: ms(r.timestamp), prompt: r.isHumanPrompt })).filter((x): x is { t: number; prompt: boolean } => x.t !== undefined);
  if (timed.length > 0) {
    const ts = timed.map((x) => x.t);
    s.wallMs = Math.max(0, Math.max(...ts) - Math.min(...ts));
    for (let i = 1; i < timed.length; i++) {
      const gap = timed[i]!.t - timed[i - 1]!.t;
      if (timed[i]!.prompt) continue; // user think time
      if (gap > 0 && gap < IDLE_GAP_MS) s.activeMs += gap;
    }
  }

  // Models.
  const models: string[] = [];
  for (const r of [...main, ...subagents.flat()]) {
    if (r.kind !== 'assistant' || !r.model || r.model === '<synthetic>') continue;
    if (!MODEL_RE.test(r.model) || models.includes(r.model) || models.length >= 16) continue;
    models.push(r.model);
  }
  s.models = models;
  return s;
}

/* ================================================================== laps */

/**
 * One lap per non-empty chunk (records read by one Stop hook). Chunks
 * without any timestamp are skipped; `index` counts emitted laps from
 * `firstIndex`.
 */
export function buildLaps(chunks: readonly (readonly ClaudeRecord[])[], firstIndex = 0): Lap[] {
  const laps: Lap[] = [];
  for (const chunk of chunks) {
    const first = chunk.map((r) => ms(r.timestamp)).find((t) => t !== undefined);
    if (first === undefined) continue;
    const mainThread = chunk.filter((r) => !r.isSidechain);
    let tokens = 0;
    for (const { usage } of dedupedUsage(mainThread)) tokens += usageTotal(usage);
    let errors = 0;
    for (const r of mainThread) {
      if (r.isApiError) errors++;
      for (const b of r.content) if (b.type === 'tool_result' && b.isError) errors++;
    }
    laps.push({
      index: firstIndex + laps.length,
      startedAt: new Date(first).toISOString(),
      turns: mainThread.filter((r) => r.isHumanPrompt).length,
      tokens,
      errors,
      toolCalls: toolUses(chunk).length,
    });
  }
  return laps;
}
