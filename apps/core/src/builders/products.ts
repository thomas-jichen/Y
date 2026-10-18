/**
 * Products web API (team admins as humans, I11) and the public claim list
 * for P7. Reads and writes run through db.asUser (RLS: products and claims
 * are inserted/updated by team admins in a web session); `verified_at` and
 * `status` are set by core as the service role after the checks here,
 * because RLS never lets users set them.
 *
 * Routes: GET/POST /api/v1/products, PATCH /api/v1/products/:id,
 * POST /api/v1/products/:id/claims, POST /api/v1/products/:id/claims/verify,
 * GET /api/v1/builders/claims (no auth, cacheable).
 */
import type { Context } from 'hono';
import { isSqlState, type Tx } from '@y/db';
import {
  AddClaimRequest,
  CreateProductRequest,
  UpdateProductRequest,
  VerifyClaimRequest,
  claimMarker,
  ulid,
  type ClaimKind,
  type Product,
  type PublicBuilderClaims,
  type VerifyClaimResponse,
} from '@y/schema';
import type { App, Caller, CoreDeps } from '../contracts.js';
import { authenticate } from '../platform/http.js';
import { loadAgentRefs } from '../platform/mappers.js';
import { bareId, fail, iso, parseOr, readJson } from '../platform/util.js';
import { HttpError } from '../messaging/util.js';
import { syncSupportBuilders } from '../messaging/support.js';
import { guardedFetch, verifyClaimMarker } from './verify.js';

interface ProductRow {
  id: string; slug: string; name: string; owner_team_id: string; builder_agent_id: string | null; sla_minutes: number;
  reply_policy: Product['replyPolicy']; status: Product['status']; created_at: Date | string;
}
interface ClaimRow { product_id: string; kind: ClaimKind; value: string; verified_at: Date | string | null; created_at: Date | string }

const PRODUCT_COLS = 'p.id, p.slug, p.name, p.owner_team_id, p.builder_agent_id, p.sla_minutes, p.reply_policy, p.status, p.created_at';

/** Products of the caller's teams (an explicit membership filter: RLS also shows every active product). */
async function loadProducts(deps: CoreDeps, caller: Caller, ids: string[] | null): Promise<Product[]> {
  const { rows, claims } = await deps.db.asUser(caller.claims, async (tx) => {
    const r = await tx.query<ProductRow>(
      `select ${PRODUCT_COLS} from public.products p
        where exists (select 1 from public.team_members m where m.team_id = p.owner_team_id and m.user_id = $1)
          and ($2::text[] is null or p.id = any($2::text[]))
        order by p.created_at desc, p.id limit 200`, [caller.userId, ids]);
    const pids = r.rows.map((x) => x.id);
    const cl = pids.length
      ? (await tx.query<ClaimRow>(
          `select product_id, kind, value, verified_at, created_at from public.product_claims
            where product_id = any($1::text[]) order by created_at, kind, value`, [pids])).rows
      : [];
    return { rows: r.rows, claims: cl };
  });
  const agents = await deps.db.asService((s) => loadAgentRefs(s, rows.map((p) => p.builder_agent_id).filter((x): x is string => !!x)));
  return rows.map((p) => ({
    id: `p_${p.id}`, slug: p.slug, name: p.name, teamId: p.owner_team_id,
    builderAgent: p.builder_agent_id ? agents.get(p.builder_agent_id) ?? null : null,
    slaMinutes: p.sla_minutes, replyPolicy: p.reply_policy, status: p.status,
    claims: claims.filter((c) => c.product_id === p.id).slice(0, 50).map((c) => ({
      kind: c.kind, value: c.value, verifiedAt: c.verified_at ? iso(c.verified_at) : null, createdAt: iso(c.created_at),
      marker: claimMarker(c.kind, c.value, p.slug),
    })),
    createdAt: iso(p.created_at),
  }));
}

async function oneProduct(deps: CoreDeps, caller: Caller, id: string): Promise<Product> {
  const [p] = await loadProducts(deps, caller, [id]);
  if (!p) throw new HttpError('NOT_FOUND', 'product not found');
  return p;
}

async function isTeamAdmin(tx: Tx, teamId: string, userId: string): Promise<boolean> {
  const r = await tx.query(`select 1 from public.team_members where team_id = $1 and user_id = $2 and role in ('owner', 'admin')`, [teamId, userId]);
  return r.rowCount > 0;
}

/** The product row, for a team admin of its team only (else 404 / 403). */
async function adminProduct(tx: Tx, caller: Caller, id: string): Promise<ProductRow> {
  const r = await tx.query<ProductRow>(`select ${PRODUCT_COLS} from public.products p where p.id = $1`, [id]);
  const p = r.rows[0];
  if (!p) throw new HttpError('NOT_FOUND', 'product not found');
  if (!(await isTeamAdmin(tx, p.owner_team_id, caller.userId))) throw new HttpError('SCOPE_FORBIDDEN', 'only an admin of the product\'s team can do this');
  return p;
}

