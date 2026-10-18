/**
 * Rule table, markers and option types for @y/redact.
 * @module rules
 */
/** Rule families. Only `secret`, `entropy`, `env_dump` and `url_credential` count toward fail-closed. */
export type RuleKind = 'secret' | 'entropy' | 'env_dump' | 'url_credential' | 'identity';

/** Static description of one rule. Rule ids appear in receipts (`hitsByRule`). */
export interface RuleInfo {
  /** Stable id, `^[a-z0-9_]{1,40}$`. */
  id: string;
  kind: RuleKind;
  /** What it matches (shown on the receipt tooltip). */
  description: string;
  /** Replacement marker. */
  marker: string;
}

const secret = (id: string, description: string): RuleInfo => ({
  id,
  kind: 'secret',
  description,
  marker: `<REDACTED:${id}>`,
});

/**
 * Every rule, in application order. Implementations must provide a matcher
 * for each id (gitleaks-style patterns plus the secretlint preset's coverage)
 * and must not emit ids outside this list.
 */
export const RULES: readonly RuleInfo[] = [
  { id: 'env_dump', kind: 'env_dump', description: 'Output of env/printenv/set/cat .env* (redacted wholesale)', marker: '<REDACTED:env_dump>' },
  { id: 'pem_private_key', kind: 'secret', description: 'PEM private key blocks', marker: '<REDACTED:pem_private_key>' },
  secret('aws_access_key', 'AWS access key ids (AKIA/ASIA…)'),
  secret('aws_secret_key', 'AWS secret access keys next to an aws_secret_access_key label'),
  secret('github_pat', 'GitHub fine-grained tokens (github_pat_…)'),
  secret('github_token', 'GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)'),
  secret('anthropic_key', 'Anthropic API keys (sk-ant-…)'),
  secret('openai_key', 'OpenAI-style keys (sk-…, sk-proj-…)'),
  secret('stripe_key', 'Stripe keys (sk_live_, rk_live_, sk_test_, pk_live_)'),
  secret('stripe_webhook', 'Stripe webhook secrets (whsec_…)'),
  secret('slack_token', 'Slack tokens (xoxb-, xoxp-, xoxa-, xoxr-, xoxs-)'),
  secret('slack_webhook', 'Slack incoming webhook URLs'),
  secret('google_api_key', 'Google API keys (AIza…)'),
  secret('jwt', 'JSON Web Tokens (three base64url segments starting eyJ)'),
  secret('y_token', 'Y install tokens (pcl_agt_…)'),
  secret('npm_token', 'npm tokens (npm_…)'),
  secret('bearer_token', 'Authorization: Bearer <token> values'),
  secret('generic_assignment', 'password/secret/token/api_key = "<value>" assignments'),
  { id: 'url_credentials', kind: 'url_credential', description: 'Credentials in URLs (scheme://user:pass@host)', marker: '<REDACTED:url_credentials>' },
  { id: 'entropy', kind: 'entropy', description: 'High-entropy tokens not caught by a specific rule', marker: '<REDACTED:entropy>' },
  { id: 'identity_email', kind: 'identity', description: 'Email addresses', marker: '<EMAIL>' },
  { id: 'identity_user', kind: 'identity', description: 'Git user name and login', marker: '<USER>' },
  { id: 'identity_host', kind: 'identity', description: 'Machine hostname', marker: '<HOST>' },
  { id: 'identity_org', kind: 'identity', description: 'Repository owner / org / package scope', marker: '<ORG>' },
  { id: 'identity_project', kind: 'identity', description: 'Repository, package or directory name', marker: '<PROJECT>' },
  { id: 'identity_term', kind: 'identity', description: 'User-configured denylist terms', marker: '<TERM>' },
  { id: 'identity_ip', kind: 'identity', description: 'IPv4 addresses', marker: '<IP>' },
];

/** More than this many non-identity hits drops the text (fail closed). */
export const FAIL_CLOSED_THRESHOLD = 5;

/** Identity terms by category (all matched case-insensitively on word boundaries). */
export interface IdentityTerms {
  user: string[];
  email: string[];
  host: string[];
  org: string[];
  project: string[];
  denylist: string[];
}

/** Inputs for {@link identityTermsFrom}. All optional; missing values are skipped. */
export interface IdentitySources {
  /** `git config user.name` ("Vivan Poddar"). */
  gitUser?: string;
  /** `git config user.email`. */
  gitEmail?: string;
  /** `os.hostname()`. */
  hostname?: string;
  /** A git remote URL (owner/org and repo are extracted). */
  remote?: string;
  /** `package.json` name (`@acme/payments` → org `acme`, project `payments`). */
  packageName?: string;
  /** Basename of the project directory. */
  dirname?: string;
  /** Extra terms from the user's or team's policy. */
  denylist?: string[];
}

/** Options for {@link redact}. */
export interface RedactOptions {
  identityTerms?: IdentityTerms;
  /** Entropy detector tuning (defaults: minLength 24, minBitsPerChar 4.0). */
  entropy?: { minLength?: number; minBitsPerChar?: number };
  /** Override {@link FAIL_CLOSED_THRESHOLD} (tests only). */
  failClosedThreshold?: number;
}

/** Result of {@link redact}. */
export interface RedactResult {
  /** Redacted text, or `''` when `dropped`. */
  text: string;
  /** Hits per rule id (rules with zero hits omitted). Identity hits included. */
  hitsByRule: Record<string, number>;
  /** True when non-identity hits exceeded the threshold and the text was dropped. */
  dropped: boolean;
}

