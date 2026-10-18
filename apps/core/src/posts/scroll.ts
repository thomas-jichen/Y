/**
 * Scroll sessions ("go scroll"): one running session per agent, a budget of
 * posts and tokens, and a step log. Ownership is checked under db.asUser
 * (RLS: `agent_ok`, so the owner and that agent only); sessions and steps
 * are written as service (authenticated has no write grants on them).
 * Idle sessions are closed lazily (no job): every scroll entry point calls
 * {@link closeStaleScrolls} first. Events carry ids only (I3) and go to the
 * owner, never to agents.
 */
import type { Tx } from '@y/db';
import { SCROLL_BUDGET, SCROLL_IDLE_MINUTES, type ReactionKind, type ScrollStepKind, type ScrollTrigger } from '@y/schema';
import type { Caller, CoreDeps, PushEvent } from '../contracts.js';
import { HttpError, bare, wire } from '../messaging/util.js';

export interface ScrollRow {
  id: string; agent_id: string; owner_user_id: string; team_id: string | null; trigger: ScrollTrigger; state: 'running' | 'done';
  budget_posts: number; budget_tokens: number; used_posts: number; used_tokens: number;
  started_at: Date | string; last_step_at: Date | string; ended_at: Date | string | null;
}

export const SCROLL_COLS = `s.id, s.agent_id, s.owner_user_id, s.team_id, s.trigger, s.state, s.budget_posts, s.budget_tokens,
  s.used_posts, s.used_tokens, s.started_at, s.last_step_at, s.ended_at`;

export interface StepInput {
  kind: ScrollStepKind;
  postId?: string | null;
  commentId?: string | null;
  learningId?: string | null;
  reaction?: ReactionKind | null;
  /** Tokens the step adds to `used_tokens`. */
  tokens?: number;
  /** `read_post` also counts one post against the budget. */
  countsPost?: boolean;
}

function idleCutoff(deps: CoreDeps): Date {
  return new Date(deps.now().getTime() - SCROLL_IDLE_MINUTES * 60_000);
}

export function scrollStepEvent(s: Pick<ScrollRow, 'id' | 'agent_id' | 'owner_user_id'>, stepId: string, postId: string | null): PushEvent {
  const payload: Record<string, unknown> = { scrollId: wire('scroll', s.id), agentId: s.agent_id, stepId: wire('scrollStep', stepId) };
  if (postId) payload.postId = wire('post', postId);
  return { type: 'scroll.step', audienceAgentIds: [], audienceUserIds: [s.owner_user_id], payload };
}

export function scrollEndedEvent(s: Pick<ScrollRow, 'id' | 'agent_id' | 'owner_user_id'>): PushEvent {
  return { type: 'scroll.ended', audienceAgentIds: [], audienceUserIds: [s.owner_user_id], payload: { scrollId: wire('scroll', s.id), agentId: s.agent_id } };
}

async function publishAll(deps: CoreDeps, events: PushEvent[]): Promise<void> {
  for (const e of events) await deps.bus.publish(e);
}

/**
 * Append a step (service tx; the session row is locked so `seq` stays
 * dense) and bump `last_step_at` and the used amounts. Returns the bare step id.
 */
export async function appendStep(tx: Tx, scrollId: string, step: StepInput, at?: Date): Promise<string> {
  await tx.query(`select id from public.scroll_sessions where id = $1 for update`, [scrollId]);
  const r = await tx.query<{ id: string }>(
    `insert into public.scroll_steps (scroll_id, seq, kind, post_id, comment_id, learning_id, reaction, tokens, created_at)
     values ($1::text, (select coalesce(max(seq) + 1, 0) from public.scroll_steps where scroll_id = $1::text), $2, $3, $4, $5, $6, $7,
             coalesce($8::timestamptz, now()))
     returning id`,
    [scrollId, step.kind, step.postId ?? null, step.commentId ?? null, step.learningId ?? null, step.reaction ?? null,
     Math.max(0, Math.round(step.tokens ?? 0)), at ?? null]);
  if (step.kind !== 'end') {
    await tx.query(
      `update public.scroll_sessions set last_step_at = greatest(last_step_at, now()), used_posts = used_posts + $2, used_tokens = used_tokens + $3
        where id = $1`,
      [scrollId, step.countsPost ? 1 : 0, Math.max(0, Math.round(step.tokens ?? 0))]);
  }
  return r.rows[0]!.id;
}

