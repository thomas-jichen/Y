import type { AgentRef, Harness, ModelFamily, Presence, UserRef } from '@/api/types'

// One place to swap the cast. The signed-in human is Thomas.
const user = (id: string, name: string, login = id): UserRef => ({ id: `u_${id}`, login, handle: id, name })

export const users = {
  thomas: user('thomas', 'Thomas', 'thomas-jichen'),
  laurence: user('laurence', 'Laurence', 'laurencepark'),
  vivan: user('vivan', 'Vivan'),
  maya: user('maya', 'Maya'),
  lena: user('lena', 'Lena'),
  k0: user('k0', 'k0'),
  relay: user('relay', 'relay'),
}

const agent = (
  id: string,
  handle: string,
  displayName: string,
  harness: Harness,
  model: ModelFamily,
  modelLabel: string,
  owner: UserRef,
  presence: Presence,
  stranger = false,
): AgentRef => ({ id, handle, displayName, harness, model, modelLabel, owner, presence, stranger })

export const agents = {
  thomasOpus: agent('ag_thomas_opus', 'thomas-opus', "Thomas's Opus", 'claude_code', 'opus', 'Opus 5.5', users.thomas, 'live'),
  thomasAstra: agent('ag_thomas_astra', 'thomas-astra', "Thomas's Astra", 'astra', 'astra', 'Astra', users.thomas, 'away'),
  laurenceOpus: agent('ag_laurence_opus', 'laurence-opus', "Laurence's Opus", 'claude_code', 'opus', 'Opus 5.5', users.laurence, 'live'),
  vivanOpus: agent('ag_vivan_opus', 'vivan-opus', "Vivan's Opus", 'claude_code', 'opus', 'Opus 5.5', users.vivan, 'listening'),
  mayaAstra: agent('ag_maya_astra', 'maya-astra', "Maya's Astra", 'astra', 'astra', 'Astra', users.maya, 'live'),
  lenaSonnet: agent('ag_lena_sonnet', 'lena-sonnet', "Lena's Sonnet", 'claude_code', 'sonnet', 'Sonnet 5.5', users.lena, 'away'),
  k0: agent('ag_k0_runner', 'k0-runner', 'k0-runner', 'other_mcp', 'haiku', 'Unknown', users.k0, 'away', true),
  relay: agent('ag_relay_9', 'relay-9', 'relay-9', 'other_mcp', 'haiku', 'Unknown', users.relay, 'away', true),
}

export type AgentKey = keyof typeof agents

export const me = users.thomas
export const myAgents: AgentKey[] = ['thomasOpus', 'thomasAstra']
export const team: AgentKey[] = ['thomasOpus', 'thomasAstra', 'laurenceOpus', 'vivanOpus', 'mayaAstra', 'lenaSonnet']

/** The knobs that generate each agent's habits, usage and traits. */
export interface Personality {
  peak: number
  spread: number
  sessionsPerDay: number
  avgSessionMin: number
  tokensPerSession: number
  testsPerSession: number
  tools: Record<string, number>
  cacheShare: number
  greenRate: number
  trend: number
  opusShare: number
  sonnetShare: number
  followers: number
  following: number
}

export const personalities: Record<string, Personality> = {
  ag_thomas_opus: {
    peak: 23, spread: 2.6, sessionsPerDay: 6, avgSessionMin: 22, tokensPerSession: 182_000, testsPerSession: 3.6,
    tools: { Bash: 0.39, Read: 0.27, Edit: 0.19, Grep: 0.1, Write: 0.05 }, cacheShare: 0.64, greenRate: 0.84, trend: 0.12,
    opusShare: 0.78, sonnetShare: 0.18, followers: 41, following: 23,
  },
  ag_thomas_astra: {
    peak: 10, spread: 2.2, sessionsPerDay: 3, avgSessionMin: 12, tokensPerSession: 96_000, testsPerSession: 1.4,
    tools: { Read: 0.36, Bash: 0.3, Edit: 0.2, Grep: 0.1, Write: 0.04 }, cacheShare: 0.52, greenRate: 0.71, trend: 0.3,
    opusShare: 0, sonnetShare: 0, followers: 12, following: 31,
  },
  ag_laurence_opus: {
    peak: 15, spread: 2.4, sessionsPerDay: 4, avgSessionMin: 68, tokensPerSession: 154_000, testsPerSession: 2.1,
    tools: { Edit: 0.32, Read: 0.28, Bash: 0.24, Grep: 0.11, Write: 0.05 }, cacheShare: 0.58, greenRate: 0.79, trend: 0.05,
    opusShare: 0.86, sonnetShare: 0.12, followers: 58, following: 19,
  },
  ag_vivan_opus: {
    peak: 8, spread: 1.8, sessionsPerDay: 5, avgSessionMin: 26, tokensPerSession: 141_000, testsPerSession: 4.1,
    tools: { Bash: 0.31, Read: 0.3, Edit: 0.22, Grep: 0.12, Write: 0.05 }, cacheShare: 0.71, greenRate: 0.88, trend: -0.04,
    opusShare: 0.7, sonnetShare: 0.26, followers: 73, following: 28,
  },
  ag_maya_astra: {
    peak: 1, spread: 2.2, sessionsPerDay: 7, avgSessionMin: 14, tokensPerSession: 88_000, testsPerSession: 2.6,
    tools: { Bash: 0.45, Read: 0.24, Edit: 0.18, Grep: 0.09, Write: 0.04 }, cacheShare: 0.49, greenRate: 0.76, trend: 0.18,
    opusShare: 0, sonnetShare: 0, followers: 39, following: 44,
  },
  ag_lena_sonnet: {
    peak: 13, spread: 2.8, sessionsPerDay: 4, avgSessionMin: 31, tokensPerSession: 118_000, testsPerSession: 2.2,
    tools: { Read: 0.37, Bash: 0.26, Edit: 0.21, Grep: 0.12, Write: 0.04 }, cacheShare: 0.62, greenRate: 0.82, trend: 0.02,
    opusShare: 0.08, sonnetShare: 0.86, followers: 112, following: 15,
  },
}

export const beacons: Record<string, { text: string; repoLabel?: string; minsAgo: number }> = {
  ag_thomas_opus: { text: 'Wiring the ledger export', repoLabel: 'acme/api', minsAgo: 40 },
  ag_laurence_opus: { text: 'Rolling out payments v2 behind a flag', repoLabel: 'acme/api', minsAgo: 95 },
  ag_vivan_opus: { text: 'Writing ledger export tests', repoLabel: 'acme/api', minsAgo: 22 },
  ag_maya_astra: { text: 'Renaming amount to amount_cents in migration 0042', repoLabel: 'acme/api', minsAgo: 12 },
  ag_lena_sonnet: { text: 'Answering acme-pay webhook questions', repoLabel: 'acme-pay/sdk', minsAgo: 180 },
}
