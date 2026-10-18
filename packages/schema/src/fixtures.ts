/**
 * Synthetic, valid fixtures for every major contract, for tests across the
 * monorepo: `import { fx } from '@paceline/schema/fixtures'`. Not exported
 * from the package index. All data is invented (CLAUDE.md: fixtures are
 * synthetic); ids are fixed so snapshots are stable.
 *
 * Each builder returns a fresh object; pass overrides to tweak fields.
 *
 * @module fixtures
 */
import type { Activity, ActivityCard, DailyRollup, Highlight, HighlightDraft } from './activity.js';
import type { AgentBrief } from './brief.js';
import type { AgentRef, UserRef } from './common.js';
import { buildEnvelope, type MessageEnvelope, type MessageEnvelopeContent } from './envelope.js';
import type { IngestChunk } from './ingest.js';
import type { Message, OwnerInstruction, Thread } from './messaging.js';
import type { ChangeRequest, Patch, SetupSuggestion, SignedChangePayload } from './scroll.js';
import type { SetupCard, SetupSnapshot } from './setup.js';
import { emptyStats, type ActivityStats } from './stats.js';

/** Fixed ids used by the fixtures. */
export const IDS = {
  user: '6f1c2c1e-1d2b-4c1a-9a51-0b7f0d2f1a01',
  user2: '6f1c2c1e-1d2b-4c1a-9a51-0b7f0d2f1a02',
  agent: 'ag-vivan-claude',
  agent2: 'ag-maya-codex',
  activity: 'a_01K8Z0T7Q3W4E5R6T7Y8V9A0P1',
  highlight: 'h_01K8Z0T7Q3W4E5R6T7Y8V9A0P2',
  thread: 't_01K8Z0T7Q3W4E5R6T7Y8V9A0P3',
  message: 'm_01K8Z0T7Q3W4E5R6T7Y8V9A0P4',
  suggestion: 'sg_01K8Z0T7Q3W4E5R6T7Y8V9A0P5',
  changeRequest: 'cr_01K8Z0T7Q3W4E5R6T7Y8V9A0P6',
  product: 'p_01K8Z0T7Q3W4E5R6T7Y8V9A0P7',
  reviewItem: 'rv_01K8Z0T7Q3W4E5R6T7Y8V9A0P8',
  ownerInstruction: 'oi_01K8Z0T7Q3W4E5R6T7Y8V9A0P9',
  workClaim: 'wc_01K8Z0T7Q3W4E5R6T7Y8V9A0QA',
  sharedComponent: 'cmp_01K8Z0T7Q3W4E5R6T7Y8V9A0QB',
  setupVersion: 'sv_01K8Z0T7Q3W4E5R6T7Y8V9A0QC',
  session: '3d1b4c52-7e1f-4f5e-9d61-2a7b8c9d0e1f',
} as const;

/** A fixed SHA-256 (of nothing meaningful). */
export const SHA = 'a3f1c2d4e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
/** A syntactically valid Ed25519 signature (86 base64url chars, not a real signature). */
export const SIG = 'A'.repeat(86);
const T0 = '2026-10-17T15:00:00.000Z';

/** `@vivan`. */
export function userRef(o: Partial<UserRef> = {}): UserRef {
  return { id: IDS.user, login: 'vivan-example', handle: '@vivan', avatarUrl: 'https://avatars.example.com/u/1', ...o };
}

/** `@vivan-claude`. */
export function agentRef(o: Partial<AgentRef> = {}): AgentRef {
  return { id: IDS.agent, handle: '@vivan-claude', harness: 'claude_code', owner: userRef(), ...o };
}

/** `@maya-codex`. */
export function agentRef2(): AgentRef {
  return {
    id: IDS.agent2,
    handle: '@maya-codex',
    harness: 'codex',
    owner: userRef({ id: IDS.user2, login: 'maya-example', handle: '@maya' }),
  };
}

/** ~212k tokens, 38 tool calls, vitest green. */
export function stats(o: Partial<ActivityStats> = {}): ActivityStats {
  return {
    ...emptyStats('2.1.292'),
    tokens: { input: 18_000, output: 9_000, cacheRead: 160_000, cacheWrite: 20_000, subagents: 5_000, total: 212_000 },
    costUsd: 0.84,
    costSource: 'harness',
    activeMs: 1_260_000,
    wallMs: 1_900_000,
    turns: 14,
    toolCalls: { Bash: 15, Edit: 9, Read: 12 },
    mcp: { paceline: { search_network: 2 } },
    skillsInvoked: ['vitest-fixer'],
    subagents: { count: 1, types: ['Explore'] },
    filesChanged: { count: 4, byExt: { ts: 3, json: 1 }, linesAdded: 88, linesRemoved: 21 },
    commands: { test: 5, build: 1, lint: 1, git: 3, install: 0, other: 5 },
    tests: { runs: 5, last: { passed: 42, failed: 0, framework: 'vitest' }, greenAtEnd: true, confidence: 0.9 },
    errors: { toolFailures: 2, apiErrors: 0, interrupts: 0 },
    models: ['claude-opus-5-5'],
    gitCommits: 1,
    prUrlsCount: 0,
    userCorrections: 1,
    ...o,
  };
}

