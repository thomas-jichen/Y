/** Hook dispatcher: event name → handler. */
import type { HookCtx, HookEvent, HookResult } from '../context.js';
import { postToolUseFailure } from './post-tool-use-failure.js';
import { sessionEnd } from './session-end.js';
import { sessionStart } from './session-start.js';
import { stop } from './stop.js';
import { userPromptSubmit } from './user-prompt-submit.js';

export const HANDLERS: Record<HookEvent, (ctx: HookCtx) => Promise<HookResult>> = {
  SessionStart: sessionStart,
  UserPromptSubmit: userPromptSubmit,
  PostToolUseFailure: postToolUseFailure,
  Stop: stop,
  SessionEnd: sessionEnd,
};

export function isHookEvent(s: string | undefined): s is HookEvent {
  return !!s && Object.prototype.hasOwnProperty.call(HANDLERS, s);
}
