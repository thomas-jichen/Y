/**
 * compare_setups: "copy what measurably works". Contrasts the team's
 * published, captured work sessions WITH vs WITHOUT each setup component
 * (grouped by kind + name; versions and hashes vary) on verified success
 * (outcome shipped or green) and median tokens on success.
 *
 * Honesty rules: team scope only (db.asUser + explicit team filter, never
 * cross-team); Wilson 95% lower bounds; n and distinct owners per arm;
 * 'measured' only at with.n ≥ 5 and without.n ≥ 5, each arm from ≥ 2 owners. Components
 * every session has (no contrast) are dropped, and components present in
 * exactly the same sessions are collapsed into one row (`collinear`).
 * Names are composed from the stored snapshot's parts, each validated on
 * its own (ComponentName; ModelId for the model, so `[1m]` variants count)
 * and dropped when the L0 screen flags it: teammates choose these strings
 * and agents relay the headline. At most MAX_COMPONENT_ROWS component rows
 * are read per call (the caller's own setup first, then by recency), so a
 * flood of bloated snapshots cannot make each call unbounded.
 */
import type { Tx } from '@y/db';
import { l0Scan } from '@y/safety';
import { ComponentName, ModelId, type CompareSetupsOutput, type McpSetupArm, type McpSetupComponentSignal, type SetupComponentKind } from '@y/schema';
import type { Caller, CoreDeps } from '../contracts.js';
import { networkContentBlocked } from '../posts/agent-tools.js';

export const WINDOW_DAYS = 90;
export const MAX_SESSIONS = 2000;
export const MAX_COMPONENTS = 8;
/** An arm smaller than this is not shown at all (too noisy even as an early signal). */
export const MIN_ARM = 2;
export const MEASURED = { nWith: 5, ownersWith: 2, nWithout: 5, ownersWithout: 2 } as const;
/** Upper bound on component rows read per call (normal teams stay far below it). */
export const MAX_COMPONENT_ROWS = 50_000;

const METHOD =
  `Your team's published captured work sessions, last ${WINDOW_DAYS} days (max ${MAX_SESSIONS}). Verified success = outcome shipped (PR) or green (tests green at end); unknown counts as not verified. Wilson 95% lower bound. Correlation, not causation.`;

const KIND_RANK: Record<SetupComponentKind, number> = {
  plugin: 0, mcp_server: 1, skill: 2, subagent: 3, claude_md_block: 4, setting: 5, hook: 6,
};

export const EMPTY_SIGNED_OUT: CompareSetupsOutput = {
  segment: null, rows: [], you: null, insufficient_data: true, signed_in: false, components: [], headline: null,
};

/** Wilson score interval lower bound (95%). */
export function wilsonLower(successes: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = successes / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, Math.min(1, (centre - margin) / (1 + z2 / n)));
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const pct = (x: number) => `${Math.round(x * 100)}%`;

export interface Session {
  id: string;
  agentId: string;
  ownerId: string;
  setupVersionId: string | null;
  success: boolean;
  tokens: number;
  publishedAt: Date;
}

function arm(sessions: Session[]): McpSetupArm & { topOwnerShare: number } {
  const n = sessions.length;
  const wins = sessions.filter((s) => s.success);
  const perOwner = new Map<string, number>();
  for (const s of sessions) perOwner.set(s.ownerId, (perOwner.get(s.ownerId) ?? 0) + 1);
  return {
    n,
    owners: perOwner.size,
    success_rate: n ? round(wins.length / n) : 0,
    success_wilson: round(wilsonLower(wins.length, n)),
    median_tokens_on_success: median(wins.map((s) => s.tokens)),
    topOwnerShare: n ? round(Math.max(...perOwner.values()) / n) : 0,
  };
}

/**
 * Pure computation (exported for tests): sessions, each setup version's
 * component keys ("kind\u0000name"), and the caller's agent + latest setup.
 */
