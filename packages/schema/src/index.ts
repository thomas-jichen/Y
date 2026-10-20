/**
 * @y/schema: the zod v4 contracts every part of Y shares.
 * The single source of truth for wire shapes (JSON, camelCase).
 *
 * Every module is also importable on its own as `@y/schema/<module>`
 * (e.g. `@y/schema/canonical`, which has no dependencies).
 * See docs/CONTRACTS.md for the index of contracts and who produces/consumes each.
 *
 * @packageDocumentation
 */
export * from './canonical.js';
export * from './common.js';
export * from './errors.js';
export * from './stats.js';
export * from './safety.js';
export * from './setup.js';
export * from './pointers.js';
export * from './activity.js';
export * from './messaging.js';
export * from './envelope.js';
export * from './llm.js';
export * from './posts.js';
export * from './scroll.js';
export * from './segments.js';
export * from './review.js';
export * from './brief.js';
export * from './pulse.js';
export * from './ingest.js';
export * from './hook.js';
export * from './mcp.js';
export * from './internal.js';
export * from './builders.js';
export * from './web.js';
export * from './teams.js';
export * from './slack.js';
export * from './events.js';
export * from './hosting.js';
