/**
 * Redaction pass 1 (on the machine, before anything is written to the
 * outbox). Identity terms come from local sources only (OS user, hostname,
 * project dirname, `[user]` name/email from the repo's git config,
 * `~/.gitconfig` and the XDG git config with one level of includes, the
 * origin remote); no subprocesses. Name parts that are ordinary words
 * ("Will", "Max") are not terms on their own; the full name always is.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { identityTermsFrom, redact, type IdentityTerms, type RedactResult } from '@y/redact';

const cache = new Map<string, IdentityTerms | undefined>();

/**
 * The git config file of the repo containing `dir`: walks up (≤ 6 levels) and
 * stops at the first `.git`. A `.git` directory → `.git/config`; a `.git`
 * file (worktree, submodule) → its `gitdir:`, then that dir's `commondir`.
 */
export function gitConfigPath(dir: string | undefined): string | undefined {
  let d = dir;
  for (let i = 0; d && i < 6; i++) {
    const dotGit = path.join(d, '.git');
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(dotGit);
    } catch {
      st = undefined;
    }
    if (st?.isDirectory()) return path.join(dotGit, 'config');
    if (st?.isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? '');
      if (!m) return undefined;
      const gitdir = path.resolve(d, m[1]!);
      const common = readText(path.join(gitdir, 'commondir'))?.trim();
      return path.join(common ? path.resolve(gitdir, common) : gitdir, 'config');
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return undefined;
}

/** Read `[remote "origin"] url` from the repo's git config. */
export function gitRemote(dir: string | undefined): string | undefined {
  const file = gitConfigPath(dir);
  const cfg = file ? readText(file) : undefined;
  if (cfg === undefined) return undefined;
  const m = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(cfg);
  return m?.[1];
}

