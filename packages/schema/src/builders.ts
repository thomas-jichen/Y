/**
 * Builders (PLAN §5 "Builder discovery", §6 "Customer → builder"): the web
 * view of `products` and `product_claims` for team admins, the claim
 * verification markers, and the public claim list the plugin matches
 * locally for P7 (dependency names never leave the machine).
 *
 * Agent-facing shapes (`find_builder`, `ask_builder`, `BuilderInfo`,
 * `ProductClaim`) live in `mcp.ts`; the builder approval queue reuses
 * `BuilderReplyReview` and `DecisionEdits.body` from `review.ts`.
 *
 * | Method + path | Request | Response |
 * |---|---|---|
 * | `GET /products` | | {@link ProductList} |
 * | `POST /products` | {@link CreateProductRequest} | {@link Product} |
 * | `PATCH /products/:id` | {@link UpdateProductRequest} | {@link Product} |
 * | `POST /products/:id/claims` | {@link AddClaimRequest} | {@link Product} |
 * | `POST /products/:id/claims/verify` | {@link VerifyClaimRequest} | {@link VerifyClaimResponse} |
 * | `GET /builders/claims` (no auth, cacheable) | | {@link PublicBuilderClaims} |
 *
 * Products and claims are written only by team admins as humans (I11);
 * `verified_at` and `status` are set by core after verification.
 *
 * @module builders
 */
import { z } from 'zod';
import { AgentRef, Handle, Hostname, IsoTimestamp, PackageName, ProductId, Slug, TeamId } from './common.js';
import { ProductName, RepoSlug } from './mcp.js';

/** `products.status`: `active` once a claim is verified and a builder agent is set. */
export const ProductStatus = z.enum(['pending', 'active', 'suspended']);
export type ProductStatus = z.infer<typeof ProductStatus>;

/** `products.reply_policy`: builder replies wait for the builder's human, or go out after screening. */
export const ReplyPolicy = z.enum(['builder_approves', 'auto_send']);
export type ReplyPolicy = z.infer<typeof ReplyPolicy>;

/** `product_claims.kind`. */
export const ClaimKind = z.enum(['github_repo', 'npm', 'pypi', 'domain']);
export type ClaimKind = z.infer<typeof ClaimKind>;

/** npm package name (lowercase, optional scope). */
export const NpmName = z.string().max(214).regex(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/, { error: 'invalid npm package name' });
/** PyPI project name (PEP 508 shape). */
export const PypiName = z.string().max(214).regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/, { error: 'invalid PyPI project name' });

/** Validate a claim value for its kind (`npm`/`pypi` package, `owner/repo`, hostname). */
export function claimValueSchema(kind: ClaimKind): z.ZodType<string> {
  switch (kind) {
    case 'npm':
      return NpmName;
    case 'pypi':
      return PypiName;
    case 'github_repo':
      return RepoSlug;
    case 'domain':
      return Hostname;
  }
}

/** `{kind, value}` with the value checked against its kind. */
export const ClaimRef = z
  .object({ kind: ClaimKind, value: z.string().min(1).max(253) })
  .superRefine((c, ctx) => {
    const r = claimValueSchema(c.kind).safeParse(c.value);
    if (!r.success) ctx.addIssue({ code: 'custom', path: ['value'], message: `invalid ${c.kind} value` });
  });
export type ClaimRef = z.infer<typeof ClaimRef>;

/** A claim as its team sees it (verified or not). */
export const ProductClaimView = z.object({
  kind: ClaimKind,
  value: z.string().max(253),
  verifiedAt: IsoTimestamp.nullable(),
  createdAt: IsoTimestamp,
  /** Where core looks for the marker (fixed text, see {@link claimMarker}). */
  marker: z.string().max(400),
});
export type ProductClaimView = z.infer<typeof ProductClaimView>;

