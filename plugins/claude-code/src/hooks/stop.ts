/**
 * Stop (async): read the transcript from the byte cursor (main + subagent
 * files), build a stats delta, laps and a digest delta, redact (pass 1),
 * write one outbox chunk atomically, then spawn the uploader detached.
 * Capture off (or no brief yet) → stats-only chunk with no digest/episodes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildDigest,
  buildLaps,
  computeRepoKey,
  computeStats,
  parseClaudeRecords,
  readTranscriptDelta,
  snapshotSetup,
  type ClaudeRecord,
  type TranscriptCursor,
} from '@y/capture';
import { canonicalJson } from '@y/schema/canonical';
import { PermissionMode } from '@y/schema/common';
import { DIGEST_MAX_CHARS, ErrorEpisode, IngestChunk, MAX_ERROR_EPISODES } from '@y/schema/ingest';
import { setupHashInput, type SetupSnapshot } from '@y/schema/setup';
import * as os from 'node:os';
import { failOpen, OK, type HookCtx, type HookResult } from '../context.js';
import { writeChunk } from '../outbox.js';
import { gitRemote, redactText } from '../redaction.js';
import { allocSeq, ensureDir, logLine, PLUGIN_VERSION, readJson, safeSid, sha256Hex, writeJsonAtomic } from '../runtime.js';
import { captureOn, readBrief } from '../state.js';
import { episodesFile } from './post-tool-use-failure.js';

/** `cursors/<sid>.json`. */
interface SessionCursor {
  main?: TranscriptCursor;
  subagents?: Record<string, TranscriptCursor>;
  laps?: number;
  costUsd?: number;
}

const MAX_DELTA_BYTES = 32 * 1024 * 1024;

async function readAll(file: string, cursor: TranscriptCursor | undefined): Promise<{ lines: string[]; cursor: TranscriptCursor }> {
  const lines: string[] = [];
  let cur = cursor;
  let total = 0;
  for (let i = 0; i < 8; i++) {
    const d = await readTranscriptDelta(file, cur ?? null);
    if (d.reset) lines.length = 0;
    lines.push(...d.lines);
    cur = d.cursor;
    total += d.lines.reduce((n, l) => n + l.length + 1, 0);
    if (!d.more || total > MAX_DELTA_BYTES) break;
  }
  return { lines, cursor: cur ?? { offset: 0 } };
}

