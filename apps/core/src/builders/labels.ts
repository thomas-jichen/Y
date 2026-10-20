/**
 * Product labels (name, slug) reach agents as plain `find_builder` fields,
 * outside any envelope, so they are screened like agent handles (I2): only
 * labels that pass {@link cleanProductLabel} are stored, and a stored label
 * that no longer passes (an older row, a rule update) is never shown to
 * agents by find_builder (the team's products page flags it).
 *
 * This screen is the only guard on these two fields: BuilderInfo carries no
 * envelope or untrusted-data note for them (that would be a wire change in
 * `packages/schema/src/mcp.ts`). It has two layers:
 * - L0 (`@y/safety`): any block finding refuses the label. Warn findings
 *   refuse it too, except the few that fire on single words common in real
 *   package names (`sudo-prompt`, "Jailbreak Detector", "System Prompt Kit").
 * - A label-shape check: product names are short noun phrases, so a label
 *   that reads as an instruction to the reading agent (an override word with
 *   rules or an action, a modal verb with the reader or an action, or, in a
 *   label of four or more words, two shell or run verbs or an urging word with
 *   the reader or an action) is refused. Short names built from those words
 *   ("npx-run", "Always-On Agent", "Forget-Me-Not AI") pass. Digits used as
 *   letters (`ign0re pri0r`) are folded first.
 */
import { l0Scan, normalizeUntrusted } from '@y/safety';
import { GithubRepoName } from '@y/schema';

/** L0 warn rules that fire on single words found in real package names. */
const WORD_WARN_RULES = new Set(['cmd.sudo', 'inj.jailbreak_mention', 'inj.system_prompt_mention']);

const LEET: Readonly<Record<string, string>> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };

const OVERRIDE = new Set(['ignore', 'ignoring', 'disregard', 'forget', 'override', 'bypass']);
const RULES = new Set(['rule', 'rules', 'instruction', 'instructions', 'guidance', 'guidelines', 'prompt', 'prompts', 'directives', 'guardrails', 'policy', 'policies']);
const ACTION = new Set(['run', 'execute', 'exec', 'curl', 'wget', 'npx', 'pnpx', 'bunx', 'eval', 'install']);
const READER = new Set(['you', 'your', 'yourself', 'assistant', 'assistants', 'agent', 'agents', 'ai', 'llm', 'claude', 'codex', 'gpt', 'chatgpt', 'model']);
/** Modal verbs: with the reader or an action, an instruction even in a short label ("Assistant should curl ..."). */
const MUST = new Set(['must', 'should', 'shall']);
/** Words common in real product names ("Always-On Agent", "LLM Required", "Please AI"): only in a sentence-length label. */
const URGE = new Set(['please', 'always', 'immediately', 'required', 'mandatory']);
/** Words a label needs before two actions or an urging word read as a sentence ("npx-run" and "Exec Install" are names). */
const SENTENCE_WORDS = 4;

type Normalize = (text: string) => string;
const untrusted: Normalize = (text) => normalizeUntrusted(text).text;
/** Plain ASCII (`[a-z0-9-]`, e.g. a handle): Unicode normalization is a no-op, so it is skipped. */
const ascii: Normalize = (text) => text;

function l0Passes(text: string, norm: Normalize = untrusted): boolean {
  const r = l0Scan(norm(text), 'dm_stranger');
  if (r.label === 'clean') return true;
  if (r.label !== 'warn') return false;
  return r.findings.every((f) => f.severity === 'info' || (f.severity === 'warn' && WORD_WARN_RULES.has(f.rule)));
}

/**
 * True when the words of the label read as an instruction to the reading agent. `strict` (agent
 * handles, which go out in push pointers, I3) keeps the original rules: any urging word, or an
 * override word, next to the reader, and any two actions. Product labels use the narrower rules
 * below so ordinary product names pass.
 */
export function instructionShaped(label: string, norm: Normalize = untrusted, strict = false): boolean {
  const words = norm(label).toLowerCase().replace(/[0-9@$]/g, (c) => LEET[c] ?? c).split(/[^a-z]+/).filter(Boolean);
  const has = (set: Set<string>) => words.some((w) => set.has(w));
  const actions = words.filter((w) => ACTION.has(w)).length;
  const sentence = strict || words.length >= SENTENCE_WORDS;
  // An override word with rules or an action ("ignore prior rules", "bypass ... run setup"). An override word
  // next to the reader alone is a common product name ("Forget-Me-Not AI", "bypass-proxy-agent").
  if (has(OVERRIDE) && (has(RULES) || actions > 0 || (strict && has(READER)))) return true;
  if (actions >= 2 && sentence) return true;
  if (has(MUST) && (has(READER) || actions > 0)) return true;
  if (has(URGE) && (has(READER) || actions > 0) && sentence) return true;
  return false;
}

/** True when the label (as written, with `-_.` as spaces, and with digits read as letters) passes the label screen. */
export function cleanProductLabel(label: string): boolean {
  return labelPasses(label, untrusted);
}

/**
 * The same screen for a label made only of `[a-z0-9-]` (a handle derived from a GitHub login):
 * Unicode normalization cannot change such text, so it is not applied (anything else is
 * normalized). Handles keep the strict label-shape rules (see {@link instructionShaped}).
 */
export function cleanAsciiLabel(label: string): boolean {
  return labelPasses(label, /^[a-z0-9-]*$/.test(label) ? ascii : untrusted, true);
}

function labelPasses(label: string, norm: Normalize, strict = false): boolean {
  const spaced = label.replace(/[-_.]+/g, ' ');
  const folded = spaced.replace(/[0-9@$]/g, (c) => LEET[c] ?? c);
  for (const text of new Set([label, spaced, folded])) {
    if (!l0Passes(text, norm)) return false;
  }
  return !instructionShaped(label, norm, strict);
}

/**
 * A team's linked repo name as the status tool may show it, outside any envelope (I2): GitHub
 * naming rules plus the handle label screen above (with `/`, `-`, `_` and `.` read as spaces).
 * Null when it does not pass.
 */
export function repoLabel(repo: string): string | null {
  return GithubRepoName.safeParse(repo).success && cleanAsciiLabel(repo.toLowerCase().replace('/', '-')) ? repo : null;
}
