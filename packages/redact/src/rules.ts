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

/**
 * Matches commands whose output is redacted wholesale: bare `env` / `set`
 * (no command after them), `printenv`, `export -p`, `cat|less|more|head|tail|bat`
 * of a `.env*` file, `docker inspect`, `kubectl get secret(s)`. `env FOO=1 cmd`
 * and `set -e` do not match.
 */
export const ENV_DUMP_COMMAND_RE =
  /(?:^|[;&|(]\s*)(?:(?:env|set)(?=\s*(?:$|[|;&>)]))|printenv\b|export\s+-p\b|(?:cat|less|more|head|tail|bat)\s+(?:\S+\s+)*\S*\.env\S*|docker\s+inspect\b|kubectl\s+get\s+secrets?\b)/;

/** A secret found by {@link scanSecrets} (never includes the matched text). */
export interface SecretHit {
  ruleId: string;
  start: number;
  end: number;
}

/** Matches any redaction or identity marker this package emits. */
export const MARKER_RE = /<(?:REDACTED:[a-z0-9_]{1,40}|USER|EMAIL|HOST|ORG|PROJECT|TERM|IP)>/;