function subagentFiles(transcript: string, sid: string): string[] {
  const dir = path.join(path.dirname(transcript), sid, 'subagents');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** Take and clear the episodes recorded by PostToolUseFailure since the last chunk. */
function takeEpisodes(ctx: HookCtx, sid: string): ErrorEpisode[] {
  const file = episodesFile(ctx, sid);
  const taken = `${file}.${process.pid}.taking`;
  try {
    fs.renameSync(file, taken);
  } catch {
    return [];
  }
  try {
    return fs
      .readFileSync(taken, 'utf8')
      .split('\n')
      .flatMap((l) => {
        try {
          const v = ErrorEpisode.safeParse(JSON.parse(l));
          return v.success ? [v.data] : [];
        } catch {
          return [];
        }
      })
      .slice(-MAX_ERROR_EPISODES);
  } finally {
    fs.rmSync(taken, { force: true });
  }
}

async function setupRef(ctx: HookCtx, cwd: string | undefined): Promise<IngestChunk['setup'] | undefined> {
  if (!cwd) return undefined;
  try {
    const snapshot: SetupSnapshot = await snapshotSetup({
      projectDir: cwd,
      homeDir: os.homedir(),
      redactText: (t) => redactText(t, cwd).text,
    });
    const hash = sha256Hex(canonicalJson(setupHashInput(snapshot)));
    const sentFile = path.join(ctx.paths.state, 'setup-sent.json');
    const sent = readJson<{ hash?: string }>(sentFile);
    if (sent?.hash === hash) return { hash };
    writeJsonAtomic(sentFile, { hash });
    return { hash, snapshot };
  } catch {
    return undefined;
  }
}

/** Build the chunk for this Stop, or undefined when there's nothing new. Exported for tests. */
export async function buildStopChunk(ctx: HookCtx, sid: string, transcript: string): Promise<IngestChunk | undefined> {
  const cwd = typeof ctx.input.cwd === 'string' ? ctx.input.cwd : undefined;
  const brief = readBrief(ctx.paths);
  const capture = captureOn(brief);
  const curFile = path.join(ctx.paths.cursors, `${safeSid(sid)}.json`);
  const cur = readJson<SessionCursor>(curFile) ?? {};

  const main = await readAll(transcript, cur.main);
  const mainRecords: ClaudeRecord[] = parseClaudeRecords(main.lines).records;
  const subCursors: Record<string, TranscriptCursor> = { ...cur.subagents };
  const subRecords: ClaudeRecord[][] = [];
  for (const f of subagentFiles(transcript, sid)) {
    const d = await readAll(f, subCursors[path.basename(f)]);
    subCursors[path.basename(f)] = d.cursor;
    const recs = parseClaudeRecords(d.lines).records;
    if (recs.length) subRecords.push(recs);
  }
  const episodes = capture ? takeEpisodes(ctx, sid) : [];
  if (mainRecords.length === 0 && subRecords.length === 0 && episodes.length === 0) {
    writeJsonAtomic(curFile, { ...cur, main: main.cursor, subagents: subCursors });
    return undefined;
  }

  const harnessVersion =
    [...mainRecords].reverse().find((r) => typeof r.version === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/.test(r.version))
      ?.version ?? '0';
  const lastCost = [...mainRecords].reverse().find((r) => typeof r.costUsd === 'number')?.costUsd;
  const statsDelta = computeStats(mainRecords, subRecords, { harnessVersion, previousCostUsd: cur.costUsd ?? 0 });
  const lapIndex = cur.laps ?? 0;
  const laps = buildLaps([mainRecords], lapIndex);

  let digest: IngestChunk['digest'];
  if (capture && mainRecords.length > 0) {
    const d = buildDigest(mainRecords, {
      maxTokens: 24_000,
      ...(cwd ? { projectDir: cwd } : {}),
      ...(typeof ctx.input.last_assistant_message === 'string' ? { lastAssistantMessage: ctx.input.last_assistant_message } : {}),
    });
    const r = redactText(d.text, cwd);
    const text = r.dropped ? '' : r.text.slice(0, DIGEST_MAX_CHARS);
    digest = { text, sha256: sha256Hex(text), redaction: { hitsByRule: r.hitsByRule, dropped: r.dropped } };
  }

  let repoKey: string | undefined;
  const salt = brief?.policy?.repoKeySalt;
  const remote = gitRemote(cwd);
  if (capture && salt && remote) {
    try {
      repoKey = computeRepoKey(remote, salt);
    } catch {
      repoKey = undefined;
    }
  }
  const setup = capture ? await setupRef(ctx, cwd) : undefined;
  const pm = PermissionMode.safeParse(ctx.input.permission_mode);

  const base = {
    v: 1 as const,
    harness: 'claude_code' as const,
    harnessVersion,
    pluginVersion: PLUGIN_VERSION,
    sessionId: sid,
    seq: allocSeq(ctx.paths, sid),
    segmentIndex: 0,
    statsDelta,
    errorEpisodes: episodes,
    headless: ctx.config.headless,
    permissionMode: pm.success ? pm.data : ('unknown' as const),
    sentAt: new Date(ctx.now()).toISOString(),
  };
  const full = {
    ...base,
    ...(repoKey ? { repoKey } : {}),
    ...(laps.length ? { laps: laps.slice(0, 50) } : {}),
    ...(digest ? { digest } : {}),
    ...(setup ? { setup } : {}),
  };
  let parsed = IngestChunk.safeParse(full);
  if (!parsed.success) {
    logLine(ctx.config.dataDir, 'hook', `Stop: chunk invalid, retrying stats-only: ${parsed.error.message.slice(0, 300)}`);
    parsed = IngestChunk.safeParse({ ...base, errorEpisodes: [] });
  }
  writeJsonAtomic(curFile, {
    main: main.cursor,
    subagents: subCursors,
    laps: lapIndex + laps.length,
    costUsd: lastCost ?? cur.costUsd ?? 0,
  } satisfies SessionCursor);
  return parsed.success ? parsed.data : undefined;
}

export function stop(ctx: HookCtx): Promise<HookResult> {
  return failOpen(ctx, 'Stop', async () => {
    const sid = typeof ctx.input.session_id === 'string' ? ctx.input.session_id : undefined;
    const transcript = typeof ctx.input.transcript_path === 'string' ? ctx.input.transcript_path : undefined;
    if (!sid || !transcript || ctx.config.shareMode === 'off') return OK;
    // One Stop per session at a time; a skipped Stop is caught up by the next one.
    ensureDir(ctx.paths.cursors);
    const lock = path.join(ctx.paths.cursors, `${safeSid(sid)}.lock`);
    try {
      fs.mkdirSync(lock);
    } catch {
      try {
        if (ctx.now() - fs.statSync(lock).mtimeMs < 60_000) return OK;
        fs.rmSync(lock, { recursive: true, force: true });
        fs.mkdirSync(lock);
      } catch {
        return OK;
      }
    }
    try {
      const chunk = await buildStopChunk(ctx, sid, transcript);
      if (chunk) writeChunk(ctx.paths, chunk, ctx.now());
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
    ctx.spawnDetached('uploader', []);
    return OK;
  });
}
