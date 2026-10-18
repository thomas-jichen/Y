/**
 * Redaction pass 1 (on the machine, before anything is written to the
 * outbox). Identity terms come from local sources only (OS user, hostname,
 * project dirname, `.git/config` user/remote); no subprocesses.
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
    terms = identityTermsFrom({
      ...(user ? { gitUser: user } : {}),
      hostname: os.hostname(),
      ...(cwd ? { dirname: path.basename(cwd) } : {}),
      ...(gitRemote(cwd) ? { remote: gitRemote(cwd)! } : {}),
    });
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
