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

/** A marker in `@y/redact`'s grammar, so pass-1 redaction keeps it as is. */
const CLI_SECRET = '<REDACTED:cli_password>';
const CONFIG_VALUE = '<REDACTED:config_value>';
const SECRET_NAME =
  '(?:[A-Za-z0-9_]*(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)[A-Za-z0-9_]*|(?:[A-Za-z0-9_]*_)?(?:PASS|PW)(?:_[A-Za-z0-9_]*)?)';
const ENV_ASSIGN_RE = new RegExp(`(^|[\\s;&|(])((?:export\\s+)?${SECRET_NAME})=("[^"]*"|'[^']*'|\\S+)`, 'gi');
/** Names that only describe a secret (a count, limit, lifetime or the shell's working dirs), not hold one: `MAX_TOKENS`, `TOKEN_TTL`, `OLDPWD`. */
const NOT_A_SECRET_NAME_RE = /(?:^|_)(?:MAX|MIN|NUM|COUNT|LIMIT|LEN|LENGTH|SIZE|TTL|EXPIRY|EXPIRES|TIMEOUT)(?:_|$)|TOKENS(?:_|$)|^(?:OLD)?PWD$/i;
/** The `PASS`/`PW` alternative only (not `PASSWORD`, `TOKEN` …): env-style upper case only, so `pass_through=true` is an argument. */
const SHORT_PASS_NAME_RE = /^(?:[A-Za-z0-9_]*_)?(?:PASS|PW)(?:_[A-Za-z0-9_]*)?$/i;
const LONG_SECRET_NAME_RE = /PASSWORD|PASSWD|PWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?/i;

/** Whether an assigned name holds a secret (see {@link ENV_ASSIGN_RE}). */
function secretAssignName(name: string): boolean {
  const n = name.replace(/^export\s+/, '');
  if (NOT_A_SECRET_NAME_RE.test(n)) return false;
  if (LONG_SECRET_NAME_RE.test(n)) return true;
  return SHORT_PASS_NAME_RE.test(n) && n === n.toUpperCase();
}

/**
 * Split a shell command into segments at `;`, `&`, `|` and newlines outside
 * quotes, keeping the separators, so per-tool masks (`mysql -pX`, `docker
 * login -p X`) apply only to that tool's own arguments.
 */