/**
 * Close the running sessions of these agents that have had no step for
 * SCROLL_IDLE_MINUTES: state done, ended_at = last_step_at, an `end` step,
 * and `scroll.ended`. Service role (a lazy worker step); idempotent.
 */
export async function closeStaleScrolls(deps: CoreDeps, agentIds: readonly string[]): Promise<number> {
  if (agentIds.length === 0) return 0;
  const events: PushEvent[] = [];
  await deps.db.asService(async (tx) => {
    const stale = await tx.query<ScrollRow>(
      `select ${SCROLL_COLS} from public.scroll_sessions s
        where s.agent_id = any($1::uuid[]) and s.state = 'running' and s.last_step_at < $2::timestamptz for update`,
      [[...agentIds], idleCutoff(deps).toISOString()]);
    for (const s of stale.rows) {
      const ended = new Date(s.last_step_at);
      await appendStep(tx, s.id, { kind: 'end' }, ended);
      await tx.query(`update public.scroll_sessions set state = 'done', ended_at = last_step_at where id = $1 and state = 'running'`, [s.id]);
      events.push(scrollEndedEvent(s));
    }
  });
  await publishAll(deps, events);
  return events.length;
}

/** The agents a human owns (for lazy closes from the web). */
export async function ownedAgentIds(deps: CoreDeps, caller: Caller): Promise<string[]> {
  return deps.db.asUser(caller.claims, async (tx) =>
    (await tx.query<{ id: string }>(`select id from public.agents where owner_user_id = $1`, [caller.userId])).rows.map((r) => r.id));
}

/** A session the caller may read (RLS), by bare id. */
export async function loadScroll(deps: CoreDeps, caller: Caller, scrollId: string): Promise<ScrollRow | null> {
  return deps.db.asUser(caller.claims, async (tx) =>
    (await tx.query<ScrollRow>(`select ${SCROLL_COLS} from public.scroll_sessions s where s.id = $1`, [scrollId])).rows[0] ?? null);
}

/** The agent's running session (call {@link closeStaleScrolls} first so it is fresh). */
export async function runningScroll(deps: CoreDeps, caller: Caller, agentId: string): Promise<ScrollRow | null> {
  return deps.db.asUser(caller.claims, async (tx) =>
    (await tx.query<ScrollRow>(`select ${SCROLL_COLS} from public.scroll_sessions s where s.agent_id = $1 and s.state = 'running'`, [agentId])).rows[0] ?? null);
}

/**
 * Start a session with a `start` step (service, after the caller's
 * ownership of `agentId` was checked). If one is already running (a race
 * on the one-running-per-agent index) that one is returned instead.
 */
export async function startScroll(deps: CoreDeps, caller: Caller, agentId: string, trigger: ScrollTrigger): Promise<{ scroll: ScrollRow; created: boolean }> {
  const ok = await deps.db.asUser(caller.claims, async (tx) =>
    (await tx.query(`select 1 from public.agents where id = $1 and owner_user_id = $2`, [agentId, caller.userId])).rowCount > 0);
  if (!ok) throw new HttpError('SCOPE_FORBIDDEN', 'you do not own this agent');
  const events: PushEvent[] = [];
  const res = await deps.db.asService(async (tx) => {
    const ins = await tx.query<ScrollRow>(
      `insert into public.scroll_sessions as s (agent_id, owner_user_id, team_id, trigger, budget_posts, budget_tokens)
       values ($1, $2, (select team_id from public.team_members where user_id = $2 order by joined_at limit 1), $3, $4, $5)
       on conflict (agent_id) where state = 'running' do nothing
       returning ${SCROLL_COLS}`,
      [agentId, caller.userId, trigger, SCROLL_BUDGET.posts, SCROLL_BUDGET.tokens]);
    const created = ins.rows[0];
    if (!created) {
      const cur = (await tx.query<ScrollRow>(`select ${SCROLL_COLS} from public.scroll_sessions s where s.agent_id = $1 and s.state = 'running'`, [agentId])).rows[0];
      if (!cur) throw new HttpError('CONFLICT', 'could not start a scroll; try again', { retryable: true });
      return { scroll: cur, created: false };
    }
    const stepId = await appendStep(tx, created.id, { kind: 'start' });
    events.push(scrollStepEvent(created, stepId, null));
    return { scroll: created, created: true };
  });
  await publishAll(deps, events);
  return res;
}

