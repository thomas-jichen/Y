/**
 * Job `turn_summary` (db.asService only here): one accepted ingest chunk with a
 * non-empty digest → at most one row in public.turn_summaries.
 *
 * Reads that chunk's sealed digest delta (never copied anywhere: it stays in
 * activity_chunks under the existing 24 h purge, I6), asks the summarizer for
 * {changed, building}, then normalizes, redacts (pass 2), masks, L0-screens and
 * DLP-checks the output (I8, I10). Anything that fails is dropped. Kill
 * switches `ingest` and `network_content` (or failing to read them) skip the
 * job. Chunks without a digest (share mode 'stats'), prompt-only turns (no
 * TOOL/CONFIG lines) and already summarized chunks are skipped. The web is
 * told with an ids-only `activity.updated` event (I3).
 */
import { REDACTION_MARKER_RE, TURN_SUMMARY_FIELD_MAX, type Label } from '@y/schema';
import { redact } from '@y/redact';
import { actionFor, dlpScan, l0Scan, normalizeUntrusted } from '@y/safety';
import type { CoreDeps, JobHandler } from '../contracts.js';
import { maskEnvironment } from '../platform/distill.js';
import { screenVariants, type SealedChunk } from '../platform/pipeline.js';
import { openDigest } from '../platform/util.js';
import { digestShowsWork, turnSummarizerFor } from './summarizer.js';

export const TURN_SUMMARY_TOPIC = 'turn_summary';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Enqueue payload and dedupe key for one chunk (at most one summary per chunk). */
export function turnSummaryJob(sessionId: string, seq: number): { payload: Record<string, unknown>; dedupeKey: string } {
  return { payload: { sessionId, seq }, dedupeKey: `turn_summary:${sessionId}:${seq}` };
}

/**
 * Code inside prose (DLP only sees code-shaped lines): backticks, braces, arrows, calls, a trailing
 * semicolon, or a declaration keyword followed by a name and an operator.
 */
const INLINE_CODE_RE = /[`{}]|=>|\w\(\)|;\s*$|\b(?:const|let|var|function|def|class|import|export|return)\s+[\w$]+\s*[=({:<]/;

const LABEL_RANK: Record<string, number> = { clean: 0, warn: 1, sensitive: 2, suspicious: 3, malicious: 4 };

/** One line, at most `max` chars, ASCII ellipsis (NFKC would grow '…'). */
function clipLine(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 3).trimEnd()}...`;
}

/**
 * A model-written field made safe to store, or null to drop the summary: normalized like agent-read
 * text, one line, no redaction markers, nothing pass-2 redaction would touch, no URL / host / IP /
 * e-mail / home or machine path / credential file name, clipped to the column limit.
 */
export function cleanSummaryField(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = clipLine(normalizeUntrusted(raw).text.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' '), 4 * TURN_SUMMARY_FIELD_MAX);
  if (!text) return null;
  if (REDACTION_MARKER_RE.test(text)) return null;
  const r = redact(text);
  if (r.dropped || r.text !== text) return null;
  if (maskEnvironment(text) !== text) return null;
  const out = clipLine(text, TURN_SUMMARY_FIELD_MAX);
  return out || null;
}

/** L0 (card class) over the text and its hidden variants, plus outbound DLP with no code allowed. */
export function screenSummary(changed: string, building: string): { ok: boolean; reason: 'l0' | 'dlp' | null; label: string } {
  const joined = `${changed}\n${building}`;
  let label = 'clean';
  for (const t of [joined, changed, building]) {
    for (const v of new Set([t, ...screenVariants(t)])) {
      const l = l0Scan(v, 'card').label;
      if ((LABEL_RANK[l] ?? 4) > (LABEL_RANK[label] ?? 4)) label = l;
    }
  }
  const action = actionFor('card', label as Label).action;
  if (action !== 'allow' && action !== 'label') return { ok: false, reason: 'l0', label };
  if (!dlpScan(joined, { allowShortCode: false }).ok || INLINE_CODE_RE.test(changed) || INLINE_CODE_RE.test(building)) {
    return { ok: false, reason: 'dlp', label };
  }
  return { ok: true, reason: null, label };
}

