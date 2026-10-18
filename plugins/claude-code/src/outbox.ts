/**
 * The local outbox: already-redacted `IngestChunk` files, FIFO by file name
 * (`<ts13>-<sid>-<seq6>.json`), written atomically (tmp → rename).
 *
 * Capped at {@link OUTBOX_CAP_BYTES} (PLAN §6, pending + dead together): over
 * the cap, the oldest dead-lettered chunks are deleted first; if that is not
 * enough, new chunks are written stats-only (no digest, episodes or setup
 * snapshot), so stats keep queueing for offline catch-up while text at rest
 * stops growing.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IngestChunk } from '@y/schema/ingest';
import { safeSid, writeJsonAtomic, type Paths } from './runtime.js';

export const OUTBOX_CAP_BYTES = 50 * 1024 * 1024;

export function chunkFileName(ts: number, sid: string, seq: number): string {
  return `${String(ts).padStart(13, '0')}-${safeSid(sid)}-${String(seq).padStart(6, '0')}.json`;
}

function jsonFiles(dir: string): { file: string; size: number }[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
      .sort()
      .flatMap((f) => {
        const file = path.join(dir, f);
        try {
          return [{ file, size: fs.statSync(file).size }];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** Bytes held by pending and dead-lettered chunks. */
export function outboxBytes(p: Paths): number {
  return [...jsonFiles(p.outbox), ...jsonFiles(p.dead)].reduce((n, f) => n + f.size, 0);
}

/** The chunk without its text parts (what the Stop hook's stats-only fallback sends). */
export function statsOnly(chunk: IngestChunk): IngestChunk {
  const { digest: _d, setup, ...rest } = chunk;
  return { ...rest, errorEpisodes: [], ...(setup ? { setup: { hash: setup.hash } } : {}) };
}

export function writeChunk(p: Paths, chunk: IngestChunk, now: number, capBytes: number = OUTBOX_CAP_BYTES): string {
  const file = path.join(p.outbox, chunkFileName(now, chunk.sessionId, chunk.seq));
  let out = chunk;
  let used = outboxBytes(p);
  if (used > capBytes) {
    // Oldest dead-lettered chunks go first: at most a few 5xx ones would ever be re-driven.
    for (const d of jsonFiles(p.dead)) {
      if (used <= capBytes) break;
      try {
        fs.rmSync(d.file, { force: true });
        fs.rmSync(path.join(p.outbox, '.dead-meta', path.basename(d.file)), { force: true });
        used -= d.size;
      } catch {
        /* best effort */
      }
    }
    if (used > capBytes) out = statsOnly(chunk);
  }
  writeJsonAtomic(file, out);
  return file;
}

/** Pending chunk files, oldest first. */
export function listChunks(p: Paths): string[] {
  try {
    return fs
      .readdirSync(p.outbox)
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
      .sort()
      .map((f) => path.join(p.outbox, f));
  } catch {
    return [];
  }
}