/** Optional prefix commands before a dump (`sudo -E env`, `command printenv`). */
const ENV_PREFIX = String.raw`(?:(?:sudo|command|exec|builtin|nohup)(?:\s+-[^\s;&|()\n⏎]+)*\s+)*`;
/** Command start: input start, a shell separator, a newline or ` ⏎ ` (digest form). */
const ENV_CMD_START = String.raw`(?:^|[;&|(\n⏎])\s*`;
/** An optional directory before the command name (`/usr/bin/env`); never crosses a separator or quote. */
const ENV_CMD_DIR = String.raw`(?:[^\s;&|()\n⏎<>'"` + '`' + String.raw`]*\/)?`;
/** Readers whose `.env*` file operand dumps it. */
const ENV_READERS = 'cat|less|more|head|tail|bat|grep|egrep|rg|awk|sed|sort|tac|nl|xxd|od|strings|cut|uniq|base64';
/**
 * Arguments before the `.env*` operand: no separator, parenthesis or newline,
 * and quoted strings only as a whole (`grep 'API_KEY' .env`), so a quoted
 * pattern (`grep -rn ".env" .`) is not a file operand.
 */
const ENV_READER_ARGS = String.raw`(?:[^\n⏎|;&()'"]|'[^'\n⏎|;&()]*'|"[^"\n⏎|;&()]*")*?`;
/** Not a dotenv file: templates and source files named `.env.*` (`.env.example`, `src/.env.ts`). */
const NOT_DOTENV = String.raw`(?!\.(?:example|sample|template|dist|[cm]?[jt]sx?|d\.ts|py|rb|go|rs|java|kt|php)(?![\w-]))`;

/**
 * Matches commands whose output is redacted wholesale: bare `env` / `set`
 * (no command after them), `printenv`, `export -p`, `cat|less|more|head|tail|bat`
 * of a `.env*` file, `docker inspect`, `kubectl get secret(s)`. Also: commands
 * after a newline or ` ⏎ ` (digest form), behind `sudo`/`command`/`exec`/
 * `builtin`/`nohup`, or with a path (`/usr/bin/env`); `env -0`/`--null`/`-u X`;
 * bare `export`, `declare -x|-p`, `typeset -x|-p`; other readers of a `.env*`
 * file operand (`grep . .env`, `sort .env`, `cat<.env`); an interpreter
 * one-liner printing all of `process.env` / `os.environ`. `env FOO=1 cmd`,
 * `set -e`, `export FOO=1`, `grep -rn process.env src`, `grep -rn ".env" .`
 * and `grep x src/.env.ts` do not match.
 *
 * Every alternative runs in linear time (the `declare|typeset` flag run is
 * one `[A-Za-z]+` after an `[xp]` lookahead, not `[A-Za-z]*[xp][A-Za-z]*`,
 * which tried every split of a long run): the original `cat … .env` rule is
 * anchored at the input start and takes the first `cat ` with an atomic
 * lookahead (same commands as `(?:^|[;&|(]\s*)(?:cat|…)\s+(?:\S+\s+)*\S*\.env`,
 * which rescanned the rest of the input from every `(cat `), and no other
 * scan crosses a separator.
 */
export const ENV_DUMP_COMMAND_RE = new RegExp(
  [
    // The original rule, minus its `cat … .env` branch (below).
    String.raw`(?:^|[;&|(]\s*)(?:(?:env|set)(?=\s*(?:$|[|;&>)]))|printenv\b|export\s+-p\b|docker\s+inspect\b|kubectl\s+get\s+secrets?\b)`,
    // The original `cat … .env` branch: the first `cat|less|… ` at a command start, then `.env` anywhere after it.
    String.raw`^(?=(?<catStart>[\s\S]*?(?:^|[;&|(]\s*)(?:cat|less|more|head|tail|bat)\s))\k<catStart>[\s\S]*\.env`,
    // A bare dump at a command start (also after a newline / ⏎), behind optional prefix commands.
    ENV_CMD_START + ENV_PREFIX + ENV_CMD_DIR +
      String.raw`(?:env(?:\s+(?:-0|--null|-u\s*[^\s;&|()\n⏎]+|--unset=[^\s;&|()\n⏎]+))*|printenv(?:\s+-0)?|set|export|(?:declare|typeset)\s+-(?=[A-Za-z]*[xp])[A-Za-z]+)(?=\s*(?:$|[|;&>)\n⏎]))`,
    ENV_CMD_START + ENV_PREFIX + ENV_CMD_DIR + String.raw`printenv\b`,
    // Any reader of a `.env*` file operand (after whitespace, `<` or `/`; not quoted).
    ENV_CMD_START + ENV_PREFIX + String.raw`(?:${ENV_READERS})\b` + ENV_READER_ARGS + String.raw`[\s<\/]\.env` + NOT_DOTENV + String.raw`[\w.-]*(?=$|[\s|;&)>⏎])`,
    // An interpreter one-liner printing the whole environment.
    String.raw`\b(?:node|deno|bun|python[0-9.]*)\s+(?:-[A-Za-z]+\s+)*-[ecp]\s+['"][^'"\n⏎]*\b(?:console\.(?:log|dir)|print|pprint|JSON\.stringify)\((?:dict\()?(?:process\.env|os\.environ)\)`,
  ].join('|'),
);

/** A secret found by {@link scanSecrets} (never includes the matched text). */
export interface SecretHit {
  ruleId: string;
  start: number;
  end: number;
}

/** Matches any redaction or identity marker this package emits. */
export const MARKER_RE = /<(?:REDACTED:[a-z0-9_]{1,40}|USER|EMAIL|HOST|ORG|PROJECT|TERM|IP)>/;
