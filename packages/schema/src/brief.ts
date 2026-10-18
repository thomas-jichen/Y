/**
 * `GET /api/v1/agent/brief`: what the SessionStart hook fetches (PLAN §6).
 * Token state, minimum plugin version, kill switches, pointers to print,
 * a pulse token for the listener, the agent's realtime channel, the
 * effective share and distill policy, and the public list of claimed
 * packages for local P7 matching. Hook REST, so camelCase (the embedded
 * pointers are the snake_case `Pointer` contract).
 *
 * @module brief
 */
import { z } from 'zod';
import {
  AgentId,
  Count,
  Handle,
  Harness,
  IsoTimestamp,
  KillSwitches,
  PackageName,
  ProductId,
  Semver,
  ShareMode,
  TeamId,
  WakeOnDm,
} from './common.js';
import { RealtimeChannel } from './hosting.js';
import { Pointer } from './pointers.js';

/** State of the install token presented by the hook. */
export const TokenState = z.enum(['ok', 'revoked', 'expired', 'unknown_install']);
export type TokenState = z.infer<typeof TokenState>;

/** Short-lived bearer for `/api/v1/pulse` (the listener uses it instead of the install token). */
export const PulseToken = z.object({
  token: z.string().regex(/^[A-Za-z0-9_.-]{16,2048}$/),
  expiresAt: IsoTimestamp,
});
export type PulseToken = z.infer<typeof PulseToken>;

/**
 * Where a closed segment is distilled:
 * - `local` (default, zero-cost): the client runs Stage A/B with the user's
 *   own subscription (`PACELINE_CHILD=1 claude -p --safe-mode --model haiku
 *   --no-session-persistence --tools "" --output-format json --json-schema …`)
 *   and uploads `IngestChunk.distilled`; the digest text stays on the machine;
 * - `server`: the client uploads the redacted digest and the worker distills
 *   (only offered when core has `ANTHROPIC_API_KEY`);
 * - `off`: stats and setup cards only.
 */
export const DistillerMode = z.enum(['local', 'server', 'off']);
export type DistillerMode = z.infer<typeof DistillerMode>;

/**
 * Effective capture/share policy for this agent (team policy file accepted by
 * the member + personal settings + what the server offers).
 * `repoKeySalt` is the salt of `teamId` (the team this agent posts to) used
 * to compute `repoKey` locally; both are absent until the agent belongs to a
 * team. Sources: `team_secrets.repo_key_salt`, `team_members`,
 * `team_policies`, `agent_settings.wake_on_dm`; `distiller` from the plugin
 * setting capped by server capability.
 */
export const BriefPolicy = z.object({
  shareMode: ShareMode,
  holdMinutes: z.int().min(0).max(1440),
  capture: z.enum(['on', 'off']),
  wakeOnDm: WakeOnDm,
  policyAccepted: z.boolean(),
  distiller: DistillerMode,
  teamId: TeamId.optional(),
  repoKeySalt: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/).optional(),
});
export type BriefPolicy = z.infer<typeof BriefPolicy>;

/** A package with a verified builder claim (public list). */
export const ClaimedPackage = z.object({
  ecosystem: z.enum(['npm', 'pypi', 'github']),
  name: PackageName,
  productId: ProductId,
});
export type ClaimedPackage = z.infer<typeof ClaimedPackage>;

/**
 * A notice for the **human** (SessionStart `systemMessage`), rendered from a
 * fixed local sentence per kind. `url` must be on the configured Paceline
 * host; the hook drops notices whose URL host differs.
 */
export const HumanNotice = z.object({
  kind: z.enum([
    'drafts_pending',
    'reviews_pending',
    'token_revoked',
    'token_expired',
    'unknown_install',
    'upgrade_required',
    'policy_pending',
    'doctor_recommended',
  ]),
  count: Count.optional(),
  url: z.url(),
});
export type HumanNotice = z.infer<typeof HumanNotice>;

/**
 * The brief. When `tokenState !== 'ok'`, `agent`, `pulseToken` and
 * `realtime` are absent, `pointers` is empty and `humanNotices` explains
 * what to do. `realtime` is the agent's broadcast channel: with provider
 * `supabase` the listener subscribes to it (one connection per listening
 * plugin); with `local` it long-polls `/api/v1/pulse` instead.
 */
export const AgentBrief = z
  .object({
    v: z.literal(1),
    tokenState: TokenState,
    agent: z.object({ id: AgentId, handle: Handle, harness: Harness }).optional(),
    minPluginVersion: Semver,
    killSwitches: KillSwitches,
    pointers: z.array(Pointer).max(10),
    pulseToken: PulseToken.optional(),
    realtime: RealtimeChannel.optional(),
    policy: BriefPolicy,
    claimedPackages: z.array(ClaimedPackage).max(20_000).optional(),
    /** Version tag of the claimed-packages list; send back as `claimsEtag` to skip an unchanged list. */
    claimsEtag: z.string().max(128).optional(),
    humanNotices: z.array(HumanNotice).max(5),
    serverTime: IsoTimestamp,
  })
  .superRefine((b, ctx) => {
    if (b.tokenState === 'ok') {
      if (!b.agent) ctx.addIssue({ code: 'custom', path: ['agent'], message: 'required when tokenState is ok' });
      if (!b.pulseToken) ctx.addIssue({ code: 'custom', path: ['pulseToken'], message: 'required when tokenState is ok' });
    } else {
      if (b.pointers.length > 0) {
        ctx.addIssue({ code: 'custom', path: ['pointers'], message: 'must be empty unless tokenState is ok' });
      }
      if (b.realtime) {
        ctx.addIssue({ code: 'custom', path: ['realtime'], message: 'must be absent unless tokenState is ok' });
      }
    }
    if (b.policy.repoKeySalt !== undefined && b.policy.teamId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['policy', 'teamId'], message: 'required with repoKeySalt' });
    }
  });
export type AgentBrief = z.infer<typeof AgentBrief>;

/** Query for the brief. */
export const AgentBriefQuery = z.object({
  pluginVersion: Semver,
  harnessVersion: z.string().max(40).optional(),
  sessionId: z.string().max(128).optional(),
  /** ETag of the claimed-packages list the client already has; omitted from the response when unchanged. */
  claimsEtag: z.string().max(128).optional(),
});
export type AgentBriefQuery = z.infer<typeof AgentBriefQuery>;