function shellSegments(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (c === '\\' && quote !== "'" && i + 1 < cmd.length) {
      cur += c + cmd[++i];
      continue;
    }
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ';' || c === '&' || c === '|' || c === '\n') {
      if (cur) out.push(cur);
      let sep = c;
      while (i + 1 < cmd.length && /[;&|\n]/.test(cmd[i + 1]!)) sep += cmd[++i];
      out.push(sep);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** Apply `mask` to each segment of `cmd` that `when` matches. */
function perSegment(cmd: string, when: RegExp, mask: (segment: string) => string): string {
  return shellSegments(cmd)
    .map((seg) => (when.test(seg) ? mask(seg) : seg))
    .join('');
}
const MYSQL_RE = /\b(?:mysql\w*|mariadb\w*)\b/;
const ARG = `("[^"]*"|'[^']*'|\\S+)`;

/** `htpasswd -b[c…] file user PW` / `htpasswd -nb user PW`: the password is a positional argument. */
function maskHtpasswd(cmd: string): string {
  return cmd.replace(/(\bhtpasswd((?:\s+-[A-Za-z]+)+))((?:\s+(?:"[^"]*"|'[^']*'|\S+))+)/g, (m, head: string, flags: string, rest: string) => {
    if (!/b/.test(flags)) return m;
    const positional = /n/.test(flags) ? 2 : 3;
    const args = [...rest.matchAll(/(\s+)("[^"]*"|'[^']*'|\S+)/g)];
    if (args.length < positional) return m;
    return head + args.map((a, i) => (i === positional - 1 ? `${a[1]}${CLI_SECRET}` : a[0])).join('');
  });
}

/**
 * Mask passwords that command-line tools take as arguments: `sshpass -p X`,
 * `--password X` / `--password=X` (and `--http-password`-style), `mysql -pX`, `curl -u user:X` (or
 * `-uuser:X`), `docker login -p X`, `redis-cli -a X`, `htpasswd -b … X` and
 * `PGPASSWORD=X` / `DB_PASS=X`-style assignments. Generic secret shapes are
 * `@y/redact`'s job; these have no shape of their own, only a position.
 * Exported for tests.
 */
export function maskCliSecrets(cmd: string): string {
  let out = cmd
    .replace(new RegExp(`(\\bsshpass\\s+-p\\s*)${ARG}`, 'g'), `$1${CLI_SECRET}`)
    .replace(new RegExp(`(\\s--(?:[a-z]+-)?(?:password|passwd)(?:=|\\s+))(?!-)${ARG}`, 'gi'), `$1${CLI_SECRET}`)
    .replace(ENV_ASSIGN_RE, (m, pre: string, name: string) => (secretAssignName(name) ? `${pre}${name}=${CLI_SECRET}` : m));
  // Tool-specific flags are masked only inside that tool's own command segment
  // (`mkdir -pv out && mysql …` keeps `-pv`; `docker run -p 8080:80` after a login keeps its port).
  if (/\b(?:curl|wget|http)\b/.test(out)) {
    out = perSegment(out, /\b(?:curl|wget|http)\b/, (seg) => seg.replace(/(\s(?:-u\s*|--user(?:=|\s+))["']?[^\s:"'-][^\s:"']*:)([^\s"']+)/g, `$1${CLI_SECRET}`));
  }
  if (MYSQL_RE.test(out)) out = perSegment(out, MYSQL_RE, (seg) => seg.replace(/(\s-p)(?![\s-])("[^"]*"|'[^']*'|\S+)/g, `$1${CLI_SECRET}`));
  const LOGIN_RE = /\b(?:docker|podman|nerdctl|buildah|skopeo|helm\s+registry)\s+login\b/;
  if (LOGIN_RE.test(out)) out = perSegment(out, LOGIN_RE, (seg) => seg.replace(new RegExp(`(\\s-p\\s*)(?!-)${ARG}`, 'g'), `$1${CLI_SECRET}`));
  if (/\bredis-cli\b/.test(out)) {
    out = perSegment(out, /\bredis-cli\b/, (seg) => seg.replace(new RegExp(`(\\s(?:-a\\s*|--pass\\s+))(?!-)${ARG}`, 'g'), `$1${CLI_SECRET}`));
  }
  if (/\bhtpasswd\b/.test(out)) out = maskHtpasswd(out);
  return out;
}

/** A shell word naming a config path (quotes stripped). */
function configTarget(word: string): string | undefined {
  const w = word.replace(/^["']|["']$/g, '');
  return CONFIG_PATH_RE.test(w.replace(/\\/g, '/')) ? w : undefined;
}

const isMarkdown = (p: string) => /\.md$/i.test(p);

/**
 * A Bash command that writes agent config other than markdown (`cat > .mcp.json
 * <<EOF …`, `echo '{…}' > .claude/settings.json`, `tee`, `sed -i`) carries the
 * same env values and hook commands as an Edit of it: keep the verb and the
 * target, drop the rest. Undefined when the command writes no such file.
 */
function maskConfigWrite(cmd: string): string | undefined {
  const targets: string[] = [];
  for (const m of cmd.matchAll(/>{1,2}\|?\s*("[^"]+"|'[^']+'|[^\s;&|<>]+)/g)) {
    const t = configTarget(m[1]!);
    if (t) targets.push(t);
  }
  for (const m of cmd.matchAll(/\btee\b((?:\s+-\S+)*)((?:\s+(?:"[^"]+"|'[^']+'|[^\s;&|<>-][^\s;&|<>]*))+)/g)) {
    for (const w of m[2]!.trim().split(/\s+/)) {
      const t = configTarget(w);
      if (t) targets.push(t);
    }
  }
  if (/\b(?:sed|perl)\b[^;&|]*\s-[A-Za-z]*i/.test(cmd) || /\bsed\b[^;&|]*--in-place/.test(cmd)) {
    for (const w of cmd.split(/\s+/)) {
      const t = configTarget(w);
      if (t) targets.push(t);
    }
  }
  const hidden = targets.filter((t) => !isMarkdown(t));
  if (hidden.length === 0) return undefined;
  const verb = /^\s*([A-Za-z0-9_./-]+)/.exec(cmd)?.[1] ?? 'write';
  return `${verb} … ${[...new Set(hidden)].join(' ')} ${CONFIG_VALUE}`;
}

function toolArg(name: string, input: Input, projectDir?: string): string {
  switch (name) {
    case 'Bash': {
      const root = projectDir?.replace(/\/+$/, '');
      const cmd = root ? s(input.command).split(root).join('.') : s(input.command);
      return oneLine(maskConfigWrite(cmd) ?? maskCliSecrets(cmd), 300);
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

/** JSON keys whose string values are enums or tool names, kept so the distiller still sees the shape. */
const SAFE_JSON_KEYS = new Set(['type', 'matcher', 'defaultMode', 'outputStyle', 'model', 'theme', 'source']);

/**
 * JSON agent config (`.mcp.json`, `.claude/settings*.json`, hooks.json) holds
 * MCP env blocks, headers, args (connection strings) and hook commands, which
 * the setup snapshot never sends (setup.ts). Allowlist: a line keeps only
 * JSON tokens it can read completely (keys, punctuation, numbers, booleans,
 * null, and the string values of a few enum keys); every other string value
 * becomes the marker, and from the first thing that isn't a whole JSON token
 * (an Edit fragment that starts or ends inside a string, a bare value, a
 * comment) the rest of the line does too.
 */
function maskJsonConfigLine(line: string): string {
  const sign = /^[+-]/.test(line) ? line[0]! : '';
  const body = sign ? line.slice(1) : line;
  if (!sign && body === '@@') return line;
  let out = '';
  let i = 0;
  let lastKey: string | undefined;
  const TOKEN = /\s+|[{}[\],]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w.])|(?:true|false|null)(?![\w])|"((?:[^"\\]|\\.)*)"(\s*:)?/y;
  while (i < body.length) {
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(body);
    if (!m) {
      out += CONFIG_VALUE; // not a whole JSON token from here on: nothing of it is kept
      break;
    }
    const [tok, str, colon] = m;
    if (str !== undefined && colon) {
      out += tok;
      lastKey = str;
    } else if (str !== undefined) {
      const keep = lastKey !== undefined && SAFE_JSON_KEYS.has(lastKey) && /^[A-Za-z0-9_.:|*() -]{0,60}$/.test(str);
      out += keep ? tok : `"${CONFIG_VALUE}"`;
      lastKey = undefined;
    } else {
      out += tok;
      if (!/^\s+$/.test(tok)) lastKey = undefined;
    }
    i += tok.length;
  }
  return sign + out;
}

function configDiff(name: string, input: Input, isJson = false): string[] {
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
  return out
    .slice(0, 40)
    .map((l) => (isJson ? maskJsonConfigLine(l) : l))
    .map((l) => (l.length > 200 ? `${l.slice(0, 199)}…` : l));
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
          const rel = relPath(path, opts?.projectDir);
          if (isMarkdown(path)) {
            entries.push({ kind: 'CONFIG', text: `CONFIG ${rel}:\n${configDiff(b.name, input).join('\n')}`, window: false });
          } else if (/\.json$/i.test(path)) {
            entries.push({ kind: 'CONFIG', text: `CONFIG ${rel}:\n${configDiff(b.name, input, true).join('\n')}`, window: false });
          } else {
            // Hook scripts and other non-markdown config: commands and credentials, never their text.
            entries.push({ kind: 'CONFIG', text: `CONFIG ${rel}: content withheld`, window: false });
          }
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
