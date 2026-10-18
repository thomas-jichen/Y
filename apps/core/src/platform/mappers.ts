/** DB rows (snake_case) → wire shapes (camelCase, packages/schema). All reads run under the caller's RLS. */
import type { Tx } from '@y/db';
import {
  ActivityStats,
  HighlightBody,
  Lap,
  SetupSnapshot,
  componentsFromSnapshot,
  emptyStats,
  type Activity,
  type AgentRef,
  type Highlight,
  type ReviewItem,
  type SetupCard,
} from '@y/schema';
import { iso, isoOpt, num, sha256Hex } from './util.js';

const AGENT_COLS = `a.id as agent_id, a.handle as agent_handle, a.harness as agent_harness,
  u.id as user_id, u.github_login as user_login, u.handle as user_handle, u.avatar_url as user_avatar`;

interface AgentJoinRow {
  agent_id: string;
  agent_handle: string;
  agent_harness: string;
  user_id: string;
  user_login: string | null;
  user_handle: string;
  user_avatar: string | null;
}

export function agentRefFromRow(r: AgentJoinRow): AgentRef {
  return {
    id: r.agent_id,
    handle: `@${r.agent_handle}`,
    harness: r.agent_harness as AgentRef['harness'],
    owner: {
      id: r.user_id,
      login: r.user_login && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(r.user_login) ? r.user_login : r.user_handle,
      handle: `@${r.user_handle}`,
      avatarUrl: r.user_avatar ?? '',
    },
  };
}

export async function loadAgentRefs(tx: Tx, agentIds: readonly string[]): Promise<Map<string, AgentRef>> {
  const out = new Map<string, AgentRef>();
  const ids = [...new Set(agentIds)];
  if (ids.length === 0) return out;
  const r = await tx.query<AgentJoinRow>(
    `select ${AGENT_COLS} from public.agents a join public.users u on u.id = a.owner_user_id where a.id = any($1::uuid[])`,
    [ids],
  );
  for (const row of r.rows) out.set(row.agent_id, agentRefFromRow(row));
  return out;
}

export function highlightFromRow(h: Record<string, unknown>, author?: AgentRef): Highlight {
  const body = HighlightBody.safeParse(h.body);
  return {
    id: `h_${h.id as string}`,
    kind: h.kind as Highlight['kind'],
    title: String(h.title),
    summary: String(h.summary ?? ''),
    body: body.success
      ? body.data
      : { problem: 'n/a', steps: ['n/a'], pitfalls: [{ tried: 'n/a', whyFailed: 'n/a' }], verification: '', appliesWhen: '', notAppliesWhen: '' },
    tags: (h.tags as string[] | null) ?? [],
    measuredHelp: num(h.measured_help),
    measuredFail: num(h.measured_fail),
    confirmations: num(h.confirmations),
    quality: num(h.quality),
    // Unscreened items never look clean (I8).
    screen: {
      label: ((h.screen_label as string | null) ?? 'warn') as Highlight['screen']['label'],
      layers: ((h.screen_layers as string[] | null) ?? []) as Highlight['screen']['layers'],
    },
    status: h.status as Highlight['status'],
    ...(h.activity_id ? { activityId: `a_${h.activity_id as string}` } : {}),
    ...(author ? { author } : {}),
    visibility: h.visibility as Highlight['visibility'],
    createdAt: iso(h.created_at),
  };
}

function setupCardFor(a: Record<string, unknown>, sv: Record<string, unknown> | undefined, stats: ActivityStats): SetupCard {
  if (sv) {
    const snap = SetupSnapshot.safeParse(sv.snapshot);
    return {
      id: `sv_${sv.id as string}`,
      hash: String(sv.hash),
      model: snap.success ? snap.data.model : String(sv.model ?? stats.models[0] ?? 'unknown'),
      ...(snap.success && snap.data.effort ? { effort: snap.data.effort } : {}),
      ...(snap.success && snap.data.permissionMode ? { permissionMode: snap.data.permissionMode } : {}),
      components: snap.success ? componentsFromSnapshot(snap.data) : [],
    };
  }
  // No setup snapshot uploaded: an empty card keyed by the activity.
  return { id: `sv_${a.id as string}`, hash: sha256Hex(''), model: stats.models[0] ?? 'unknown', components: [] };
}

