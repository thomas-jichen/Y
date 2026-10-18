/**
 * Agent tools for builders (PLAN §6, §8): find_builder (auth optional;
 * signed out = public data only, via asAnon) and ask_builder (opens or
 * reuses the caller's support thread and routes the question as a customer
 * message). Request-path reads and inserts run through db.asUser (RLS);
 * routing runs as the service role in messaging/route.ts + support.ts.
 */
import type { Queryable, Tx } from '@y/db';
import {
  CROSS_OWNER_BODY_MAX,
  ulid,
  type BuilderInfo,
  type MessageState,
  type Presence,
  type ToolInput,
  type ToolOutput,
} from '@y/schema';
import type { Caller, CoreDeps } from '../contracts.js';
import { routeMessage } from '../messaging/route.js';
import { HttpError, atHandle, bare, requireAgent, toIso, wire } from '../messaging/util.js';
import { scoped } from '../internal-mcp/search.js';
import { cleanProductLabel } from './labels.js';

type MatchedOn = BuilderInfo['matched_on'];
/** Rank → matched_on: 3 is a verified package token in error text, 4 a claim-backed slug in error text. */
const RANK: readonly MatchedOn[] = ['package', 'repo', 'domain', 'error', 'error'];

/** Slugs shorter than this are not matched inside error text (too many false hits). */
const ERROR_SLUG_MIN = 4;

/** Package-like tokens in error text (npm/PyPI names, scoped names and path segments), lowercased. */
export function errorTokens(error: string): string[] {
  const out = new Set<string>();
  for (const raw of error.toLowerCase().match(/@?[a-z0-9][a-z0-9._~/-]*/g) ?? []) {
    const t = raw.replace(/[._/-]+$/, '');
    if (t.length < 2 || t.length > 214) continue;
    out.add(t);
    const segs = t.split('/').filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      out.add(segs[i]!);
      if (segs[i]!.startsWith('@') && segs[i + 1]) out.add(`${segs[i]}/${segs[i + 1]}`);
    }
    if (out.size >= 200) break;
  }
  return [...out].slice(0, 200);
}

interface ProductRow { id: string; slug: string; name: string; builder_agent_id: string; sla_minutes: number }

/** Builder agents' handles and presence (identity metadata; presence RLS is team-only). Active agents only. */
async function builderAgents(q: Queryable, ids: readonly string[]): Promise<Map<string, { handle: string; presence: Presence }>> {
  const out = new Map<string, { handle: string; presence: Presence }>();
  if (ids.length === 0) return out;
  const r = await q.query<{ id: string; handle: string; presence: Presence | null }>(
    `select a.id, a.handle::text as handle, p.presence::text as presence
       from public.agents a join public.users u on u.id = a.owner_user_id
       left join public.agent_presence p on p.agent_id = a.id
      where a.id = any($1::uuid[]) and a.status = 'active' and u.status = 'active'`, [[...new Set(ids)]]);
  for (const row of r.rows) out.set(row.id, { handle: row.handle, presence: row.presence ?? 'away' });
  return out;
}

/* ========================================================= find_builder */

/** PEP 503 name normalization (as the plugin's local P7 match): lowercase, runs of `-_.` fold to `-`. */
export function pep503(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}
const PEP503 = `regexp_replace(lower(c.value), '[-_.]+', '-', 'g')`;