/** An active agent, by handle, owned by a member of the team. */
async function teamAgent(tx: Tx, teamId: string, handle: string): Promise<string> {
  const r = await tx.query<{ agent_id: string; owner_user_id: string }>(`select agent_id, owner_user_id from api.resolve_agent_handle($1)`, [handle]);
  const a = r.rows[0];
  const member = a ? (await tx.query(`select 1 from public.team_members where team_id = $1 and user_id = $2`, [teamId, a.owner_user_id])).rowCount > 0 : false;
  if (!a || !member) throw new HttpError('VALIDATION', 'the builder agent must be an active agent owned by a member of the team');
  return a.agent_id;
}

/** Canonical claim value: hostnames and package names compare case-insensitively; stored lowercase except owner/repo. */
function canonicalValue(kind: ClaimKind, value: string): string {
  return kind === 'github_repo' ? value : value.toLowerCase();
}

async function run(c: Context, deps: CoreDeps, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) return fail(c, e.code, e.message, e.opts);
    if (isSqlState(e, '42501')) return fail(c, 'SCOPE_FORBIDDEN', 'only a team admin in a web session can change products');
    if (isSqlState(e, '23505')) return fail(c, 'CONFLICT', 'already taken');
    deps.log('error', 'products route failed', { err: String(e), path: c.req.path });
    return fail(c, 'INTERNAL', 'internal error');
  }
}

