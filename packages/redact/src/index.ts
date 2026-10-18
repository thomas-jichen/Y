/**
 * @y/redact: two-pass redaction (PLAN §7 "Two-pass redaction").
 *
 * - **Pass 1, client** (plugin hooks): {@link redact} over every digest delta,
 *   error excerpt and setup description before anything enters the outbox.
 * - **Pass 2, server** (core worker): the same {@link redact} over the
 *   uploaded digest and {@link scanSecrets} over every LLM output field; a
 *   residual hit sends the item back to draft.
 *
 * Pure, synchronous, dependency-free (it is bundled into the hook scripts).
 * Fails closed: more than {@link FAIL_CLOSED_THRESHOLD} secret hits in one
 * text drops the text entirely (stats only).
 *
 * Markers: secrets become `<REDACTED:<ruleId>>`; identity terms become
 * `<USER>`, `<EMAIL>`, `<HOST>`, `<ORG>`, `<PROJECT>`, `<TERM>` or `<IP>`;
 * home directories become `~`.
 *
 * @packageDocumentation
 */
export * from './rules.js';
export {
  hasResidualMarkers,
  identityTermsFrom,
  looksLikeSecret,
  redact,
  redactCommandOutput,
  scanSecrets,
  shannonEntropy,
} from './redact.js';