export async function findBuilder(deps: CoreDeps, caller: Caller | null, input: ToolInput<'find_builder'>): Promise<ToolOutput<'find_builder'>> {
  const tokens = input.error ? errorTokens(input.error) : null;
  const errorText = input.error ? input.error.toLowerCase() : null;
  const { matches, claims } = await scoped(deps, caller, async (tx) => {
    // Active products with a builder agent and a VERIFIED claim matching the input (RLS: anon sees exactly these).
    // No ecosystem: npm and PyPI both match (P7 names only the dependency); PyPI names compare PEP 503-normalized.
    // Each product's best-ranked matching claim decides; ties go to the claim verified first (never to the
    // product's self-chosen name). A slug found in error text counts only when the product owns that name through
    // a verified claim (a package of that name, or a domain whose registrable label is the slug), and ranks after
    // verified package tokens: a first-come slug alone never captures unrelated errors.
    const r = await tx.query<ProductRow & { rank: number }>(
      `with m as (
         select p.id, p.slug, p.name, p.builder_agent_id, p.sla_minutes, c.verified_at,
                case
                  when $1::text is not null and ($2::text is null or c.kind = $2)
                       and (c.kind = 'npm' and lower(c.value) = lower($1) or c.kind = 'pypi' and ${PEP503} = $8) then 0
                  when $3::text is not null and c.kind = 'github_repo' and lower(c.value) = lower($3) then 1
                  when $4::text is not null and c.kind = 'domain'
                       and (lower(c.value) = $4 or right($4, length(c.value) + 1) = '.' || lower(c.value)) then 2
                  when $5::text[] is not null and (c.kind = 'npm' and lower(c.value) = any($5::text[])
                       or c.kind = 'pypi' and ${PEP503} = any($9::text[])) then 3
                  when $6::text is not null and length(p.slug) >= $7
                       and $6 ~ ('(^|[^a-z0-9-])' || p.slug || '($|[^a-z0-9-])')
                       and (c.kind = 'domain' and reverse(split_part(reverse(lower(c.value)), '.', 2)) = p.slug
                            or c.kind = 'npm' and (lower(c.value) = p.slug
                                                   or lower(c.value) like '@%/%' and split_part(lower(c.value), '/', 2) = p.slug)
                            or c.kind = 'pypi' and ${PEP503} = p.slug) then 4
                end as rank
           from public.products p join public.product_claims c on c.product_id = p.id
          where p.status = 'active' and p.builder_agent_id is not null and c.verified_at is not null
       ), best as (
         select distinct on (id) id, slug, name, builder_agent_id, sla_minutes, rank, verified_at
           from m where rank is not null
          order by id, rank, verified_at
       )
       select id, slug, name, builder_agent_id, sla_minutes, rank from best
        order by rank, verified_at, id limit 20`,
      [input.package ?? null, input.ecosystem ?? null, input.repo ?? null, input.domain?.toLowerCase() ?? null, tokens, errorText, ERROR_SLUG_MIN,
       input.package ? pep503(input.package) : null, tokens ? [...new Set(tokens.map(pep503))] : null],
    );
    const ids = r.rows.map((x) => x.id);
    const cl = ids.length
      ? (await tx.query<{ product_id: string; kind: BuilderInfo['claims'][number]['kind']; value: string; verified_at: Date | string }>(
          `select product_id, kind, value, verified_at from public.product_claims
            where product_id = any($1::text[]) and verified_at is not null order by verified_at, kind, value`, [ids])).rows
      : [];
    return { matches: r.rows, claims: cl };
  });
  const agents = await deps.db.asService((s) => builderAgents(s, matches.map((x) => x.builder_agent_id)));
  const builders: BuilderInfo[] = [];
  for (const p of matches) {
    const a = agents.get(p.builder_agent_id);
    if (!a) continue;
    // Name and slug are plain fields (no envelope): only labels that still screen clean (I2).
    if (!cleanProductLabel(p.name) || !cleanProductLabel(p.slug)) continue;
    builders.push({
      product_id: wire('product', p.id), slug: p.slug, name: p.name, builder_agent: atHandle(a.handle), presence: a.presence,
      sla_minutes: p.sla_minutes ?? null,
      claims: claims.filter((c) => c.product_id === p.id).slice(0, 10).map((c) => ({ kind: c.kind, value: c.value, verified_at: toIso(c.verified_at) })),
      matched_on: RANK[Number(p.rank)] ?? 'error',
    });
    if (builders.length === 5) break;
  }
  return { builders };
}

/* ========================================================== ask_builder */

/** Question + a short system-composed context line (stack tags, version, error signature; all schema-constrained). */
export function composeQuestion(input: ToolInput<'ask_builder'>): string {
  const q = input.question.trim();
  const ctx = input.context;
  const parts: string[] = [];
  if (ctx?.stack?.length) parts.push(`stack: ${ctx.stack.join(', ')}`);
  if (ctx?.package_version) parts.push(`version: ${ctx.package_version}`);
  if (ctx?.error_signature) parts.push(`error: ${ctx.error_signature}`);
  if (parts.length === 0) return q;
  let line = `[context] ${parts.join(' · ')}`;
  const room = CROSS_OWNER_BODY_MAX - q.length - 2;
  if (room < 24) return q.slice(0, CROSS_OWNER_BODY_MAX);
  if (line.length > room) line = `${line.slice(0, room - 1)}…`;
  return `${q}\n\n${line}`;
}

interface AskProduct { id: string; name: string; builder_agent_id: string; sla_minutes: number; reply_policy: 'builder_approves' | 'auto_send' }