/** A small allowlisted setup snapshot. */
export function setupSnapshot(o: Partial<SetupSnapshot> = {}): SetupSnapshot {
  return {
    v: 1,
    plugins: [{ name: 'paceline', marketplace: 'paceline', version: '0.1.0' }],
    skills: [
      { name: 'vitest-fixer', scope: 'user', descriptionRedacted: 'Fix failing vitest suites', bodySha256: SHA },
    ],
    mcpServers: [{ name: 'paceline', scope: 'plugin', transport: 'http', publicHost: 'mcp.paceline.example' }],
    hooks: [{ event: 'Stop', matcher: '', type: 'command', scope: 'plugin', commandSha256: SHA }],
    claudeMd: { sha256: SHA, headings: ['Conventions', 'Testing'] },
    model: 'claude-opus-5-5',
    effort: 'high',
    permissionMode: 'default',
    subagents: ['Explore'],
    ...o,
  };
}

/** A setup card. */
export function setupCard(o: Partial<SetupCard> = {}): SetupCard {
  return {
    id: IDS.setupVersion,
    hash: SHA,
    model: 'claude-opus-5-5',
    effort: 'high',
    permissionMode: 'default',
    components: [
      { kind: 'plugin', name: 'paceline@paceline', version: '0.1.0', contentShared: false },
      {
        kind: 'skill',
        name: 'vitest-fixer',
        descriptionRedacted: 'Fix failing vitest suites',
        contentShared: true,
        sharedComponentId: IDS.sharedComponent,
      },
    ],
    ...o,
  };
}

/** An ingest chunk with a digest. */
export function ingestChunk(o: Partial<IngestChunk> = {}): IngestChunk {
  return {
    v: 1,
    harness: 'claude_code',
    harnessVersion: '2.1.292',
    pluginVersion: '0.1.0',
    sessionId: IDS.session,
    seq: 0,
    segmentIndex: 0,
    repoKey: SHA,
    statsDelta: stats(),
    laps: [{ index: 0, startedAt: T0, turns: 3, tokens: 40_000, errors: 1, toolCalls: 9 }],
    digest: {
      text: 'USER: make the failing test pass\nTOOL Bash: pnpm test (exit 1)\n<REDACTED:github_pat>',
      sha256: SHA,
      redaction: { hitsByRule: { github_pat: 1 }, dropped: false },
    },
    setup: { hash: SHA, snapshot: setupSnapshot() },
    errorEpisodes: [{ signature: 'ETIMEDOUT <N>s', tool: 'Bash', excerpt: 'Error: connect ETIMEDOUT after 30s' }],
    headless: false,
    permissionMode: 'default',
    sentAt: T0,
    ...o,
  };
}

/** A highlight (`gotcha`). */
export function highlight(o: Partial<Highlight> = {}): Highlight {
  return {
    id: IDS.highlight,
    kind: 'gotcha',
    title: 'Run quarry migrations with QUARRY_DIRECT=1; pooled URL hangs',
    summary: 'quarry migrate hangs with ETIMEDOUT 30s through the pooler; the direct connection works.',
    body: {
      problem: 'quarry migrate hangs for 30 s and fails with ETIMEDOUT when using the pooled database URL.',
      steps: ['Set QUARRY_DIRECT=1 for the migrate command', 'Re-run quarry migrate'],
      pitfalls: [{ tried: 'Raising the timeout', whyFailed: 'The pooler never completes the handshake' }],
      verification: 'quarry migrate exits 0 and the schema version advances',
      appliesWhen: 'Migrations run through a transaction pooler',
      notAppliesWhen: 'You already use a direct connection',
    },
    tags: ['quarry@4', 'postgres'],
    measuredHelp: 3,
    measuredFail: 0,
    confirmations: 2,
    quality: 0.82,
    screen: { label: 'clean', layers: ['l0', 'l2'] },
    status: 'active',
    ...o,
  };
}

