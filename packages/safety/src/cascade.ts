/**
 * The cascade (normalize → L0 → optional L2 → actions) and envelopes.
 *
 * @module cascade
 */
import {
  LABEL_SEVERITY,
  buildEnvelope,
  newId,
  type ActionDecision,
  type ContentClass,
  type Envelope,
  type EnvelopeParts,
  type JudgeVerdict,
  type L0Finding,
  type L0Result,
  type Label,
  type Screen,
  type ScreenAction,
  type ScreenCategory,
  type Verdict,
} from '@y/schema';
import { JudgeError, type Judge } from './judge.js';
import { hiddenFindings, l0Scan, labelFromFindings, requiresL2, type L0Options } from './l0.js';
import { deepNormalize, normalizeDetailed, type NormalizedText } from './normalize.js';

/** An item to screen. */
export interface ScreenItem {
  contentClass: ContentClass;
  /** Prefixed id of the item (stored on the verdict). */
  contentId: string;
  text: string;
  /** Force L2 regardless of class and L0 (e.g. public visibility: stricter screen). */
  forceL2?: boolean;
}

/** Dependencies of {@link screen}. */
export interface ScreenDeps {
  /** L2 judge; absent → L0-only mode (`l2Error: 'skipped_budget'` when L2 was needed). */
  judge?: Judge;
  /**
   * Apply the failed-L2 floor even when no judge is configured (production
   * setting once the judge ships). Default false: with no judge the label is
   * L0's (the v0 slice runs L0 only).
   */
  strictWithoutJudge?: boolean;
  /** L0 options (extra allowlisted hosts). */
  l0?: L0Options;
  /** Clock (ms). Default `Date.now`. */
  now?: () => number;
  /** Id generator for the verdict. Default `newId('verdict')`. */
  newVerdictId?: () => string;
}

/** Output of {@link screen}. */
export interface ScreenOutcome {
  verdict: Verdict;
  decision: ActionDecision;
  /** Chip for readers and envelopes. */
  screen: Screen;
  /** Normalized text (what should be stored and displayed). */
  normalized: NormalizedText;
}

/** Classes whose failed L2 floors the label at `suspicious`. */
const STRICT_ON_L2_FAILURE = new Set<ContentClass>(['dm_stranger', 'builder_answer', 'shared_component', 'card', 'highlight']);

/**
 * The more severe label; on a tie `sensitive` wins over `suspicious`, so a
 * secret is held for its sender (not quarantined at the recipient) whichever
 * layer found it.
 */
const moreSevere = (a: Label, b: Label): Label =>
  LABEL_SEVERITY[b] > LABEL_SEVERITY[a] || (LABEL_SEVERITY[b] === LABEL_SEVERITY[a] && b === 'sensitive') ? b : a;

/** L0 over the normalized text plus everything normalization hid from a human reader. */
function l0WithHidden(det: ReturnType<typeof normalizeDetailed>, contentClass: ContentClass, opts?: L0Options): L0Result {
  const base = l0Scan(det.text, contentClass, opts);
  const extra: L0Finding[] = [];
  const nonZwjInvisible = det.removedInvisible - det.removedZwj;
  if (nonZwjInvisible > 0 || det.removedHidden > 0) {
    extra.push({ rule: 'hidden.removed', category: 'invisible_chars', severity: 'warn' });
  }
  if (det.escapedDelimiters > 0 && !base.findings.some((f) => f.rule === 'inj.delimiter_spoof')) {
    extra.push({ rule: 'inj.delimiter_spoof', category: 'injection_phrase', severity: 'block' });
  }
  const hidden = hiddenFindings(det.hidden, opts);
  if (hidden.some((f) => f.severity !== 'info')) {
    extra.push({ rule: 'hidden.instructions', category: 'injection_phrase', severity: 'block' });
    extra.push(...hidden.filter((f) => f.severity !== 'info'));
  }
  if (extra.length === 0) return { ...base, normalizedChanged: det.changed };
  const findings = [...base.findings, ...extra].slice(0, 200);
  const label = labelFromFindings(findings);
  return { label, findings, needsL2: requiresL2(contentClass) || label !== 'clean', normalizedChanged: det.changed };
}

