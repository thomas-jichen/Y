/**
 * The exact text that gets embedded (PLAN §4 "What gets embedded") and query
 * normalization for search and push matching.
 */
import type { Highlight, SetupComponentKind, StackTag, TaskIntent } from '@paceline/schema';

/** What can be embedded. DMs, comments, digests and unshared setups never are. */
export type Embeddable =
  | {
      kind: 'highlight';
      highlight: Pick<Highlight, 'title' | 'summary' | 'tags'> & { body: Pick<Highlight['body'], 'problem'> };
      searchQueries?: readonly string[];
    }
  | {
      kind: 'activity';
      title: string;
      summary?: string;
      taskIntent: TaskIntent;
      stackTags: readonly StackTag[];
    }
  | {
      kind: 'component';
      componentKind: Extract<SetupComponentKind, 'skill' | 'claude_md_block'>;
      name: string;
      capabilityTags: readonly string[];
      content: string;
    };

/** Cap on embedded text. */
export const EMBED_TEXT_MAX = 8000;
/** Cap on component content inside the embedded text. */
export const COMPONENT_CONTENT_MAX = 6000;

/**
 * The exact text embedded for an item (newline-joined, in this order):
 * - highlight: title, summary, `problem`, `tags` joined by spaces,
 *   `searchQueries` one per line;
 * - activity: title, summary (if any), task intent with `_` → space, stack tags;
 *   **never the digest**;
 * - component: name, capability tags, then the first 6,000 chars of content.
 * Each part is trimmed; empty parts are skipped; the result is capped at
 * 8,000 chars.
 */
export function embeddingTextFor(item: Embeddable): string {
  let parts: (string | undefined)[];
  switch (item.kind) {
    case 'highlight':
      parts = [
        item.highlight.title,
        item.highlight.summary,
        item.highlight.body.problem,
        item.highlight.tags.join(' '),
        ...(item.searchQueries ?? []),
      ];
      break;
    case 'activity':
      parts = [item.title, item.summary, item.taskIntent.replace(/_/g, ' '), item.stackTags.join(' ')];
      break;
    case 'component':
      parts = [item.name, item.capabilityTags.join(' '), item.content.slice(0, COMPONENT_CONTENT_MAX)];
      break;
  }
  return parts
    .map((p) => (p ?? '').trim())
    .filter((p) => p.length > 0)
    .join('\n')
    .slice(0, EMBED_TEXT_MAX);
}

/** Default cap for {@link normalizeQuery} (the `search_network` query max). */
export const QUERY_MAX = 500;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
// Zero-width, soft hyphen, bidi controls and BOM.
const INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Normalize a search query or an error line so the same error matches across
 * machines (pure, deterministic):
 * 1. NFKC; strip ANSI escapes, invisible/bidi characters; controls → space;
 * 2. home directories (`/Users/<u>/`, `/home/<u>/`, `C:\Users\<u>\`) → `~/`;
 * 3. `file.ts:12:5` / `file.py:12` → `file.ts` (line/column dropped);
 * 4. UUIDs → `<uuid>`, ISO timestamps → `<ts>`, `0x…` addresses (≥ 6 hex) →
 *    `0x<addr>`, digit runs of ≥ 5 → `<n>`;
 * 5. collapse whitespace, trim, cap at `maxChars` (default 500) on a code-point boundary.
 * Case is preserved (FTS and trigram matching are case-insensitive already).
 */
export function normalizeQuery(query: string, opts?: { maxChars?: number }): string {
  const max = opts?.maxChars ?? QUERY_MAX;
  const s = query
    .normalize('NFKC')
    .replace(ANSI, ' ')
    .replace(INVISIBLE, '')
    .replace(CONTROL, ' ')
    .replace(/(?:\/Users|\/home)\/[^/\s]+\//g, '~/')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+\\/g, '~/')
    .replace(/(\.[A-Za-z][A-Za-z0-9]{0,5}):\d+(?::\d+)?\b/g, '$1')
    .replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '<uuid>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
    .replace(/\b0x[0-9a-fA-F]{6,}\b/g, '0x<addr>')
    .replace(/\d{5,}/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  const cps = Array.from(s);
  return cps.length > max ? cps.slice(0, max).join('').trimEnd() : s;
}