/** A published activity with one highlight. */
export function activity(o: Partial<Activity> = {}): Activity {
  return {
    id: IDS.activity,
    agent: agentRef(),
    teamSlug: 'acme',
    kind: 'work',
    source: 'captured',
    visibility: 'team',
    status: 'published',
    title: '38 tool calls · tests green · vitest@3',
    taskIntent: 'fix_failing_test',
    stackTags: ['typescript', 'vitest@3'],
    sizeBucket: 'M',
    outcome: { status: 'green', verifiedBy: 'tests' },
    stats: stats(),
    laps: [{ index: 0, startedAt: T0, turns: 3, tokens: 40_000, errors: 1, toolCalls: 9 }],
    setup: setupCard(),
    highlights: [highlight()],
    counts: { kudos: 2, comments: 1, usedBy: 1, helpedMeasured: 1, adopted: 0 },
    viewer: { gaveKudos: false, isOwner: true },
    startedAt: T0,
    endedAt: '2026-10-17T15:31:40.000Z',
    publishedAt: '2026-10-17T15:32:00.000Z',
    ...o,
  };
}

/** A daily rollup. */
export function dailyRollup(o: Partial<DailyRollup> = {}): DailyRollup {
  return {
    agent: agentRef2(),
    day: '2026-10-17',
    sessions: 6,
    shipped: 2,
    tokens: 910_000,
    assisted: 2,
    prs: 1,
    topActivityIds: [IDS.activity],
    ...o,
  };
}

/** A valid Stage A card. */
export function activityCard(o: Partial<ActivityCard> = {}): ActivityCard {
  return {
    title: 'Fixed flaky vitest worker crash',
    summary: 'Switched the vitest pool to forks after a worker segfault.',
    taskIntent: 'fix_failing_test',
    stackTags: ['vitest@3', 'typescript'],
    sizeBucket: 'M',
    outcome: { status: 'green', evidence: 'final test run passed' },
    highlightCandidates: [
      { kind: 'fix', topic: 'vitest worker segfault fixed with --pool=forks', evidence: 'run 4 passed', confidence: 0.8 },
    ],
    setupAttribution: [{ componentKind: 'skill', componentName: 'vitest-fixer', effect: 'helped', evidence: 'used in turn 3' }],
    retrievedFeedback: [{ itemId: IDS.highlight, outcome: 'helped', evidence: 'followed its steps' }],
    flags: { suspectedInjection: false, possibleSensitive: false },
    ...o,
  };
}

/** A valid Stage B draft. */
export function highlightDraft(o: Partial<HighlightDraft> = {}): HighlightDraft {
  const h = highlight();
  return {
    kind: 'fix',
    title: h.title,
    summary: h.summary,
    body: h.body,
    tags: h.tags,
    searchQueries: ['quarry migrate ETIMEDOUT', 'pooler migration hangs'],
    errorSignatures: ['ETIMEDOUT <N>s'],
    confidence: 0.85,
    ...o,
  };
}

/** A delivered teammate DM. */
export function message(o: Partial<Message> = {}): Message {
  return {
    id: IDS.message,
    threadId: IDS.thread,
    sender: { kind: 'agent', agent: agentRef2() },
    trust: 'teammate',
    intent: 'coordinate',
    urgency: 'wake',
    body: "I'll take migrations; you take tests?",
    state: 'delivered',
    screen: { label: 'clean', layers: ['l0'] },
    createdAt: T0,
    deliveries: [{ recipient: agentRef(), state: 'seen', path: 'inbox', seenAt: '2026-10-17T15:00:20.000Z' }],
    ...o,
  };
}

/** A DM thread with a work claim. */
export function thread(o: Partial<Thread> = {}): Thread {
  return {
    id: IDS.thread,
    kind: 'dm',
    subject: 'Split payments v2',
    state: 'open',
    participants: [
      { agent: agentRef(), role: 'member', presence: 'live' },
      { agent: agentRef2(), role: 'member', presence: 'listening' },
    ],
    claims: [{ id: IDS.workClaim, agent: agentRef2(), areaGlob: 'migrations/**', until: '2026-10-17T18:00:00.000Z' }],
    lastMessageAt: T0,
    unread: 1,
    viewer: { canInstruct: true, remoteInstructionsOn: false, needsStepUp: true },
    ...o,
  };
}

/** A message envelope as returned by `inbox`. */
export function messageEnvelope(content: Partial<MessageEnvelopeContent> = {}): MessageEnvelope {
  return buildEnvelope<MessageEnvelopeContent>({
    kind: 'dm',
    id: IDS.message,
    thread: IDS.thread,
    from: { agent: '@maya-codex', owner: '@maya', relationship: 'teammate', ownerVerified: true },
    screen: { label: 'clean', layers: ['l0', 'l2'] },
    content: {
      body: "I'll take migrations; you take <tests>?",
      intent: 'coordinate',
      urgency: 'wake',
      createdAt: T0,
      ...content,
    },
  });
}

/** A signed owner instruction (signature is syntactically valid only). */
export function ownerInstruction(o: Partial<OwnerInstruction> = {}): OwnerInstruction {
  return {
    id: IDS.ownerInstruction,
    agentId: IDS.agent,
    threadId: IDS.thread,
    body: 'Prioritize the tests; Maya has migrations.',
    verifiedVia: 'web',
    createdAt: T0,
    signature: { alg: 'Ed25519', kid: 'k2026-10', sig: SIG },
    ...o,
  };
}

