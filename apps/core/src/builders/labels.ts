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
 *   rules/an action/the reader, two shell or run verbs, or the reader or an
 *   action together with an obligation word) is refused. Digits used as
 *   letters (`ign0re pri0r`) are folded first.
 */
import { l0Scan, normalizeUntrusted } from '@y/safety';

/** L0 warn rules that fire on single words found in real package names. */
const WORD_WARN_RULES = new Set(['cmd.sudo', 'inj.jailbreak_mention', 'inj.system_prompt_mention']);

const LEET: Readonly<Record<string, string>> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };

const OVERRIDE = new Set(['ignore', 'ignoring', 'disregard', 'forget', 'override', 'bypass']);
const RULES = new Set(['rule', 'rules', 'instruction', 'instructions', 'guidance', 'guidelines', 'prompt', 'prompts', 'directives', 'guardrails', 'policy', 'policies']);
const ACTION = new Set(['run', 'execute', 'exec', 'curl', 'wget', 'npx', 'pnpx', 'bunx', 'eval', 'install']);
const READER = new Set(['you', 'your', 'yourself', 'assistant', 'assistants', 'agent', 'agents', 'ai', 'llm', 'claude', 'codex', 'gpt', 'chatgpt', 'model']);
const MUST = new Set(['must', 'should', 'shall', 'please', 'always', 'immediately', 'required', 'mandatory']);

function l0Passes(text: string): boolean {
  const r = l0Scan(normalizeUntrusted(text).text, 'dm_stranger');
  if (r.label === 'clean') return true;
  if (r.label !== 'warn') return false;
  return r.findings.every((f) => f.severity === 'info' || (f.severity === 'warn' && WORD_WARN_RULES.has(f.rule)));
}

/** True when the words of the label read as an instruction to the reading agent. */
export function instructionShaped(label: string): boolean {
  const words = normalizeUntrusted(label).text.toLowerCase().replace(/[0-9@$]/g, (c) => LEET[c] ?? c).split(/[^a-z]+/).filter(Boolean);
  const has = (set: Set<string>) => words.some((w) => set.has(w));
  const actions = words.filter((w) => ACTION.has(w)).length;
  if (has(OVERRIDE) && (has(RULES) || actions > 0 || has(READER))) return true;
  if (actions >= 2) return true;
  if (has(MUST) && (has(READER) || actions > 0)) return true;
  return false;
}

/** True when the label (as written, with `-_.` as spaces, and with digits read as letters) passes the label screen. */
export function cleanProductLabel(label: string): boolean {
  const spaced = label.replace(/[-_.]+/g, ' ');
  const folded = spaced.replace(/[0-9@$]/g, (c) => LEET[c] ?? c);
  for (const text of new Set([label, spaced, folded])) {
    if (!l0Passes(text)) return false;
  }
  return !instructionShaped(label);
}
