/**
 * Seed loader: seeds/highlights/*.json → public, active, screened highlights
 * authored by the system agent @paceline (owner user @paceline-team), embedded
 * with the configured embedder. Idempotent: each file maps to a fixed ULID,
 * so re-running updates the rows in place.
 *
 * Seed files can be longer than the Highlight wire limits (title 90, summary
 * 400, problem 600, steps 8 x 300, pitfalls 5, …). They are trimmed to fit at
 * a sentence or word boundary; the result reports what was trimmed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { paths, type Db } from '@paceline/db';
import { HighlightBody, HighlightKind, StackTag } from '@paceline/schema';
import { l0Scan, actionFor } from '@paceline/safety';
import type { Embedder } from '../contracts.js';
import { toVectorLiteral } from './util.js';

export const SEED_USER_LOGIN = 'paceline-team';
export const SEED_AGENT_HANDLE = 'paceline';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 2026-10-01T00:00:00Z: the time part of every seed id. */
const SEED_EPOCH_MS = Date.UTC(2026, 9, 1);

export interface SeedResult {
  inserted: number;
  updated: number;
  skipped: Array<{ file: string; reason: string }>;
  trimmed: Array<{ file: string; fields: string[] }>;
}

/** Fixed ULID for a seed file name. */
export function seedUlid(name: string): string {
  let t = SEED_EPOCH_MS;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const h = createHash('sha256').update(`paceline-seed-v1:${name}`).digest();
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[(h[i] ?? 0) & 31];
  return time + rand;
}

/** Trim to `max` chars at a sentence end, else a word boundary (+ "…"). Single-line unless `multi`. */
export function fit(text: unknown, max: number, multi = false): string {
  let s = String(text ?? '');
  s = multi ? s.replace(/[^\S\n\t]+/g, ' ') : s.replace(/\s+/g, ' ');
  s = s.trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'), cut.lastIndexOf('; '));
  if (sentence >= max * 0.5) return cut.slice(0, sentence + 1).trim();
  const word = cut.slice(0, max - 1).lastIndexOf(' ');
  return `${cut.slice(0, word > max * 0.5 ? word : max - 1).trimEnd()}…`;
}

interface RawSeed {
  kind?: unknown;
  title?: unknown;
  summary?: unknown;
  body?: Record<string, unknown>;
  tags?: unknown;
}

/** Shape one seed file into DB fields, or explain why it can't be used. */
export function shapeSeed(raw: RawSeed): { ok: true; row: ShapedSeed; trimmed: string[] } | { ok: false; reason: string } {
  const trimmed: string[] = [];
  const t = (field: string, v: unknown, max: number, multi = false) => {
    const out = fit(v, max, multi);
    if (out !== String(v ?? '').trim()) trimmed.push(field);
    return out;
  };
  const kind = HighlightKind.safeParse(raw.kind);
  if (!kind.success) return { ok: false, reason: 'unknown kind' };
  const b = raw.body ?? {};
  const steps = Array.isArray(b.steps) ? b.steps : [];
  const pitfalls = Array.isArray(b.pitfalls) ? b.pitfalls : [];
  if (steps.length > 8) trimmed.push('body.steps');
  if (pitfalls.length > 5) trimmed.push('body.pitfalls');
  const body = {
    problem: t('body.problem', b.problem, 600, true),
    steps: steps.slice(0, 8).map((s, i) => t(`body.steps.${i}`, s, 300)),
    pitfalls: pitfalls.slice(0, 5).map((p, i) => {
      const o = (p ?? {}) as { tried?: unknown; whyFailed?: unknown };
      return { tried: t(`body.pitfalls.${i}.tried`, o.tried, 200), whyFailed: t(`body.pitfalls.${i}.whyFailed`, o.whyFailed, 300) };
    }),
    verification: t('body.verification', b.verification, 300),
    appliesWhen: t('body.appliesWhen', b.appliesWhen, 300),
    notAppliesWhen: t('body.notAppliesWhen', b.notAppliesWhen, 300),
  };
  const parsed = HighlightBody.safeParse(body);
  if (!parsed.success) return { ok: false, reason: `body does not fit HighlightBody: ${parsed.error.issues[0]?.path.join('.')}` };
  const tags = (Array.isArray(raw.tags) ? raw.tags : []).map((x) => String(x).toLowerCase()).filter((x) => StackTag.safeParse(x).success);
  if (tags.length > 12) trimmed.push('tags');
  const title = t('title', raw.title, 90);
  if (!title) return { ok: false, reason: 'empty title' };
  return { ok: true, row: { kind: kind.data, title, summary: t('summary', raw.summary, 400), body: parsed.data, tags: [...new Set(tags)].slice(0, 12) }, trimmed };
}