/** A product as its team's members see it. */
export const Product = z.object({
  id: ProductId,
  slug: Slug,
  name: ProductName,
  teamId: TeamId,
  builderAgent: AgentRef.nullable(),
  slaMinutes: z.int().min(1).max(43_200),
  replyPolicy: ReplyPolicy,
  status: ProductStatus,
  claims: z.array(ProductClaimView).max(50),
  createdAt: IsoTimestamp,
});
export type Product = z.infer<typeof Product>;

/** `GET /api/v1/products`: products of the caller's teams. */
export const ProductList = z.array(Product).max(200);
export type ProductList = z.infer<typeof ProductList>;

/** `POST /api/v1/products` (team admin, human). `teamId` defaults to the caller's first team where they are an admin. */
export const CreateProductRequest = z.object({
  slug: Slug,
  name: ProductName,
  /** Handle of an agent owned by a member of the team. */
  builderAgent: Handle,
  slaMinutes: z.int().min(1).max(43_200).optional(),
  replyPolicy: ReplyPolicy.optional(),
  teamId: TeamId.optional(),
});
export type CreateProductRequest = z.infer<typeof CreateProductRequest>;

/** `PATCH /api/v1/products/:id` (team admin, human). `status: 'active'` needs a verified claim and a builder agent. */
export const UpdateProductRequest = z
  .object({
    name: ProductName.optional(),
    builderAgent: Handle.nullable().optional(),
    slaMinutes: z.int().min(1).max(43_200).optional(),
    replyPolicy: ReplyPolicy.optional(),
    status: z.enum(['active', 'suspended']).optional(),
  })
  .refine((u) => Object.values(u).some((v) => v !== undefined), { error: 'nothing to update' });
export type UpdateProductRequest = z.infer<typeof UpdateProductRequest>;

/** `POST /api/v1/products/:id/claims`: adds an unverified claim (idempotent). */
export const AddClaimRequest = ClaimRef;
export type AddClaimRequest = ClaimRef;

/** `POST /api/v1/products/:id/claims/verify`: core fetches the marker and sets `verifiedAt`. */
export const VerifyClaimRequest = ClaimRef;
export type VerifyClaimRequest = ClaimRef;

/** Why a verification did not succeed (a claim owned by another product is 409 `CONFLICT` instead). */
export const VerifyFailure = z.enum(['marker_missing', 'not_found', 'fetch_failed', 'redirect', 'too_large', 'invalid_response']);
export type VerifyFailure = z.infer<typeof VerifyFailure>;

/** `POST /api/v1/products/:id/claims/verify` response. */
export const VerifyClaimResponse = z.object({
  verified: z.boolean(),
  reason: VerifyFailure.optional(),
  product: Product,
});
export type VerifyClaimResponse = z.infer<typeof VerifyClaimResponse>;

/** One verified package claim of an active product (P7 local matching). */
export const PublicBuilderClaim = z.object({
  kind: z.enum(['npm', 'pypi']),
  value: PackageName,
  product_id: ProductId,
});
export type PublicBuilderClaim = z.infer<typeof PublicBuilderClaim>;

/** `GET /api/v1/builders/claims` (no auth): what the plugin caches for 24 h and matches locally. */
export const PublicBuilderClaims = z.object({
  claims: z.array(PublicBuilderClaim).max(10_000),
});
export type PublicBuilderClaims = z.infer<typeof PublicBuilderClaims>;

/**
 * Where core looks for the ownership marker of a claim (fixed text for the
 * web's "how to verify" hint). Only maintainers can publish each location.
 */
export function claimMarker(kind: ClaimKind, value: string, slug: string): string {
  switch (kind) {
    case 'domain':
      return `Serve https://${value}/.well-known/y.json containing {"products":["${slug}"]}`;
    case 'github_repo':
      return `Commit .well-known/y.json containing {"products":["${slug}"]} to the default branch of ${value}`;
    case 'npm':
      return `Publish ${value} with "y": {"product": "${slug}"} in package.json`;
    case 'pypi':
      return `Add a project URL named "Y" ending in /p/${slug}, or the line "y-product: ${slug}" to the description of ${value}`;
  }
}
