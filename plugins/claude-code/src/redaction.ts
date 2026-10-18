/**
 * Redaction pass 1 (on the machine, before anything is written to the
 * outbox). Identity terms come from local sources only (OS user, hostname,
 * project dirname, `[user]` name/email from `.git/config` or `~/.gitconfig`,
 * the origin remote); no subprocesses.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { identityTermsFrom, redact, type IdentityTerms, type RedactResult } from '@y/redact';

const cache = new Map<string, IdentityTerms | undefined>();

/** Read `[remote "origin"] url` from `<dir>/.git/config` (walking up to 5 levels). */
export function gitRemote(dir: string | undefined): string | undefined {
  let d = dir;
  for (let i = 0; d && i < 6; i++) {
    try {
      const cfg = fs.readFileSync(path.join(d, '.git', 'config'), 'utf8');
      const m = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(cfg);
      return m?.[1];
    } catch {
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  return undefined;
}

/** `[user] name` / `email` from one git config file's text (simple ini scan). */
export function parseGitUser(cfg: string): { name?: string; email?: string } {
  const out: { name?: string; email?: string } = {};
  let inUser = false;
  for (const raw of cfg.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\]$/.exec(line);
    if (sec) {
      inUser = sec[1]!.toLowerCase() === 'user' && !/"/.test(line);
      continue;
    }
    if (!inUser) continue;
    const kv = /^([A-Za-z0-9-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const k = kv[1]!.toLowerCase();
    const v = kv[2]!.replace(/^"(.*)"$/, '$1').trim().slice(0, 200);
    if (!v) continue;
    if (k === 'name') out.name = v;
    else if (k === 'email') out.email = v;
  }
  return out;
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** The git identity: the repo's `.git/config` (walking up) wins over `~/.gitconfig`. No subprocess. */
export function gitIdentity(dir: string | undefined, home: string = os.homedir()): { name?: string; email?: string } {
  const global = parseGitUser(readText(path.join(home, '.gitconfig')) ?? '');
  let local: { name?: string; email?: string } = {};
  let d = dir;
  for (let i = 0; d && i < 6; i++) {
    const cfg = readText(path.join(d, '.git', 'config'));
    if (cfg !== undefined) {
      local = parseGitUser(cfg);
      break;
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return { ...global, ...local };
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
    let git: { name?: string; email?: string } = {};
    try {
      git = gitIdentity(cwd);
    } catch {
      git = {};
    }
    terms = identityTermsFrom({
      ...(git.name ? { gitUser: git.name } : user ? { gitUser: user } : {}),
      ...(git.email ? { gitEmail: git.email } : {}),
      hostname: os.hostname(),
      ...(cwd ? { dirname: path.basename(cwd) } : {}),
      ...(gitRemote(cwd) ? { remote: gitRemote(cwd)! } : {}),
    });
    // The OS login stays a user term too (home paths, prompts).
    if (git.name && user) {
      const extra = identityTermsFrom({ gitUser: user }).user;
      const seen = new Set(terms.user.map((t) => t.toLowerCase()));
      terms = { ...terms, user: [...terms.user, ...extra.filter((t) => !seen.has(t.toLowerCase()))] };
    }
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
