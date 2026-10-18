/**
 * @paceline/pointers: local rendering of push-path pointers (invariant I3).
 *
 * Push paths (SessionStart/UserPromptSubmit additionalContext, PostToolUse
 * context, Stop block reasons, asyncRewake stderr) carry only
 * `{templateId, params}` from the server. This package turns them into text
 * using the fixed {@link TEMPLATES} shipped with the plugin. No server text
 * is ever printed.
 *
 * Template grammar:
 * - `{name}` is replaced by the param `name` (or a local value, see
 *   {@link PointerLocals});
 * - `[ … ]` is an optional segment, dropped when any `{name}` inside it is
 *   absent; segments don't nest;
 * - all other characters are literal. Templates contain no `[`/`]`/`{`/`}`
 *   except as grammar.
 *
 * Dependency-free apart from `@paceline/schema` (bundled into hook scripts).
 *
 * @packageDocumentation
 */
export {
  FALLBACK_POINTER_TEXT,
  PLACEHOLDER_PATTERNS,
  POINTER_PRIORITY,
  TEMPLATES,
  TEMPLATE_LOCALS,
  parseTemplate,
  templateGrammar,
  type TemplateToken,
} from './templates.js';
export {
  isRenderedPointer,
  renderPointer,
  renderPointers,
  type PointerLocals,
  type RenderPointersOptions,
} from './render.js';
