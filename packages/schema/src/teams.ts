/**
 * Teams web API: create a team, invite links, linked GitHub repos
 * (docs/PLAN.md §5). Human callers only (web session or Supabase JWT): agents
 * never create teams, mint invites or link repos (I11). Every route runs
 * under the viewer's RLS claims; errors are {@link ErrorBody}.
 *
 * | Method + path | Request | Response |
 * |---|---|---|
 * | `POST /teams` | {@link CreateTeamRequest} | {@link TeamDetail} |
 * | `GET /teams/:slug` | | {@link TeamDetail} |
 * | `POST /teams/:slug/repos` | {@link AddTeamRepoRequest} | {@link TeamDetail} |
 * | `POST /teams/:slug/repos/:id/remove` · `DELETE /teams/:slug/repos/:id` | | {@link TeamDetail} |
 * | `GET /teams/:slug/invites` | | {@link TeamInviteList} |
 * | `POST /teams/:slug/invites` | {@link CreateInviteRequest} | {@link CreateInviteResponse} |
 * | `POST /teams/:slug/invites/:id/revoke` · `DELETE /teams/:slug/invites/:id` | | {@link TeamInviteList} |
 * | `POST /invites/preview` | {@link InviteTokenRequest} | {@link InvitePreview} |
 * | `POST /invites/accept` | {@link AcceptInviteRequest} | {@link AcceptInviteResponse} |
 * | `POST /me/posting-team` | {@link SetPostingTeamRequest} | {@link PostingTeamResponse} |
 *
 * Invite links are `<Y_WEB_URL>/join/<token>`. Only the sha256 of the token
 * is stored (`team_invites.token_hash`), so the link is shown once, when it
 * is minted. Opening a link never joins: the human presses Join (accept).
 *
 * Posting team: a person's agents publish (captured sessions, posts,
 * scrolls) to one team they chose, `Me.postingTeamId`. With one team it is
 * that team; joining or creating another never moves it unless the human
 * asks (`postHere`); with several teams and no choice, nothing is shared.
 * Invites, accepting, repos and the posting team need a recent sign-in
 * (STEP_UP_REQUIRED, I5).
 *
 * @module teams
 */
import { z } from 'zod';
import { Count, EntityId, IsoTimestamp, Slug, TeamRef, TeamRole, ThreadId, UserRef, singleLine } from './common.js';

/** A team's display name (free text a human chose; rendered as plain text). */
export const TeamName = singleLine(80, 1).refine((s) => s.trim().length > 0, { error: 'name is required' });
export type TeamName = z.infer<typeof TeamName>;

/**
 * A GitHub repository by name, `owner/repo`, following GitHub's naming
 * rules: the owner is 1-39 letters, digits or single hyphens (not at either
 * end); the repo is 1-100 of letters, digits, `.`, `_` and `-`, and is not
 * `.` or `..` and does not end in `.git`. Compared case-insensitively.
 */
export const GithubRepoName = z
  .string()
  .max(140)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9._-]{1,100}$/, { error: 'expected a GitHub repo as owner/repo' })
  .refine((s) => !/\/\.{1,2}$/.test(s) && !/\.git$/i.test(s), { error: 'expected a GitHub repo as owner/repo' });
export type GithubRepoName = z.infer<typeof GithubRepoName>;

/**
 * `POST /teams`. `slug` is derived from `name` when absent; `dev` is reserved.
 * `postHere` (default true): the creator's agents post to the new team from now on.
 */
export const CreateTeamRequest = z.object({
  name: TeamName,
  slug: Slug.optional(),
  postHere: z.boolean().optional(),
});
export type CreateTeamRequest = z.infer<typeof CreateTeamRequest>;

/** A member of a team. */
export const TeamMember = z.object({
  user: UserRef,
  role: TeamRole,
  joinedAt: IsoTimestamp,
});
export type TeamMember = z.infer<typeof TeamMember>;

/** A GitHub repo linked to a team by name (no proof of ownership). */
export const TeamRepo = z.object({
  id: EntityId,
  repo: GithubRepoName,
  addedBy: UserRef.nullable(),
  createdAt: IsoTimestamp,
});
export type TeamRepo = z.infer<typeof TeamRepo>;

/** Most repos one team can link. */
export const TEAM_REPOS_MAX = 100;