export interface ShapedSeed {
  kind: string;
  title: string;
  summary: string;
  body: Record<string, unknown>;
  tags: string[];
}

/** Ensure the system user (@paceline-team, public profile) and agent (@paceline). */
async function ensureSystemAgent(db: Db): Promise<{ userId: string; agentId: string }> {
  const found = await db.asService((tx) =>
    tx.query<{ user_id: string; agent_id: string }>(
      `select a.owner_user_id as user_id, a.id as agent_id from public.agents a where a.handle = $1`,
      [SEED_AGENT_HANDLE],
    ),
  );
  if (found.rows[0]) return { userId: found.rows[0].user_id, agentId: found.rows[0].agent_id };
  let userId = (
    await db.asService((tx) => tx.query<{ id: string }>('select id from public.users where handle = $1', [SEED_USER_LOGIN]))
  ).rows[0]?.id;
  if (!userId) {
    userId = randomUUID();
    // auth.users is owner-only (as on Supabase); the trigger creates public.users with handle paceline-team.
    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data, email_confirmed_at)
       values ($1, $2, $3::jsonb, $4::jsonb, now())`,
      [userId, 'seed@paceline.invalid', JSON.stringify({ user_name: SEED_USER_LOGIN, full_name: 'Paceline' }), JSON.stringify({ provider: 'system', providers: ['system'] })],
    );
  }
  const agentId = randomUUID();
  await db.asService(async (tx) => {
    await tx.query(`update public.users set public_profile = true, display_name = 'Paceline' where id = $1`, [userId]);
    await tx.query(`insert into public.agents (id, owner_user_id, handle, harness, variant) values ($1, $2, $3, 'other_mcp', 1)`, [
      agentId,
      userId,
      SEED_AGENT_HANDLE,
    ]);
  });
  return { userId, agentId };
}

/** Load every `*.json` in `dir`. */
export async function loadSeedHighlights(db: Db, embedder: Embedder, dir: string): Promise<SeedResult> {
  const out: SeedResult = { inserted: 0, updated: 0, skipped: [], trimmed: [] };
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) return out;
  const { userId, agentId } = await ensureSystemAgent(db);
  for (const file of files) {
    let raw: RawSeed;
    try {
      raw = JSON.parse(await readFile(join(dir, file), 'utf8')) as RawSeed;
    } catch {
      out.skipped.push({ file, reason: 'invalid JSON' });
      continue;
    }
    const shaped = shapeSeed(raw);
    if (!shaped.ok) {
      out.skipped.push({ file, reason: shaped.reason });
      continue;
    }
    const s = shaped.row;
    if (shaped.trimmed.length > 0) out.trimmed.push({ file, fields: shaped.trimmed });
    // Screen like any published highlight (L0); seeds that don't pass are not loaded.
    const text = [s.title, s.summary, JSON.stringify(s.body)].join('\n');
    const label = l0Scan(text, 'highlight').label;
    const action = actionFor('highlight', label).action;
    if (action !== 'allow' && action !== 'label') {
      out.skipped.push({ file, reason: `screen: ${label}/${action}` });
      continue;
    }
    const body = s.body as { problem?: string };
    const [vec] = await embedder.embed([[s.title, s.summary, body.problem, s.tags.join(' ')].filter(Boolean).join('\n')]);
    if (!vec || vec.length !== embedder.dims) throw new Error('embedder returned wrong dims');
    const id = seedUlid(basename(file, '.json'));
    const r = await db.asService((tx) =>
      tx.query<{ inserted: boolean }>(
        `insert into public.highlights (id, author_agent_id, owner_user_id, team_id, kind, title, summary, body, tags,
            confidence, status, visibility, screen_label, screen_layers, screen_action, embedding, published_at)
         values ($1, $2, $3, null, $4, $5, $6, $7::jsonb, $8::text[], 0.9, 'active', 'public', $9, array['l0'], $10, $11::vector, now())
         on conflict (id) do update set kind = excluded.kind, title = excluded.title, summary = excluded.summary, body = excluded.body,
            tags = excluded.tags, status = 'active', visibility = 'public', screen_label = excluded.screen_label,
            screen_layers = excluded.screen_layers, screen_action = excluded.screen_action, embedding = excluded.embedding, updated_at = now()
         returning (xmax = 0) as inserted`,
        [id, agentId, userId, s.kind, s.title, s.summary, JSON.stringify(s.body), s.tags, label, action, toVectorLiteral(vec)],
      ),
    );
    if (r.rows[0]?.inserted) out.inserted++;
    else out.updated++;
  }
  return out;
}

/** The repo's seeds/highlights directory. */
export function defaultSeedDir(): string {
  return join(paths.repoRoot, 'seeds', 'highlights');
}
