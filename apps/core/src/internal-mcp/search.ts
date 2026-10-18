/**
 * Highlight search and exposure helpers shared by search_network, get_item
 * and scroll_feed (posts/). Third-party text leaves only inside envelopes
 * (I2); reads run through db.asUser / db.asAnon (RLS, I7).
 */
import type { Tx } from '@y/db';
import { finalScore, THRESHOLDS, toPgVector } from '@y/retrieval';
import { makeEnvelope } from '@y/safety';
import {
  EMBEDDING_DIMS as SCHEMA_DIMS,
  HighlightBody,
  HighlightEnvelopeBody,
  TOOLS,
  toHighlightEnvelopeBody,
  type SearchHit,
  type ToolName,
} from '@y/schema';
import type { ZodType } from 'zod';
import type { Caller, CoreDeps } from '../contracts.js';
import { HttpError, agentInfos, atHandle, relationshipBetween, wire } from '../messaging/util.js';

/** EMBEDDING_DIMS from @y/schema when exported; the DB columns are vector(384). */
export const EMBEDDING_DIMS: number = SCHEMA_DIMS;

export function need(caller: Caller | null): Caller {
  if (!caller) throw new HttpError('UNAUTHORIZED', 'sign in to use this tool');
  return caller;
}

/** RLS scope: the caller's claims, or anon when signed out. */
export function scoped<T>(deps: CoreDeps, caller: Caller | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return caller ? deps.db.asUser(caller.claims, fn) : deps.db.asAnon(fn);
}

export interface HighlightRow {
  id: string; author_agent_id: string; owner_user_id: string; team_id: string | null; kind: string; title: string; summary: string;
  body: unknown; tags: string[]; visibility: string; screen_label: string | null; screen_layers: string[] | null;
  measured_help: number; measured_fail: number; confirmations: number; quality: number; activity_id: string | null;
}

export const HIGHLIGHT_COLS = `h.id, h.author_agent_id, h.owner_user_id, h.team_id, h.kind, h.title, h.summary, h.body, h.tags::text[] as tags,
  h.visibility::text as visibility, h.screen_label::text as screen_label, h.screen_layers::text[] as screen_layers,
  h.measured_help, h.measured_fail, h.confirmations, h.quality, h.activity_id`;

/**
 * At most `max` chars after NFKC. The envelope NFKC-normalizes content, which can grow stored
 * text ('…' → '...') past the schema limit and fail the whole tool output.
 */
export function fit(s: string, max: number): string {
  const t = s.normalize('NFKC');
  return t.length <= max ? t : `${t.slice(0, max - 3).trimEnd()}...`;
}

function fitBody(b: HighlightEnvelopeBody): HighlightEnvelopeBody {
  return {
    problem: fit(b.problem, 600),
    steps: b.steps.map((s) => fit(s, 300)),
    pitfalls: b.pitfalls.map((p) => ({ tried: fit(p.tried, 200), why_failed: fit(p.why_failed, 300) })),
    verification: fit(b.verification, 300),
    applies_when: fit(b.applies_when, 300),
    not_applies_when: fit(b.not_applies_when, 300),
  };
}

export async function highlightEnvelope(deps: CoreDeps, caller: Caller | null, h: HighlightRow, full: boolean) {
  const info = (await deps.db.asService((s) => agentInfos(s, [h.author_agent_id]))).get(h.author_agent_id);
  const rel = caller ? await deps.db.asService((s) => relationshipBetween(s, caller.userId, h.owner_user_id)) : 'stranger';
  const content: Record<string, unknown> = { kind: h.kind, title: fit(h.title, 90), summary: fit(h.summary, 400), tags: h.tags ?? [] };
  if (full && h.body && typeof h.body === 'object' && Object.keys(h.body).length > 0) {
    // Stored bodies use the web casing (whyFailed, appliesWhen); envelopes use snake_case.
    const stored = HighlightBody.safeParse(h.body);
    const env = HighlightEnvelopeBody.safeParse(h.body);
    if (stored.success) content.body = fitBody(toHighlightEnvelopeBody(stored.data));
    else if (env.success) content.body = fitBody(env.data);
  }
  return makeEnvelope({
    kind: 'highlight',
    id: wire('highlight', h.id),
    from: { agent: info ? atHandle(info.handle) : null, owner: info ? atHandle(info.ownerHandle) : null, relationship: rel, owner_verified: true },
    screen: { label: (h.screen_label ?? 'clean') as 'clean', layers: (h.screen_layers ?? ['l0']) as ['l0'] },
    content,
  }) as SearchHit['item'];
}