export function registerProductRoutes(app: App, deps: CoreDeps): void {
  app.get('/api/v1/products', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    return run(c, deps, async () => c.json(await loadProducts(deps, caller, null)));
  });

  app.post('/api/v1/products', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const body = parseOr(c, CreateProductRequest, await readJson(c));
    if (!body.ok) return body.res;
    return run(c, deps, async () => {
      const id = ulid();
      try {
        await deps.db.asUser(caller.claims, async (tx) => {
          const team = body.data.teamId
            ? (await tx.query<{ team_id: string }>(
                `select team_id from public.team_members where team_id = $1 and user_id = $2 and role in ('owner', 'admin')`,
                [body.data.teamId, caller.userId])).rows[0]
            : (await tx.query<{ team_id: string }>(
                `select team_id from public.team_members where user_id = $1 and role in ('owner', 'admin') order by joined_at, team_id limit 1`,
                [caller.userId])).rows[0];
          if (!team) throw new HttpError('SCOPE_FORBIDDEN', 'only a team admin can register a product');
          const agentId = await teamAgent(tx, team.team_id, body.data.builderAgent);
          await tx.query(
            `insert into public.products (id, slug, name, owner_team_id, builder_agent_id, sla_minutes, reply_policy, status)
             values ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
            [id, body.data.slug, body.data.name, team.team_id, agentId, body.data.slaMinutes ?? 1440, body.data.replyPolicy ?? 'builder_approves']);
        });
      } catch (e) {
        if (isSqlState(e, '23505')) return fail(c, 'CONFLICT', 'that product slug is taken');
        throw e;
      }
      return c.json(await oneProduct(deps, caller, id));
    });
  });

  app.patch('/api/v1/products/:id', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const id = bareId('p', c.req.param('id'));
    if (!id) return fail(c, 'VALIDATION', 'expected a product id (p_…)');
    const body = parseOr(c, UpdateProductRequest, await readJson(c));
    if (!body.ok) return body.res;
    return run(c, deps, async () => {
      const u = body.data;
      const changed = await deps.db.asUser(caller.claims, async (tx) => {
        const p = await adminProduct(tx, caller, id);
        let builder = p.builder_agent_id;
        if (u.builderAgent !== undefined) builder = u.builderAgent === null ? null : await teamAgent(tx, p.owner_team_id, u.builderAgent);
        await tx.query(
          `update public.products set name = coalesce($2, name), sla_minutes = coalesce($3, sla_minutes),
                  reply_policy = coalesce($4, reply_policy), builder_agent_id = $5 where id = $1`,
          [id, u.name ?? null, u.slaMinutes ?? null, u.replyPolicy ?? null, builder]);
        if (u.status === 'active' && p.status !== 'active') {
          const v = await tx.query(`select 1 from public.product_claims where product_id = $1 and verified_at is not null limit 1`, [id]);
          if (v.rowCount === 0) throw new HttpError('VALIDATION', 'verify at least one claim before activating the product');
          if (!builder) throw new HttpError('VALIDATION', 'set a builder agent before activating the product');
        }
        return { status: u.status && u.status !== p.status ? u.status : null, builderChanged: builder !== p.builder_agent_id };
      });
      // products.status and support-thread participants are not user-writable (RLS): set after the admin check above.
      if (changed.status || changed.builderChanged) {
        await deps.db.asService(async (s) => {
          if (changed.status) await s.query(`update public.products set status = $2, updated_at = now() where id = $1`, [id, changed.status]);
          // A replaced builder leaves the product's support threads; the new one joins (I4).
          if (changed.builderChanged) await syncSupportBuilders(s, id);
        });
      }
      return c.json(await oneProduct(deps, caller, id));
    });
  });

  app.post('/api/v1/products/:id/claims', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const id = bareId('p', c.req.param('id'));
    if (!id) return fail(c, 'VALIDATION', 'expected a product id (p_…)');
    const body = parseOr(c, AddClaimRequest, await readJson(c));
    if (!body.ok) return body.res;
    return run(c, deps, async () => {
      await deps.db.asUser(caller.claims, async (tx) => {
        await adminProduct(tx, caller, id);
        await tx.query(
          `insert into public.product_claims (product_id, kind, value) values ($1, $2, $3) on conflict do nothing`,
          [id, body.data.kind, canonicalValue(body.data.kind, body.data.value)]);
      });
      return c.json(await oneProduct(deps, caller, id));
    });
  });

  app.post('/api/v1/products/:id/claims/verify', async (c) => {
    const caller = await authenticate(c, deps, 'web');
    if (caller instanceof Response) return caller;
    const id = bareId('p', c.req.param('id'));
    if (!id) return fail(c, 'VALIDATION', 'expected a product id (p_…)');
    const body = parseOr(c, VerifyClaimRequest, await readJson(c));
    if (!body.ok) return body.res;
    const kind = body.data.kind;
    const value = canonicalValue(kind, body.data.value);
    return run(c, deps, async () => {
      const pre = await deps.db.asUser(caller.claims, async (tx) => {
        const p = await adminProduct(tx, caller, id);
        const cl = await tx.query<{ verified_at: Date | string | null }>(
          `select verified_at from public.product_claims where product_id = $1 and kind = $2 and value = $3`, [id, kind, value]);
        if (!cl.rows[0]) throw new HttpError('NOT_FOUND', 'add this claim before verifying it');
        return { slug: p.slug, verified: cl.rows[0].verified_at !== null };
      });
      let out: Omit<VerifyClaimResponse, 'product'>;
      if (pre.verified) {
        out = { verified: true };
      } else {
        const res = await verifyClaimMarker(deps.fetch ?? guardedFetch, kind, value, pre.slug);
        const checkedAt = deps.now().toISOString();
        try {
          await deps.db.asService(async (s) => {
            if (!res.ok) {
              await s.query(
                `update public.product_claims set verification = $4::jsonb where product_id = $1 and kind = $2 and value = $3`,
                [id, kind, value, JSON.stringify({ url: res.url, checked_at: checkedAt, failure: res.reason })]);
              return;
            }
            await s.query(
              `update public.product_claims set verified_at = now(), verification = $4::jsonb
                where product_id = $1 and kind = $2 and value = $3 and verified_at is null`,
              [id, kind, value, JSON.stringify({ url: res.url, checked_at: checkedAt, method: kind })]);
            // A verified claim plus a builder agent makes the product discoverable (a suspended one stays suspended).
            await s.query(
              `update public.products set status = 'active', updated_at = now() where id = $1 and status = 'pending' and builder_agent_id is not null`, [id]);
          });
        } catch (e) {
          if (isSqlState(e, '23505')) return fail(c, 'CONFLICT', `this ${kind} is already claimed by another product`);
          throw e;
        }
        out = res.ok ? { verified: true } : { verified: false, reason: res.reason };
      }
      const resp: VerifyClaimResponse = { ...out, product: await oneProduct(deps, caller, id) };
      return c.json(resp);
    });
  });

  // Public (no auth): verified npm/PyPI claims of active products, for the plugin's local P7 matching.
  app.get('/api/v1/builders/claims', async (c) => {
    return run(c, deps, async () => {
      const rows = await deps.db.asAnon(async (tx) => (await tx.query<{ kind: 'npm' | 'pypi'; value: string; product_id: string }>(
        `select c.kind, c.value, c.product_id from public.product_claims c join public.products p on p.id = c.product_id
          where p.status = 'active' and p.builder_agent_id is not null and c.verified_at is not null and c.kind in ('npm', 'pypi')
          order by c.kind, c.value limit 10000`)).rows);
      const out: PublicBuilderClaims = { claims: rows.map((r) => ({ kind: r.kind, value: r.value, product_id: `p_${r.product_id}` })) };
      c.header('cache-control', 'public, max-age=3600');
      return c.json(out);
    });
  });
}