function errorKind(e: unknown): Verdict['l2Error'] {
  if (e instanceof JudgeError) return e.kind;
  if (e instanceof Error && /timeout|timed out/i.test(`${e.name} ${e.message}`)) return 'timeout';
  return 'api_error';
}

function screenChip(label: Label, layers: Screen['layers'], findings: readonly L0Finding[], l2: JudgeVerdict | null): Screen {
  const cats: ScreenCategory[] = [];
  for (const f of findings) if (f.severity !== 'info' && !cats.includes(f.category)) cats.push(f.category);
  if (l2 && l2.category !== 'none' && !cats.includes(l2.category)) cats.push(l2.category);
  const chip: Screen = { label, layers };
  if (cats.length > 0) chip.categories = cats.slice(0, 8);
  return chip;
}

/**
 * Run the cascade:
 * 1. normalize; 2. L0 over the normalized text and over hidden payloads
 *    (HTML comments, images, tag characters, bidi-reversed runs);
 * 3. L2 if `forceL2`, {@link requiresL2}, or L0 label ≠ clean;
 * 4. final label = the more severe of L0 and L2 (`LABEL_SEVERITY`);
 *    if a judge was provided but failed: `l2Error` is set and the label is at
 *    least **`suspicious`** for `dm_stranger`, `builder_answer`,
 *    `shared_component`, `card`, `highlight`, and at least L0's label for
 *    the other classes. With no judge (L0-only mode): `l2Error:
 *    'skipped_budget'`, layers `['l0']`, label from L0 (or the floor above
 *    when `strictWithoutJudge`). Trust never rises (I8);
 * 5. `decision = actionFor(contentClass, label)`.
 * Never throws for judge failures.
 */
export async function screen(item: ScreenItem, deps: ScreenDeps = {}): Promise<ScreenOutcome> {
  const now = deps.now ?? Date.now;
  const started = now();
  const det = normalizeDetailed(item.text);
  const l0 = l0WithHidden(det, item.contentClass, deps.l0);
  const needL2 = item.forceL2 === true || requiresL2(item.contentClass) || l0.label !== 'clean';

  let l2: JudgeVerdict | null = null;
  let l2Error: Verdict['l2Error'] = null;
  let costUsd = 0;
  const layers: Screen['layers'] = ['l0'];
  let label: Label = l0.label;

  if (needL2) {
    if (deps.judge) {
      try {
        const r = await deps.judge.judge({ text: det.text, contentClass: item.contentClass });
        l2 = r.verdict;
        costUsd = Number.isFinite(r.costUsd) && r.costUsd > 0 ? r.costUsd : 0;
        layers.push('l2');
        label = moreSevere(label, l2.label);
      } catch (e) {
        l2Error = errorKind(e);
      }
    } else {
      l2Error = 'skipped_budget';
    }
    const applyFloor = l2Error !== null && (deps.judge !== undefined || deps.strictWithoutJudge === true);
    if (applyFloor && STRICT_ON_L2_FAILURE.has(item.contentClass)) label = moreSevere(label, 'suspicious');
  }

  const decision = actionFor(item.contentClass, label);
  const chip = screenChip(label, layers, l0.findings, l2);
  const verdict: Verdict = {
    id: (deps.newVerdictId ?? (() => newId('verdict')))(),
    contentClass: item.contentClass,
    contentId: item.contentId,
    l0,
    l2,
    l2Error,
    label,
    decision,
    screen: chip,
    latencyMs: Math.max(0, Math.round(now() - started)),
    costUsd,
    createdAt: new Date(now()).toISOString(),
  };
  return {
    verdict,
    decision,
    screen: chip,
    normalized: {
      text: det.text,
      removedInvisible: det.removedInvisible,
      removedHidden: det.removedHidden,
      escapedDelimiters: det.escapedDelimiters,
      changed: det.changed,
    },
  };
}