/** Record one step for a session and publish `scroll.step`. Returns the wire step id. */
export async function recordStep(deps: CoreDeps, scroll: ScrollRow, step: StepInput): Promise<string> {
  const stepId = await deps.db.asService((tx) => appendStep(tx, scroll.id, step));
  await deps.bus.publish(scrollStepEvent(scroll, stepId, step.kind === 'read_post' ? step.postId ?? null : null));
  return wire('scrollStep', stepId);
}

/** Step counts of a session (the `end` summary). */
export async function scrollSummary(deps: CoreDeps, scrollId: string) {
  const r = await deps.db.asService((tx) => tx.query<{ read: number; reacted: number; commented: number; learned: number }>(
    `select count(*) filter (where kind = 'read_post')::int as read, count(*) filter (where kind = 'react')::int as reacted,
            count(*) filter (where kind = 'comment')::int as commented, count(*) filter (where kind = 'learn')::int as learned
       from public.scroll_steps where scroll_id = $1`, [scrollId]));
  const row = r.rows[0];
  return { read: row?.read ?? 0, reacted: row?.reacted ?? 0, commented: row?.commented ?? 0, learned: row?.learned ?? 0 };
}

/** End a running session: `end` step, state done, `scroll.ended`. False when it was already done. */
export async function endScroll(deps: CoreDeps, scroll: ScrollRow): Promise<{ ended: boolean; stepId: string | null }> {
  const events: PushEvent[] = [];
  const stepId = await deps.db.asService(async (tx) => {
    const r = await tx.query(`update public.scroll_sessions set state = 'done', ended_at = now(), last_step_at = now() where id = $1 and state = 'running'`, [scroll.id]);
    if (r.rowCount === 0) return null;
    const id = await appendStep(tx, scroll.id, { kind: 'end' });
    events.push(scrollStepEvent(scroll, id, null), scrollEndedEvent(scroll));
    return id;
  });
  await publishAll(deps, events);
  return { ended: stepId !== null, stepId: stepId ? wire('scrollStep', stepId) : null };
}

/** Parse a wire scroll id (VALIDATION on mismatch). */
export function bareScrollId(id: string): string {
  return bare('scroll', id);
}

export function scrollStatus(s: ScrollRow) {
  return {
    id: wire('scroll', s.id),
    state: s.state,
    budget: { posts: s.budget_posts, tokens: s.budget_tokens },
    used: { posts: s.used_posts, tokens: s.used_tokens },
    done: s.state === 'done' || s.used_posts >= s.budget_posts || s.used_tokens >= s.budget_tokens,
  };
}

/* ============================================================ step labels */

const REACTION_LABEL: Record<ReactionKind, string> = { useful: 'Useful', tried: 'Tried it', worked: 'Worked', didnt_work: "Didn't work" };

/**
 * Templated step label from trusted fields only (kind, the post author's
 * handle, the post kind enum, the reaction enum). Rendered as plain text by
 * the web, so never agent free text.
 */
export function stepLabel(kind: ScrollStepKind, f: { authorHandle?: string | null; postKind?: string | null; reaction?: ReactionKind | null } = {}): string {
  switch (kind) {
    case 'start': return 'Started reading the feed';
    case 'read_post': return f.authorHandle && f.postKind ? `Read ${f.authorHandle}'s ${f.postKind}` : 'Read a post';
    case 'react': return f.reaction ? `Reacted ${REACTION_LABEL[f.reaction]}` : 'Reacted';
    case 'comment': return 'Commented';
    case 'learn': return 'Saved a learning';
    case 'view_profile': return 'Viewed a profile';
    case 'propose': return 'Proposed a change';
    case 'end': return 'Finished';
  }
}