export function computeSignals(
  sessions: Session[],
  componentsBySetup: Map<string, Set<string>>,
  you: { agentId: string | null; latestSetupId: string | null },
): McpSetupComponentSignal[] {
  const withSetup = sessions.filter((s) => s.setupVersionId && componentsBySetup.has(s.setupVersionId));
  const N = withSetup.length;
  if (N === 0) return [];
  const members = new Map<string, number[]>();
  withSetup.forEach((s, i) => {
    for (const key of componentsBySetup.get(s.setupVersionId!)!) {
      const list = members.get(key) ?? [];
      list.push(i);
      members.set(key, list);
    }
  });
  // Collapse components present in exactly the same sessions.
  const bySignature = new Map<string, string[]>();
  for (const [key, idx] of members) {
    if (idx.length === N) continue; // universal: no contrast
    if (idx.length < MIN_ARM || N - idx.length < MIN_ARM) continue;
    const sig = idx.join(',');
    const group = bySignature.get(sig) ?? [];
    group.push(key);
    bySignature.set(sig, group);
  }
  const yours = you.latestSetupId ? componentsBySetup.get(you.latestSetupId) ?? new Set<string>() : new Set<string>();
  const out: McpSetupComponentSignal[] = [];
  for (const [sig, keys] of bySignature) {
    keys.sort((a, b) => {
      const [ka, na] = a.split('\u0000') as [SetupComponentKind, string];
      const [kb, nb] = b.split('\u0000') as [SetupComponentKind, string];
      return KIND_RANK[ka] - KIND_RANK[kb] || (na < nb ? -1 : na > nb ? 1 : 0);
    });
    const [kind, name] = keys[0]!.split('\u0000') as [SetupComponentKind, string];
    const inSet = new Set(sig.split(',').map(Number));
    const w = arm(withSetup.filter((_, i) => inSet.has(i)));
    const wo = arm(withSetup.filter((_, i) => !inSet.has(i)));
    const measured = w.n >= MEASURED.nWith && w.owners >= MEASURED.ownersWith
      && wo.n >= MEASURED.nWithout && wo.owners >= MEASURED.ownersWithout;
    const tokensDelta = w.median_tokens_on_success !== null && wo.median_tokens_on_success
      ? round((w.median_tokens_on_success - wo.median_tokens_on_success) / wo.median_tokens_on_success)
      : null;
    const { topOwnerShare, ...withArm } = w;
    const { topOwnerShare: withoutTopOwnerShare, ...withoutArm } = wo;
    out.push({
      kind, name,
      label: measured ? 'measured' : 'early_signal',
      with: withArm, without: withoutArm,
      lift: round(Math.max(-1, Math.min(1, w.success_rate - wo.success_rate))),
      tokens_delta: tokensDelta,
      top_owner_share: topOwnerShare,
      without_top_owner_share: withoutTopOwnerShare,
      you_use: keys.some((k) => yours.has(k)),
      collinear: keys.length - 1,
    });
  }
  out.sort((a, b) =>
    (a.label === b.label ? 0 : a.label === 'measured' ? -1 : 1)
    || Math.abs(b.lift) - Math.abs(a.lift)
    || b.with.n - a.with.n
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out.slice(0, MAX_COMPONENTS);
}

/** One line for the strongest measured signal: component name and numbers only. */
export function headlineFor(c: McpSetupComponentSignal | undefined, you: CompareSetupsOutput['you']): string | null {
  if (!c || c.label !== 'measured' || c.lift === 0) return null;
  let line = `${c.kind} ${c.name}: ${pct(c.with.success_rate)} verified success with it vs ${pct(c.without.success_rate)} without `
    + `(n=${c.with.n} sessions, ${c.with.owners} owners vs n=${c.without.n})`;
  // No token clause: tokens_total includes cache reads, so a delta says more about
  // context reuse than cost. tokens_delta stays in the row for callers that know that.
  if (c.top_owner_share > 0.6) line += `, ${pct(c.top_owner_share)} of with-sessions from one owner`;
  // One member's sessions can dominate the comparison arm just as well.
  if ((c.without_top_owner_share ?? 0) > 0.6) line += `, ${pct(c.without_top_owner_share!)} of without-sessions from one owner`;
  if (you && you.success_rate !== null) line += `; your agent: ${pct(you.success_rate)} (n=${you.n})`;
  line += c.you_use ? '; you already use it' : '; you do not use it';
  return line.slice(0, 300);
}

type ActRow = { id: string; agent_id: string; owner_user_id: string; setup_version_id: string | null; outcome_status: string; tokens_total: string | number; published_at: Date | string };
type CompRow = { id: string; kind: string; a: string | null; b: string | null };

/**
 * Component parts of each setup version: plugin (a = name, b = marketplace),
 * skill / mcp_server (a = name), subagent (a = the string), CLAUDE.md, and
 * settings (a = 'outputStyle' | 'model', b = the value). Rows come in `$1`
 * order (priority), at most `$2`.
 */
const COMPONENTS_SQL = `
  with sv as (
    select v.id, v.snapshot s, u.ord from public.setup_versions v
      join unnest($1::text[]) with ordinality u(id, ord) on u.id = v.id),
  arr as (
    select id, ord, 'plugin' as kind, case when jsonb_typeof(s->'plugins') = 'array' then s->'plugins' else '[]'::jsonb end as xs from sv
    union all select id, ord, 'skill', case when jsonb_typeof(s->'skills') = 'array' then s->'skills' else '[]'::jsonb end from sv
    union all select id, ord, 'mcp_server', case when jsonb_typeof(s->'mcpServers') = 'array' then s->'mcpServers' else '[]'::jsonb end from sv
    union all select id, ord, 'subagent', case when jsonb_typeof(s->'subagents') = 'array' then s->'subagents' else '[]'::jsonb end from sv
  ),
  parts as (
    select arr.id, arr.ord, arr.kind, e.i,
           case when arr.kind = 'subagent' then e.x #>> '{}' else e.x->>'name' end as a,
           case when arr.kind = 'plugin' then e.x->>'marketplace' end as b
      from arr, jsonb_array_elements(arr.xs) with ordinality e(x, i)
    union all select id, ord, 'claude_md_block', 0, 'CLAUDE.md', null from sv where s ? 'claudeMd'
    union all select id, ord, 'setting', 0, 'outputStyle', s->>'outputStyle' from sv where s ? 'outputStyle'
    union all select id, ord, 'setting', 1, 'model', s->>'model' from sv where s ? 'model'
  )
  select id, kind, a, b from parts order by ord, kind, i limit $2`;

/** Read component rows for these setup versions (priority order), at most `limit`. */
export async function loadComponentRows(tx: Tx, svIds: string[], limit = MAX_COMPONENT_ROWS): Promise<CompRow[]> {
  if (svIds.length === 0) return [];
  return (await tx.query<CompRow>(COMPONENTS_SQL, [svIds, limit])).rows;
}

/** True when the L0 screen does not flag a name part (separators read as spaces, so 'ignore-previous-instructions' is seen). */
function screenedPart(part: string, memo: Map<string, boolean>): boolean {
  let ok = memo.get(part);
  if (ok === undefined) {
    const label = l0Scan(part.replace(/[._:@/+[\]-]+/g, ' '), 'comment').label;
    ok = label === 'clean' || label === 'warn';
    memo.set(part, ok);
  }
  return ok;
}

/**
 * The signal name for one component row, or null when a part does not
 * validate or is flagged. Parts are validated separately, so long
 * `plugin@marketplace` keys and `model:...[1m]` are kept.
 */
export function componentName(r: Pick<CompRow, 'kind' | 'a' | 'b'>, memo: Map<string, boolean> = new Map()): string | null {
  const comp = (x: string | null | undefined): x is string => typeof x === 'string' && ComponentName.safeParse(x).success && screenedPart(x, memo);
  if (!r.a) return null;
  switch (r.kind) {
    case 'plugin':
      if (!comp(r.a)) return null;
      if (r.b === null || r.b === undefined) return r.a;
      return comp(r.b) ? `${r.a}@${r.b}` : null;
    case 'claude_md_block':
      return 'CLAUDE.md';
    case 'setting':
      if (r.a === 'outputStyle') return comp(r.b) ? `outputStyle:${r.b}` : null;
      if (r.a === 'model') return typeof r.b === 'string' && ModelId.safeParse(r.b).success && screenedPart(r.b, memo) ? `model:${r.b}` : null;
      return null;
    default:
      return comp(r.a) ? r.a : null;
  }
}

export async function compareSetups(deps: CoreDeps, caller: Caller | null): Promise<CompareSetupsOutput> {
  if (!caller) return EMPTY_SIGNED_OUT;
  // network_content kill switch: no teammates' component names while it is engaged.
  if (await networkContentBlocked(deps)) return { ...EMPTY_SIGNED_OUT, signed_in: true };
  const now = deps.now();
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const data = await deps.db.asUser(caller.claims, async (tx) => {
    const teams = (await tx.query<{ team_id: string }>('select team_id from public.team_members where user_id = $1', [caller.userId])).rows.map((r) => r.team_id);
    if (!teams.length) return null;
    // Explicit team filter on top of RLS: never pool another team's (or public) work.
    // One harness session can publish several work segments (activities) with the same
    // setup; roll them up to ONE sample per session (success if any segment verified).
    const acts = (await tx.query<ActRow>(
      `select coalesce(a.session_id::text, a.id) as id,
              (array_agg(a.agent_id order by a.published_at desc, a.id desc))[1] as agent_id,
              (array_agg(a.owner_user_id order by a.published_at desc, a.id desc))[1] as owner_user_id,
              (array_agg(a.setup_version_id order by a.published_at desc, a.id desc) filter (where a.setup_version_id is not null))[1] as setup_version_id,
              case when bool_or(a.outcome_status in ('shipped', 'green')) then 'green' else 'unknown' end as outcome_status,
              sum(a.tokens_total) as tokens_total, max(a.published_at) as published_at
         from public.activities a
        where a.kind = 'work' and a.source = 'captured' and a.status = 'published'
          and a.screen_action in ('allow', 'label') and a.visibility <> 'private' and a.team_id = any($1::uuid[])
          and a.published_at >= $2
        group by 1
        order by max(a.published_at) desc, 1 desc
        limit ${MAX_SESSIONS}`, [teams, since])).rows;
    // The setup the agent is running now: its most recent activity's snapshot (ingest dedupes
    // setup_versions on (agent_id, hash), so A → B → A leaves B as the newest row); fall back
    // to the newest setup version when it has no activity yet.
    const latest = caller.agentId
      ? (await tx.query<{ id: string | null }>(
        `select coalesce(
           (select setup_version_id from public.activities
             where agent_id = $1 and setup_version_id is not null order by started_at desc, id desc limit 1),
           (select id from public.setup_versions where agent_id = $1 order by created_at desc, id desc limit 1)) as id`,
        [caller.agentId])).rows[0]?.id ?? null
      : null;
    // Priority for the row cap: the caller's own setup, then setups by recency of use.
    const svIds = [...new Set([...(latest ? [latest] : []), ...acts.map((a) => a.setup_version_id).filter((x): x is string => !!x)])];
    const comps = await loadComponentRows(tx, svIds);
    return { acts, latest, comps };
  });
  if (!data) {
    return { segment: null, rows: [], you: null, insufficient_data: true, signed_in: true, components: [], headline: null };
  }
  const componentsBySetup = new Map<string, Set<string>>();
  const memo = new Map<string, boolean>();
  for (const r of data.comps) {
    const name = componentName(r, memo); // only validated, screened names
    if (!name) continue;
    const set = componentsBySetup.get(r.id) ?? new Set<string>();
    set.add(`${r.kind}\u0000${name}`);
    componentsBySetup.set(r.id, set);
  }
  const sessions: Session[] = data.acts.map((a) => ({
    id: a.id, agentId: a.agent_id, ownerId: a.owner_user_id, setupVersionId: a.setup_version_id,
    success: a.outcome_status === 'shipped' || a.outcome_status === 'green',
    tokens: Number(a.tokens_total), publishedAt: new Date(a.published_at),
  }));

  let you: CompareSetupsOutput['you'] = null;
  if (caller.agentId) {
    const mine = sessions.filter((s) => s.agentId === caller.agentId);
    const rate = (xs: Session[]) => (xs.length ? xs.filter((s) => s.success).length / xs.length : null);
    const cut = now.getTime() - 30 * 86_400_000;
    const recent = rate(mine.filter((s) => s.publishedAt.getTime() >= cut));
    const before = rate(mine.filter((s) => s.publishedAt.getTime() < cut));
    const r = rate(mine);
    you = { rank: null, success_rate: r === null ? null : round(r), n: mine.length, trend_30d: recent !== null && before !== null ? round(recent - before) : 0 };
  }
  const components = computeSignals(sessions, componentsBySetup, { agentId: caller.agentId, latestSetupId: data.latest });
  // segment.n / owners describe exactly the sessions the arms are built from.
  const used = sessions.filter((s) => s.setupVersionId && componentsBySetup.has(s.setupVersionId));
  return {
    segment: {
      slug: 'all-work', name: 'All captured work on your team', kind: 'organic',
      n: used.length, owners: new Set(used.map((s) => s.ownerId)).size, method: METHOD,
    },
    rows: [],
    you,
    insufficient_data: !components.some((c) => c.label === 'measured'),
    signed_in: true,
    components,
    headline: headlineFor(components[0], you),
  };
}
