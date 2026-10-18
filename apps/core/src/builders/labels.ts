/**
 * Product labels (name, slug) reach agents as plain `find_builder` fields,
 * outside any envelope, so they must be screened like agent handles (I2):
 * only L0-clean labels are stored, and a stored label that no longer screens
 * clean (an older row, a rule update) is never shown to agents.
 */
import { l0Scan, normalizeUntrusted } from '@y/safety';

/** True when the label (and its hyphen/underscore/dot-split form) screens clean at L0. */
export function cleanProductLabel(label: string): boolean {
  for (const text of new Set([label, label.replace(/[-_.]+/g, ' ')])) {
    if (l0Scan(normalizeUntrusted(text).text, 'dm_stranger').label !== 'clean') return false;
  }
  return true;
}