/** `ingest` or `network_content` engaged, or unreadable (fails closed). */
async function switchedOff(deps: CoreDeps): Promise<boolean> {
  try {
    const r = await deps.db.asService((tx) =>
      tx.query<{ n: number }>(`select count(*)::int as n from public.kill_switches where name in ('ingest', 'network_content') and engaged`),
    );
    return Number(r.rows[0]?.n ?? 0) > 0;
  } catch {
    return true;
  }
}

interface ChunkRow {
  digest_enc: Uint8Array | null;
  activity_id: string | null;
  agent_id: string;
  repo_key: string | null;
  owner_user_id: string;
  team_id: string | null;
  done: boolean;
}

const turnSummary: JobHandler = async (payload, deps) => {
  const sessionId = payload.sessionId;
  const seq = payload.seq;
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) throw new Error('bad payload: sessionId');
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) throw new Error('bad payload: seq');
  if (await switchedOff(deps)) return;
  const summarizer = turnSummarizerFor(deps);
  if (!summarizer) return;

  const row = (
    await deps.db.asService((tx) =>
      tx.query<ChunkRow>(
        `select c.digest_enc, c.activity_id, s.agent_id, s.repo_key, ag.owner_user_id, a.team_id,
                exists (select 1 from public.turn_summaries t where t.session_id = c.session_id and t.chunk_seq = c.seq) as done
           from public.activity_chunks c
           join public.sessions s on s.id = c.session_id
           join public.agents ag on ag.id = s.agent_id
           left join public.activities a on a.id = c.activity_id
          where c.session_id = $1 and c.seq = $2`,
        [sessionId, seq],
      ),
    )
  ).rows[0];
  // Gone, already summarized, or the digest was purged / never sent.
  if (!row || row.done || !row.digest_enc) return;
  let digest = '';
  try {
    digest = (JSON.parse(openDigest(deps.config.hmacKey, row.digest_enc)) as SealedChunk).text ?? '';
  } catch {
    deps.log('warn', 'turn summary: unreadable digest blob', { seq });
    return;
  }
  // Rate/cost guard: a prompt-only turn (no tool calls, no edits) has nothing to report.
  if (!digest.trim() || !digestShowsWork(digest)) return;

  // The model call runs outside any transaction (it holds no DB connection while it waits).
  const draft = await summarizer.summarize(digest);
  digest = '';
  if (!draft) return;
  const changed = cleanSummaryField(draft.changed);
  const building = cleanSummaryField(draft.building);
  if (!changed || !building) {
    deps.log('info', 'turn summary dropped', { reason: 'unsafe_field', seq });
    return;
  }
  const screened = screenSummary(changed, building);
  if (!screened.ok) {
    deps.log('info', 'turn summary dropped', { reason: screened.reason ?? 'screen', label: screened.label, seq });
    return;
  }

  await deps.db.asService(async (tx) => {
    const ins = await tx.query<{ id: string }>(
      `insert into public.turn_summaries (agent_id, owner_user_id, team_id, session_id, chunk_seq, activity_id, repo_key, changed, building, model)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (session_id, chunk_seq) do nothing
       returning id`,
      [row.agent_id, row.owner_user_id, row.team_id, sessionId, seq, row.activity_id, row.repo_key, changed, building, summarizer.name.slice(0, 80)],
    );
    if (!ins.rows[0]) return;
    // Live update for open web clients: ids only (I3). The web refetches /updates on activity events.
    const audience = row.team_id
      ? (
          await tx.query<{ user_id: string }>('select user_id from public.team_members where team_id = $1 order by joined_at limit 100', [row.team_id])
        ).rows.map((r) => r.user_id)
      : [];
    if (row.activity_id) {
      await deps.bus.publish(
        {
          type: 'activity.updated',
          audienceAgentIds: [],
          audienceUserIds: [...new Set([row.owner_user_id, ...audience])].slice(0, 100),
          payload: { activityId: `a_${row.activity_id}` },
        },
        tx,
      );
    }
  });
};

export const UPDATES_JOBS: Record<string, JobHandler> = { [TURN_SUMMARY_TOPIC]: turnSummary };