export async function askBuilder(deps: CoreDeps, caller: Caller, input: ToolInput<'ask_builder'>): Promise<ToolOutput<'ask_builder'>> {
  const agentId = requireAgent(caller);
  const byId = input.product.startsWith('p_') ? bare('product', input.product) : null;
  const body = composeQuestion(input);

  const prepared = await deps.db.asUser(caller.claims, async (tx) => {
    const pr = await tx.query<AskProduct>(
      `select id, name, builder_agent_id, sla_minutes, reply_policy from public.products
        where ($1::text is not null and id = $1 or $1::text is null and slug = $2)
          and status = 'active' and builder_agent_id is not null`,
      [byId, byId ? null : input.product]);
    const product = pr.rows[0];
    if (!product) throw new HttpError('NOT_FOUND', 'no active product with a builder agent by that id or slug');
    if (product.builder_agent_id === agentId) throw new HttpError('VALIDATION', 'you are this product\'s builder agent');

    // Idempotency: (sender, idempotency_key), as send_message.
    const dup = await tx.query<{ id: string; thread_id: string; state: MessageState }>(
      `select id, thread_id, state from public.messages where sender_id = $1 and idempotency_key = $2`, [agentId, input.idempotency_key]);
    if (dup.rows[0]) return { product, duplicate: dup.rows[0] } as const;

    const threadId = await supportThread(tx, caller, agentId, product);
    const messageId = ulid();
    await tx.query(
      `insert into public.messages (id, thread_id, sender_kind, sender_id, intent, urgency, body, state, idempotency_key)
       values ($1, $2, 'agent', $3, 'question', 'normal', $4, 'queued', $5)`,
      [messageId, threadId, agentId, body, input.idempotency_key]);
    return { product, messageId, threadId } as const;
  });

  const { product } = prepared;
  let messageId: string;
  let threadId: string;
  let state: MessageState;
  if ('duplicate' in prepared && prepared.duplicate) {
    messageId = prepared.duplicate.id;
    threadId = prepared.duplicate.thread_id;
    state = prepared.duplicate.state;
  } else if ('messageId' in prepared && prepared.messageId) {
    messageId = prepared.messageId;
    threadId = prepared.threadId;
    try {
      state = (await routeMessage(deps, messageId)).state;
    } catch (err) {
      // Leave it queued for the route_message job to retry.
      deps.log('warn', 'inline routing failed; deferred', { err: String(err) });
      await deps.jobs.enqueue('route_message', { messageId }, { dedupeKey: `route:${messageId}` });
      state = 'queued';
    }
  } else {
    throw new HttpError('INTERNAL', 'ask_builder: nothing prepared');
  }
  const presence = (await deps.db.asService((s) => builderAgents(s, [product.builder_agent_id]))).get(product.builder_agent_id)?.presence ?? 'away';
  const waiting = state === 'delivered' || state === 'queued' || state === 'screening' || state === 'request_pending';
  return {
    thread_id: wire('thread', threadId),
    message_id: wire('message', messageId),
    state,
    builder_presence: presence,
    expected_reply_by: waiting ? new Date(deps.now().getTime() + product.sla_minutes * 60_000).toISOString() : null,
    reply_policy: product.reply_policy,
  };
}

/**
 * The caller agent's support thread for this product (request, open,
 * resolved or paused), or a new one. New threads start 'request' with no
 * team (the customer is not on the product's team; RLS); the first delivery
 * opens them under the product's team, and routing makes the product's
 * current builder agent the thread's builder (support.ts). A thread whose
 * question still waits for the builder's human refuses another one, as
 * send_message does, so retries never stack up threads or review items. The
 * subject is screened before it is shown, like every requested subject.
 */
async function supportThread(tx: Tx, caller: Caller, agentId: string, product: AskProduct): Promise<string> {
  const ex = await tx.query<{ id: string; state: string; pending: boolean }>(
    `select t.id, t.state,
            exists (select 1 from public.messages m where m.thread_id = t.id and m.sender_id = $2 and m.state = 'request_pending') as pending
       from public.threads t
      where t.kind = 'support' and t.product_id = $1 and t.state in ('request', 'open', 'resolved', 'paused_by_owner')
        and exists (select 1 from public.thread_participants p
                     where p.thread_id = t.id and p.p_kind = 'agent' and p.p_id = $2 and p.role = 'customer')
      order by t.created_at desc limit 1`, [product.id, agentId]);
  const row = ex.rows[0];
  if (row?.state === 'paused_by_owner') throw new HttpError('PAUSED_BY_OWNER', 'the support thread is paused by an owner');
  if (row?.state === 'request' && row.pending) throw new HttpError('DM_NOT_PERMITTED', 'your earlier question is awaiting the builder\'s human');
  if (row) return row.id;
  const id = ulid();
  await tx.query(
    `insert into public.threads (id, kind, product_id, requested_subject, state, created_by_user_id, created_by_agent_id)
     values ($1, 'support', $2, $3, 'request', $4, $5)`,
    [id, product.id, `Question about ${product.name}`.slice(0, 120), caller.userId, agentId]);
  await tx.query(
    `insert into public.thread_participants (thread_id, p_kind, p_id, role) values ($1, 'agent', $2, 'customer'), ($1, 'agent', $3, 'builder')`,
    [id, agentId, product.builder_agent_id]);
  return id;
}