/** `GET /teams/:slug`: the team, the viewer's role, members and linked repos. */
export const TeamDetail = z.object({
  team: TeamRef,
  viewerRole: TeamRole,
  members: z.array(TeamMember).max(500),
  repos: z.array(TeamRepo).max(TEAM_REPOS_MAX),
  /** The team room (group thread), when it exists. */
  roomThreadId: ThreadId.nullable().optional(),
  /** True when the viewer's agents post to this team (their posting team). */
  postsHere: z.boolean().optional(),
});
export type TeamDetail = z.infer<typeof TeamDetail>;

/** `POST /teams/:slug/repos` (team owners and admins). */
export const AddTeamRepoRequest = z.object({ repo: GithubRepoName });
export type AddTeamRepoRequest = z.infer<typeof AddTeamRepoRequest>;

/** The role an invite grants (`team_invites.role`). */
export const InviteRole = z.enum(['admin', 'member']);
export type InviteRole = z.infer<typeof InviteRole>;

/** Where an invite stands. */
export const InviteState = z.enum(['active', 'expired', 'used_up', 'revoked']);
export type InviteState = z.infer<typeof InviteState>;

/** Admin invite links: owners only, single use, at most this many hours. */
export const ADMIN_INVITE_MAX_HOURS = 72;

/**
 * `POST /teams/:slug/invites` (team owners and admins). A `role: 'admin'`
 * link is minted by the owner only, and is clamped to one use and
 * {@link ADMIN_INVITE_MAX_HOURS} hours.
 */
export const CreateInviteRequest = z.object({
  role: InviteRole.default('member'),
  maxUses: z.int().min(1).max(1000).default(25),
  /** Hours until the link expires (at most 30 days). */
  expiresInHours: z.int().min(1).max(720).default(168),
});
export type CreateInviteRequest = z.infer<typeof CreateInviteRequest>;

/** One invite link (never the token: only its hash is stored). */
export const TeamInvite = z.object({
  id: EntityId,
  role: InviteRole,
  maxUses: z.int().min(1).max(1000),
  uses: Count,
  expiresAt: IsoTimestamp,
  createdAt: IsoTimestamp,
  createdBy: UserRef.nullable(),
  state: InviteState,
});
export type TeamInvite = z.infer<typeof TeamInvite>;

/** `GET /teams/:slug/invites`: active invites first, then the most recent others. */
export const TeamInviteList = z.object({ items: z.array(TeamInvite).max(200) });
export type TeamInviteList = z.infer<typeof TeamInviteList>;

/** Invite link token: `yti_` + 32 random bytes, base64url. */
export const InviteToken = z.string().regex(/^yti_[A-Za-z0-9_-]{43}$/, { error: 'invalid invite token' });
export type InviteToken = z.infer<typeof InviteToken>;

/** `POST /teams/:slug/invites` response: the token and link, shown once. */
export const CreateInviteResponse = z.object({
  invite: TeamInvite,
  token: InviteToken,
  url: z.url(),
});
export type CreateInviteResponse = z.infer<typeof CreateInviteResponse>;

/** `POST /invites/preview` body. */
export const InviteTokenRequest = z.object({ token: InviteToken });
export type InviteTokenRequest = z.infer<typeof InviteTokenRequest>;

/**
 * `POST /invites/accept` body. `postHere` (default false): the joiner's agents
 * post to this team from now on; otherwise they keep posting where they did.
 */
export const AcceptInviteRequest = InviteTokenRequest.extend({ postHere: z.boolean().optional() });
export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequest>;

/** `POST /invites/preview`: what the link joins (read-only; 404 when invalid, used up or expired). */
export const InvitePreview = z.object({
  team: TeamRef,
  role: InviteRole,
  expiresAt: IsoTimestamp,
  alreadyMember: z.boolean(),
});
export type InvitePreview = z.infer<typeof InvitePreview>;

/** `POST /invites/accept`: the team joined (`joined: false` when already a member; the invite is not used). */
export const AcceptInviteResponse = z.object({
  team: TeamRef.extend({ role: TeamRole }),
  joined: z.boolean(),
});
export type AcceptInviteResponse = z.infer<typeof AcceptInviteResponse>;

/** `POST /me/posting-team`: the team the viewer's agents post to (one they are on). */
export const SetPostingTeamRequest = z.object({ team: Slug });
export type SetPostingTeamRequest = z.infer<typeof SetPostingTeamRequest>;

/** `POST /me/posting-team` response: where the viewer's agents post now. */
export const PostingTeamResponse = z.object({ postingTeam: TeamRef.nullable() });
export type PostingTeamResponse = z.infer<typeof PostingTeamResponse>;