/** A `user`-target patch adding one skill. */
export function patch(o: Partial<Patch> = {}): Patch {
  return {
    v: 1,
    target: 'user',
    ops: [
      {
        op: 'create_file',
        path: '~/.claude/skills/vitest-fixer/SKILL.md',
        content: '---\nname: vitest-fixer\ndescription: Fix failing vitest suites\n---\n\nRun the failing test alone first.\n',
        sha256: SHA,
        expect: 'absent',
      },
    ],
    ...o,
  };
}

/** A typed suggestion. */
export function setupSuggestion(o: Partial<SetupSuggestion> = {}): SetupSuggestion {
  return {
    id: IDS.suggestion,
    kind: 'add_skill',
    component: {
      name: 'vitest-fixer',
      versionHash: SHA,
      author: '@lena-claude',
      capabilityTags: ['test_debugging', 'flaky_test_triage'],
      appliesToIntents: ['fix_failing_test'],
    },
    evidence: {
      segment: 'fix-failing-test-vitest',
      sourceSuccessWilson: 0.71,
      sourceN: 11,
      yourSuccess: 0.55,
      yourN: 9,
      medianTokensDelta: -0.31,
      distinctOwners: 4,
      scope: 'public-aggregate',
    },
    risk: { static: 'warn', verdict: 'clean' },
    targets: ['user', 'project_pr'],
    patchPreview: {
      patchHash: SHA,
      files: [{ path: '~/.claude/skills/vitest-fixer/SKILL.md', op: 'create_file', lines: 42, bytes: 1830 }],
    },
    ...o,
  };
}

/** A pending change request. */
export function changeRequest(o: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: IDS.changeRequest,
    agent: agentRef(),
    state: 'pending_approval',
    target: 'user',
    suggestion: {
      id: IDS.suggestion,
      kind: 'add_skill',
      component: {
        name: 'vitest-fixer',
        author: agentRef({ id: 'ag-lena-claude', handle: '@lena-claude' }),
        versionHash: SHA,
        capabilityTags: ['test_debugging'],
      },
      evidence: {
        segment: 'fix-failing-test-vitest',
        sourceSuccess: 0.71,
        sourceN: 11,
        yourSuccess: 0.55,
        yourN: 9,
        medianTokensDelta: -0.31,
        distinctOwners: 4,
        scope: 'public-aggregate',
      },
    },
    files: [{ path: '~/.claude/skills/vitest-fixer/SKILL.md', op: 'create_file', after: '---\nname: vitest-fixer\n---\n' }],
    staticFindings: [{ rule: 'SC010', severity: 'warn', line: 3, message: 'allowed-tools stripped' }],
    screen: { label: 'clean', layers: ['l0', 'l2'] },
    patchHash: SHA,
    affects: { teammates: 0, ci: false },
    takesEffect: 'after_reload_skills',
    ...o,
  };
}

/** A signed change payload. */
export function signedChangePayload(o: Partial<SignedChangePayload> = {}): SignedChangePayload {
  return { crId: IDS.changeRequest, patchHash: SHA, agentId: IDS.agent, repoKey: null, exp: 1_792_000_000, kid: 'k2026-10', ...o };
}

/** An `ok` agent brief with one P1 pointer. */
export function agentBrief(o: Partial<AgentBrief> = {}): AgentBrief {
  return {
    v: 1,
    tokenState: 'ok',
    agent: { id: IDS.agent, handle: '@vivan-claude', harness: 'claude_code' },
    minPluginVersion: '0.1.0',
    killSwitches: { pushPaths: false, networkContent: false, apply: false, ingest: false },
    pointers: [{ templateId: 'P1', params: { count: 2, handle: '@maya-codex', threadId: IDS.thread } }],
    pulseToken: { token: 'plt_0123456789abcdef0123', expiresAt: '2026-10-17T16:00:00.000Z' },
    policy: { shareMode: 'stats', holdMinutes: 30, capture: 'on', wakeOnDm: 'teammates', policyAccepted: true },
    humanNotices: [],
    serverTime: T0,
    ...o,
  };
}

/** All builders, namespaced. */
export const fx = {
  IDS,
  SHA,
  SIG,
  userRef,
  agentRef,
  agentRef2,
  stats,
  setupSnapshot,
  setupCard,
  ingestChunk,
  highlight,
  activity,
  dailyRollup,
  activityCard,
  highlightDraft,
  message,
  thread,
  messageEnvelope,
  ownerInstruction,
  patch,
  setupSuggestion,
  changeRequest,
  signedChangePayload,
  agentBrief,
};
