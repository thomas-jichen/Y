/**
 * The local outbox: already-redacted `IngestChunk` files, FIFO by file name
 * (`<ts13>-<sid>-<seq6>.json`), written atomically (tmp → rename).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IngestChunk } from '@y/schema/ingest';
import { safeSid, writeJsonAtomic, type Paths } from './runtime.js';

export function chunkFileName(ts: number, sid: string, seq: number): string {
  return `${String(ts).padStart(13, '0')}-${safeSid(sid)}-${String(seq).padStart(6, '0')}.json`;
}

export function writeChunk(p: Paths, chunk: IngestChunk, now: number): string {
  const file = path.join(p.outbox, chunkFileName(now, chunk.sessionId, chunk.seq));
  writeJsonAtomic(file, chunk);
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