/** A git config value: quoted part as is, otherwise cut at an inline `#` / `;` comment. */
function configValue(raw: string): string {
  const v = raw.trim();
  const q = /^"((?:[^"\\]|\\.)*)"/.exec(v);
  if (q) return q[1]!.replace(/\\(.)/g, '$1').trim();
  return v.replace(/\s[#;].*$/, '').replace(/^[#;].*$/, '').trim();
}

interface GitUserEntry {
  key: 'name' | 'email' | 'include';
  value: string;
  /** For `include`: from `[includeIf …]` (conditional), not `[include]`. */
  conditional?: boolean;
}

function scanGitConfig(cfg: string): GitUserEntry[] {
  const out: GitUserEntry[] = [];
  let section: 'user' | 'include' | 'includeIf' | undefined;
  for (const raw of cfg.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[\s*([A-Za-z0-9.-]+)(\s+"[^"]*")?\s*\]/.exec(line);
    if (sec) {
      const name = sec[1]!.toLowerCase();
      section = name === 'user' && !sec[2] ? 'user' : name === 'include' && !sec[2] ? 'include' : name === 'includeif' && sec[2] ? 'includeIf' : undefined;
      continue;
    }
    if (!section) continue;
    const kv = /^([A-Za-z0-9-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const k = kv[1]!.toLowerCase();
    const v = configValue(kv[2]!).slice(0, 200);
    if (!v) continue;
    if (section === 'user' && (k === 'name' || k === 'email')) out.push({ key: k, value: v });
    else if (section !== 'user' && k === 'path') out.push({ key: 'include', value: v, conditional: section === 'includeIf' });
  }
  return out;
}

/** `[user] name` / `email` from one git config file's text (simple ini scan, last value wins). */
export function parseGitUser(cfg: string): { name?: string; email?: string } {
  const out: { name?: string; email?: string } = {};
  for (const e of scanGitConfig(cfg)) if (e.key !== 'include') out[e.key] = e.value;
  return out;
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** An included path: `~/` is the home dir, a relative path is relative to the including file. */
function includeTarget(value: string, from: string, home: string): string {
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return path.resolve(path.dirname(from), value);
}

interface ConfigSource {
  /** `[user]` values in git's order (later wins), unconditional includes inlined (one level). */
  effective: { name?: string; email?: string };
  /** Every name/email seen, including in `[includeIf]` files (identities this machine uses). */
  all: { names: string[]; emails: string[] };
}

function readConfigSource(file: string, home: string): ConfigSource {
  const effective: { name?: string; email?: string } = {};
  const all = { names: [] as string[], emails: [] as string[] };
  const note = (k: 'name' | 'email', v: string) => (k === 'name' ? all.names : all.emails).push(v);
  for (const e of scanGitConfig(readText(file) ?? '')) {
    if (e.key !== 'include') {
      effective[e.key] = e.value;
      note(e.key, e.value);
      continue;
    }
    // One level of include.path / includeIf.*.path; includeIf conditions aren't evaluated, so
    // those identities are redacted but never treated as the effective one.
    for (const inc of scanGitConfig(readText(includeTarget(e.value, file, home)) ?? '')) {
      if (inc.key === 'include') continue;
      note(inc.key, inc.value);
      if (!e.conditional) effective[inc.key] = inc.value;
    }
  }
  return { effective, all };
}

function gitSources(dir: string | undefined, home: string, xdgConfigHome: string): ConfigSource[] {
  // git's order: XDG config, then ~/.gitconfig, then the repo's config (later wins).
  const files = [path.join(xdgConfigHome, 'git', 'config'), path.join(home, '.gitconfig')];
  const local = gitConfigPath(dir);
  if (local) files.push(local);
  return files.map((f) => readConfigSource(f, home));
}

function defaultXdg(home: string): string {
  return home === os.homedir() && process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME : path.join(home, '.config');
}

/** The git identity git would use (repo config over `~/.gitconfig` over the XDG config). No subprocess. */
export function gitIdentity(dir: string | undefined, home: string = os.homedir(), xdgConfigHome: string = defaultXdg(home)): { name?: string; email?: string } {
  return gitSources(dir, home, xdgConfigHome).reduce<{ name?: string; email?: string }>((acc, s) => ({ ...acc, ...s.effective }), {});
}

/** Every git name and email configured on this machine for `dir` (effective and included identities). */
export function gitIdentities(dir: string | undefined, home: string = os.homedir(), xdgConfigHome: string = defaultXdg(home)): { names: string[]; emails: string[] } {
  const names = new Set<string>();
  const emails = new Set<string>();
  for (const s of gitSources(dir, home, xdgConfigHome)) {
    s.all.names.forEach((n) => names.add(n));
    s.all.emails.forEach((e) => emails.add(e));
  }
  return { names: [...names], emails: [...emails] };
}

/**
 * Name parts that are also ordinary English words (or very common code words):
 * a single token like "Will" or "Max" would otherwise replace "will" and
 * `Math.max` throughout digests. The full name is always redacted as a phrase.
 */
const COMMON_NAME_WORDS = new Set(
  (
    'will mark grant bill hope faith rose june april august frank jack earl dean lane chase cash gene hunter king miles page penny ' +
    'rich rusty sandy summer wade ward young brown green white black gray grey long little short small case cook bell hall hill wood ' +
    'stone field ford park price reed rice rock shaw snow storm west north south east love star best fox lamb day may ray max art ' +
    'joy guy win pat sue rob bob don ben dan tom ken roy sam lee kim van von de la le del der bay cole drew nick crystal amber ' +
    'ivy jade pearl ruby dawn eve autumn river sky skye rain clay glen dale hazel heath holly iris lily violet basil sage ' +
    'carter cooper porter mason taylor turner walker baker butler fisher fletcher miller parker potter sawyer shepherd smith ' +
    'tanner thatcher weaver wright archer bishop booth brook brooks burns bush cross dale dick dock duke fair fry gill hart ' +
    'hawk hay hood horn hunt keen knight lake land leach lord lucky major marsh mayor moon more moss nash noble oak pace pike ' +
    'pool pope rush salt sharp shields short silver steel sweet swift thorn trout wall wells wild wise wolf worth bond chance ' +
    'christian joy major victor angel august barley bear blue cloud coin dash echo free gold honey ice jet joy legend link ' +
    'lion lucky lux mars meadow mercy ocean phoenix poppy rebel royal saint scout shadow sonny spring sterling sunny tiger trinity ' +
    'unity wren zen test user admin root build main node'
  ).split(/\s+/),
);

/**
 * Tool, product and code words that show up as git names of bots and agents
 * ("Claude Code", "GitHub Actions", "Deploy Bot"), plus `@y/redact`'s common
 * words: never a term on their own, and a name made only of them is not one either.
 */
const TECH_WORDS = new Set(
  (
    'claude code codex copilot cursor devin agent agents bot bots github gitlab bitbucket actions action workflow workflows ' +
    'docker compose kubernetes server servers client data deploy deployer deployment release releases bump automation ' +
    'auto runner runners pipeline service services system sync merge renovate dependabot ci cd ops devops infra platform ' +
    'cloud web app apps api core lib src test tests main dev local localhost repo project docs packages users home tmp www ' +
    'com org the and node user admin root build builder'
  ).split(/\s+/),
);

/** Terms for a git name: the full name, plus its parts of ≥ 4 chars that aren't common words. */
export function nameTerms(name: string): string[] {
  const full = name.trim();
  if (!full) return [];
  const words = full.split(/\s+/);
  const parts = words.filter((t) => t.length >= 4 && !COMMON_NAME_WORDS.has(t.toLowerCase()) && !TECH_WORDS.has(t.toLowerCase()));
  // A one-word name is only a term when it passes the same filter as a part.
  if (!/\s/.test(full)) return parts;
  // A name made only of tool words ("Claude Code") would redact ordinary text.
  if (words.every((w) => TECH_WORDS.has(w.toLowerCase()))) return parts;
  return [full, ...parts];
}

export function identityTerms(cwd: string | undefined): IdentityTerms | undefined {
  const key = cwd ?? '';
  if (cache.has(key)) return cache.get(key);
  let terms: IdentityTerms | undefined;
  try {
    let user: string | undefined;
    try {
      user = os.userInfo().username;
    } catch {
      user = undefined;
    }
    let git: { names: string[]; emails: string[] } = { names: [], emails: [] };
    try {
      git = gitIdentities(cwd);
    } catch {
      git = { names: [], emails: [] };
    }
    const remote = gitRemote(cwd);
    // The OS login is the gitUser source, as before (home paths, prompts).
    terms = identityTermsFrom({
      ...(user ? { gitUser: user } : {}),
      ...(git.emails[0] ? { gitEmail: git.emails[0] } : {}),
      hostname: os.hostname(),
      ...(cwd ? { dirname: path.basename(cwd) } : {}),
      ...(remote ? { remote } : {}),
    });
    // Git names: full names and their uncommon parts; other emails' local parts too.
    const extra = [
      ...git.names.flatMap(nameTerms),
      ...git.emails.slice(1).flatMap((e) => identityTermsFrom({ gitEmail: e }).user),
    ];
    const seen = new Set(terms.user.map((t) => t.toLowerCase()));
    const add = extra.filter((t) => {
      const k = t.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const emails = git.emails.slice(1).filter((e) => !terms!.email.some((x) => x.toLowerCase() === e.toLowerCase()));
    terms = { ...terms, user: [...terms.user, ...add], email: [...terms.email, ...emails] };
  } catch {
    terms = undefined;
  }
  cache.set(key, terms);
  return terms;
}

/** Redact one text. Fails closed: if the redactor throws, the text is dropped. */
export function redactText(text: string, cwd: string | undefined): RedactResult {
  try {
    const terms = identityTerms(cwd);
    return redact(text, terms ? { identityTerms: terms } : {});
  } catch {
    return { text: '', hitsByRule: {}, dropped: true };
  }
}
