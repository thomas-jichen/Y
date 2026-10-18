/**
 * Structured-output contracts for the LLM calls Paceline makes (all with
 * `output_config.format = { type: 'json_schema', schema }`, never forced
 * `tool_choice`, never sampling params):
 * - Stage A distill card (Haiku 5.5): {@link activityCardJsonSchema}
 * - Stage B highlights (Sonnet 5.5): {@link highlightsJsonSchema}
 * - L2 safety judge (Haiku 5.5, effort low): {@link judgeVerdictJsonSchema}
 * - quarantined reader (Haiku 5.5, no tools, no viewer data):
 *   {@link readerTagsJsonSchema}, mapping author text to enums only.
 *
 * The JSON schemas are generated from the zod schemas with `z.toJSONSchema`
 * and then reduced to the subset structured outputs accept (see
 * {@link toStructuredOutputSchema}). Always validate the model's JSON with the
 * zod schema afterwards: that is where length, count and pattern limits are
 * enforced.
 *
 * @module llm
 */
import { z } from 'zod';
import { TaskIntent } from './common.js';
import { ActivityCard, HighlightDrafts } from './activity.js';
import { JudgeVerdict } from './safety.js';

/**
 * The fixed 60-tag capability vocabulary. Shared components and suggestions
 * carry only these tags (never author free text) when shown to agents.
 */
export const CAPABILITY_TAGS = [
  // testing
  'test_debugging',
  'test_generation',
  'snapshot_testing',
  'e2e_testing',
  'flaky_test_triage',
  'coverage',
  // build and tooling
  'build_config',
  'bundler_config',
  'monorepo_tooling',
  'package_management',
  'dependency_upgrade',
  'typescript_types',
  'linting_formatting',
  'code_generation',
  // debugging
  'runtime_debugging',
  'error_triage',
  'log_analysis',
  'performance_profiling',
  'memory_leak_debugging',
  // git and CI
  'git_workflow',
  'pr_authoring',
  'code_review',
  'ci_config',
  'release_management',
  'changelog',
  // infrastructure
  'docker',
  'kubernetes',
  'terraform',
  'cloud_deploy',
  'serverless',
  'observability',
  'secrets_management',
  // data
  'sql_queries',
  'schema_migrations',
  'orm_usage',
  'data_pipelines',
  'caching',
  // APIs and integrations
  'rest_api',
  'graphql',
  'auth_integration',
  'payments_integration',
  'webhooks',
  'sdk_usage',
  'mcp_servers',
  // frontend
  'react_components',
  'css_styling',
  'accessibility',
  'state_management',
  'ui_testing',
  // docs
  'documentation',
  'api_docs',
  'architecture_notes',
  // agent workflow
  'planning',
  'task_decomposition',
  'context_management',
  'subagent_orchestration',
  'prompt_writing',
  'refactoring',
  'security_review',
  'codebase_navigation',
] as const;
export const CapabilityTag = z.enum(CAPABILITY_TAGS);
export type CapabilityTag = z.infer<typeof CapabilityTag>;

/**
 * Quarantined reader output: enums only. The reader sees the author's text
 * and may emit nothing but these tags and intents.
 */
export const ReaderTags = z.object({
  capabilityTags: z.array(CapabilityTag).max(8),
  appliesToIntents: z.array(TaskIntent).max(6),
});
export type ReaderTags = z.infer<typeof ReaderTags>;

/** A JSON Schema object (as produced by `z.toJSONSchema`). */
export type JsonSchema = { [key: string]: unknown };

const ALLOWED_FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

/** Keywords removed because structured outputs don't support them (zod still enforces them). */
const STRIPPED_KEYWORDS = new Set([
  '$schema',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'default',
  'propertyNames',
  'minProperties',
  'maxProperties',
]);

function reduce(node: unknown, path: string): unknown {
  if (Array.isArray(node)) return node.map((n, i) => reduce(n, `${path}[${i}]`));
  if (node === null || typeof node !== 'object') return node;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (STRIPPED_KEYWORDS.has(key)) continue;
    if (key === 'format') {
      if (typeof value === 'string' && ALLOWED_FORMATS.has(value)) out.format = value;
      continue;
    }
    if (key === 'oneOf') {
      out.anyOf = reduce(value, `${path}.anyOf`);
      continue;
    }
    if (key === 'properties' && value && typeof value === 'object') {
      const props: Record<string, unknown> = {};
      for (const [prop, sub] of Object.entries(value as Record<string, unknown>)) {
        props[prop] = reduce(sub, `${path}.properties.${prop}`);
      }
      out.properties = props;
      continue;
    }
    out[key] = reduce(value, `${path}.${key}`);
  }
  if (out.type === 'object') {
    if (src.additionalProperties !== undefined && src.additionalProperties !== false) {
      throw new TypeError(`toStructuredOutputSchema: open object (record) at ${path}; use an array instead`);
    }
    out.additionalProperties = false;
    const props = Object.keys((out.properties as Record<string, unknown> | undefined) ?? {});
    const required = new Set((out.required as string[] | undefined) ?? []);
    const missing = props.filter((p) => !required.has(p));
    if (missing.length > 0) {
      throw new TypeError(
        `toStructuredOutputSchema: optional properties at ${path} (${missing.join(', ')}); make them required and nullable`,
      );
    }
  }
  return out;
}

/**
 * Convert a zod schema into a JSON Schema accepted by structured outputs:
 * strips unsupported keywords (string/number/array constraints, `pattern`,
 * `default`, unknown `format`s, `$schema`), rewrites `oneOf` to `anyOf`, and
 * sets `additionalProperties: false` on every object.
 *
 * @throws TypeError if the schema has optional properties or open records,
 *   which structured outputs can't express. Design LLM schemas with every
 *   property required (use `.nullable()` for absent values).
 */
export function toStructuredOutputSchema(schema: z.ZodType): JsonSchema {
  const raw = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output', unrepresentable: 'throw' });
  return reduce(raw, '$') as JsonSchema;
}

/** Stage A card JSON schema. */
export const activityCardJsonSchema: JsonSchema = toStructuredOutputSchema(ActivityCard);
/** Stage B highlights JSON schema (`{ highlights: [...] }`, at most 3). */
export const highlightsJsonSchema: JsonSchema = toStructuredOutputSchema(HighlightDrafts);
/** L2 judge verdict JSON schema. */
export const judgeVerdictJsonSchema: JsonSchema = toStructuredOutputSchema(JudgeVerdict);
/** Quarantined reader JSON schema. */
export const readerTagsJsonSchema: JsonSchema = toStructuredOutputSchema(ReaderTags);

/** Model ids used by the worker (CLAUDE.md pins). */
export const LLM_MODELS = {
  distillStageA: 'claude-haiku-5-5',
  distillStageB: 'claude-sonnet-5-5',
  judge: 'claude-haiku-5-5',
  reader: 'claude-haiku-5-5',
} as const;

/** Structured-output response format block for `output_config.format`. */
export function jsonSchemaFormat(schema: JsonSchema): { type: 'json_schema'; schema: JsonSchema } {
  return { type: 'json_schema', schema };
}