/** Load full Activity wire objects for ids the viewer can see, preserving order. */
export async function loadActivities(tx: Tx, ids: readonly string[], viewerId: string): Promise<Activity[]> {
  if (ids.length === 0) return [];
  const acts = await tx.query<Record<string, unknown>>(
    `select a.*, t.slug as team_slug,
            (select count(*) from public.kudos k where k.activity_id = a.id) as kudos_count,
            exists (select 1 from public.kudos k where k.activity_id = a.id and k.user_id = $2) as gave_kudos
       from public.activities a left join public.teams t on t.id = a.team_id
      where a.id = any($1::text[])`,
    [ids, viewerId],
  );
  const svIds = acts.rows.map((r) => r.setup_version_id).filter((x): x is string => typeof x === 'string');
  const svs = svIds.length
    ? await tx.query<Record<string, unknown>>('select * from public.setup_versions where id = any($1::text[])', [svIds])
    : { rows: [] };
  const svById = new Map(svs.rows.map((r) => [r.id as string, r]));
  const hl = await tx.query<Record<string, unknown>>(
    `select * from public.highlights where activity_id = any($1::text[]) and status in ('draft', 'active') order by created_at`,
    [ids],
  );
  const refs = await loadAgentRefs(tx, [
    ...acts.rows.map((r) => r.agent_id as string),
    ...hl.rows.map((h) => h.author_agent_id as string),
  ]);
  const byId = new Map<string, Activity>();
  for (const a of acts.rows) {
    const agent = refs.get(a.agent_id as string);
    if (!agent) continue;
    const statsP = ActivityStats.safeParse(a.stats);
    const stats = statsP.success ? statsP.data : emptyStats();
    const lapsRaw = Array.isArray(a.laps) ? (a.laps as unknown[]).filter((l) => Lap.safeParse(l).success) as Array<{ index: number }> : [];
    // Rows written before lap de-duplication can repeat an index; keep the last report of each.
    const laps = [...new Map(lapsRaw.map((l) => [l.index, l])).values()].sort((x, y) => x.index - y.index).slice(0, 200);
    const outcome = (a.outcome ?? {}) as { status?: string; verifiedBy?: string; evidence?: string };
    byId.set(a.id as string, {
      id: `a_${a.id as string}`,
      agent,
      ...(a.team_slug ? { teamSlug: String(a.team_slug) } : {}),
      kind: a.kind as Activity['kind'],
      source: a.source as Activity['source'],
      visibility: a.visibility as Activity['visibility'],
      status: a.status as Activity['status'],
      title: String(a.title || 'Untitled session'),
      ...(a.summary ? { summary: String(a.summary) } : {}),
      taskIntent: (a.task_intent ?? 'other') as Activity['taskIntent'],
      stackTags: (a.stack_tags as string[] | null) ?? [],
      sizeBucket: (a.size_bucket ?? 'S') as Activity['sizeBucket'],
      outcome: {
        status: (outcome.status ?? a.outcome_status ?? 'unknown') as Activity['outcome']['status'],
        verifiedBy: (outcome.verifiedBy ?? 'none') as Activity['outcome']['verifiedBy'],
        ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
      },
      stats,
      laps: laps as Activity['laps'],
      setup: setupCardFor(a, a.setup_version_id ? svById.get(a.setup_version_id as string) : undefined, stats),
      highlights: hl.rows
        .filter((h) => h.activity_id === a.id)
        .slice(0, 10)
        .map((h) => highlightFromRow(h, refs.get(h.author_agent_id as string))),
      counts: { kudos: num(a.kudos_count), comments: 0, usedBy: 0, helpedMeasured: 0, adopted: 0 },
      viewer: { gaveKudos: Boolean(a.gave_kudos), isOwner: a.owner_user_id === viewerId },
      startedAt: iso(a.started_at),
      ...(a.ended_at ? { endedAt: iso(a.ended_at) } : {}),
      ...(a.published_at ? { publishedAt: iso(a.published_at) } : {}),
    });
  }
  return ids.map((id) => byId.get(id)).filter((x): x is Activity => Boolean(x));
}

export async function reviewItemsFromRows(tx: Tx, rows: Record<string, unknown>[]): Promise<ReviewItem[]> {
  const refs = await loadAgentRefs(
    tx,
    rows.map((r) => r.agent_id).filter((x): x is string => typeof x === 'string'),
  );
  return rows.map((r) => {
    const agent = r.agent_id ? refs.get(r.agent_id as string) : undefined;
    return {
      id: `rv_${r.id as string}`,
      kind: r.kind as ReviewItem['kind'],
      state: r.state as ReviewItem['state'],
      summary: String(r.summary ?? ''),
      createdAt: iso(r.created_at),
      ...(r.expires_at ? { expiresAt: iso(r.expires_at) } : {}),
      ...(agent ? { agent } : {}),
      slackSent: Boolean(r.slack_sent),
      requiresStepUp: Boolean(r.requires_step_up),
      refId: String(r.ref_id),
      ...(r.decided_via ? { decidedVia: r.decided_via as ReviewItem['decidedVia'] } : {}),
      ...(isoOpt(r.decided_at) ? { decidedAt: isoOpt(r.decided_at)! } : {}),
    } as ReviewItem;
  });
}