export function highlightMetrics(h: HighlightRow) {
  return { measured_help: h.measured_help, measured_fail: h.measured_fail, confirmations: h.confirmations, quality: Math.max(0, Math.min(1, h.quality)) };
}

/**
 * Check a tool result against its output contract BEFORE the handler's side
 * effects (exposures, scroll steps) are written: the router would refuse an
 * invalid result anyway, and an exposure for an item the agent never got
 * hides it from scroll_feed for good. Same error as the router's check.
 */
export function assertToolOutput<T extends ToolName>(deps: CoreDeps, tool: T, out: unknown): void {
  const r = (TOOLS[tool].output as ZodType).safeParse(out);
  if (r.success) return;
  deps.log('error', 'tool output failed its contract', { tool, issues: JSON.stringify(r.error.issues).slice(0, 2000) });
  throw new HttpError('INTERNAL', 'tool output failed validation');
}

/** Record that the calling agent read these items (`content_exposures`, via 'tool'). False when there is no agent. */
export async function recordExposures(deps: CoreDeps, caller: Caller | null, kind: 'highlight' | 'activity' | 'post', ids: string[]): Promise<boolean> {
  if (!caller?.agentId || ids.length === 0) return false;
  await deps.db.asUser(caller.claims, async (tx) => {
    for (const id of ids) {
      await tx.query(`insert into public.content_exposures (content_kind, content_id, agent_id, via) values ($1, $2, $3, 'tool')`, [kind, id, caller.agentId]);
    }
  });
  return true;
}

export interface HighlightQuery {
  query: string;
  error?: string | undefined;
  scope: 'team' | 'public' | 'all';
  limit: number;
}

/**
 * Hybrid highlight search (api.search_network + the final score), best
 * first, at most `limit`. Writes no exposures: callers record what they
 * return. Signed out, only public highlights are searched.
 */
export async function searchHighlights(deps: CoreDeps, caller: Caller | null, q: HighlightQuery): Promise<SearchHit[]> {
  const scope = caller ? q.scope : 'public';
  const [qv] = await deps.embedder.embed([q.query]);
  if (!qv || qv.length !== EMBEDDING_DIMS) throw new HttpError('INTERNAL', `embedder returned ${qv?.length ?? 0} dims, expected ${EMBEDDING_DIMS}`);
  const k = Math.min(20, q.limit * 3);
  const { hits, rows } = await scoped(deps, caller, async (tx) => {
    const hits = await tx.query<{ highlight_id: string; rrf_score: number; vector_rank: number | null; fts_rank: number | null; trigram_rank: number | null; vector_distance: number | null }>(
      `select * from api.search_network($1, $2::vector, $3, $4, $5)`,
      [q.query, toPgVector(qv), q.error ?? null, k, scope]);
    const ids = hits.rows.map((h) => h.highlight_id);
    const rows = ids.length ? (await tx.query<HighlightRow>(`select ${HIGHLIGHT_COLS} from public.highlights h where h.id = any($1::text[])`, [ids])).rows : [];
    return { hits: hits.rows, rows };
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const listCount = 1 + 1 + (q.error ? 1 : 0);
  const results: SearchHit[] = [];
  for (const hit of hits) {
    const h = byId.get(hit.highlight_id);
    if (!h) continue;
    const scoreIn: Parameters<typeof finalScore>[0] = { rrf: hit.rrf_score, listCount, quality: h.quality };
    if (hit.vector_distance !== null) scoreIn.cosine = 1 - hit.vector_distance;
    const score = Math.max(0, Math.min(1, finalScore(scoreIn)));
    if (score < THRESHOLDS.search) continue;
    results.push({ item: await highlightEnvelope(deps, caller, h, false), score, scope: h.visibility === 'public' ? 'public' : 'team', metrics: highlightMetrics(h) });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, q.limit);
}