type Row = readonly [Cell, Cell, Cell, Cell, Cell];
type Cell = ScreenAction | readonly [ScreenAction, ...('flagSender' | 'notifyOwner' | 'takedown')[]];

const LABEL_COLUMN: Readonly<Record<Label, number>> = { clean: 0, warn: 1, suspicious: 2, malicious: 3, sensitive: 4 };

/** PLAN §10 actions table (+ rows for the remaining classes). Columns: clean, warn, suspicious, malicious, sensitive. */
const ACTIONS: Readonly<Record<ContentClass, Row>> = {
  card: ['allow', 'label', 'back_to_author', ['block', 'flagSender'], 'back_to_draft'],
  highlight: ['allow', 'label', 'back_to_author', ['block', 'flagSender'], 'back_to_draft'],
  comment: ['allow', 'label', 'quarantine', 'block', 'hold_for_sender'],
  dm_teammate: ['allow', 'label', 'quarantine', ['block', 'notifyOwner'], 'hold_for_sender'],
  dm_stranger: ['request_flow', 'quarantine', 'quarantine', ['block', 'flagSender'], 'hold_for_sender'],
  shared_component: ['allow', 'label', 'moderator', ['block', 'takedown'], 'block'],
  builder_answer: ['allow', 'label', 'quarantine', ['block', 'flagSender'], 'hold_for_sender'],
  owner_instruction: ['allow', 'label', 'hold_for_sender', 'block', 'hold_for_sender'],
  stats: ['allow', 'allow', 'back_to_draft', 'block', 'back_to_draft'],
  setup_review: ['allow', 'label', 'quarantine', ['block', 'flagSender'], 'hold_for_sender'],
};

/**
 * The actions table (PLAN §10), plus rows for the remaining classes:
 *
 * | class | clean | warn | suspicious | malicious | sensitive |
 * |---|---|---|---|---|---|
 * | card, highlight | allow | label (noPush) | back_to_author | block + flagSender | back_to_draft |
 * | comment | allow | label | quarantine | block | hold_for_sender |
 * | dm_teammate | allow | label | quarantine | block + notifyOwner | hold_for_sender |
 * | dm_stranger | request_flow | quarantine | quarantine | block + flagSender | hold_for_sender |
 * | shared_component | allow (if static pass) | label | moderator | block + takedown | block |
 * | builder_answer | allow | label | quarantine | block + flagSender | hold_for_sender |
 * | owner_instruction | allow | label | hold_for_sender | block | hold_for_sender |
 * | stats | allow | allow | back_to_draft | block | back_to_draft |
 * | setup_review | allow | label | quarantine | block + flagSender | hold_for_sender |
 *
 * `noPush` is true for every `label` action and every non-`allow` action.
 * Unknown classes or labels fail closed (`block`, `noPush`).
 */
export function actionFor(contentClass: ContentClass, label: Label): ActionDecision {
  const row = ACTIONS[contentClass];
  const col = LABEL_COLUMN[label];
  const cell: Cell = row && col !== undefined ? row[col as 0 | 1 | 2 | 3 | 4] : 'block';
  const [action, ...flags] = typeof cell === 'string' ? [cell] : cell;
  return {
    action,
    flagSender: flags.includes('flagSender'),
    notifyOwner: flags.includes('notifyOwner'),
    takedown: flags.includes('takedown'),
    noPush: action !== 'allow',
  };
}

/**
 * Build an envelope for third-party content: deep-normalizes every string in
 * `parts.content` with `normalizeUntrusted`, then calls the schema's
 * `buildEnvelope` (which encodes `untrustedContent` and picks the fixed note).
 * The only sanctioned way to put third-party content into a tool result (I2).
 */
export function makeEnvelope<T>(parts: EnvelopeParts<T>): Envelope<T> {
  return buildEnvelope({ ...parts, content: deepNormalize(parts.content) });
}
