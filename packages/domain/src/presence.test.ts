import { describe, expect, it } from 'vitest';
import { PULSE_ACTIVE_EVERY_S, PULSE_MAX_WAIT_S } from '@y/schema';
import {
  LEASE_STALE_MS,
  PRESENCE_INGEST_LIVE_WINDOW_MS,
  PRESENCE_LISTENING_WINDOW_DOORBELL_MS,
  PRESENCE_LISTENING_WINDOW_MS,
  PRESENCE_LIVE_WINDOW_MS,
  PRESENCE_SWEEP_EVERY_MS,
  presenceWindows,
  recurringSlot,
} from './index.js';

describe('presence windows', () => {
  it('pins the thresholds', () => {
    expect(PRESENCE_LIVE_WINDOW_MS).toBe(150_000);
    expect(PRESENCE_INGEST_LIVE_WINDOW_MS).toBe(600_000);
    expect(PRESENCE_LISTENING_WINDOW_MS).toBe(LEASE_STALE_MS);
    expect(PRESENCE_LISTENING_WINDOW_DOORBELL_MS).toBe(630_000);
    expect(PRESENCE_SWEEP_EVERY_MS).toBe(60_000);
  });

  it('covers two missed heartbeats in each listener mode', () => {
    // Active turns: a report at least every PULSE_ACTIVE_EVERY_S in every transport.
    expect(PRESENCE_LIVE_WINDOW_MS).toBeGreaterThan(2 * PULSE_ACTIVE_EVERY_S * 1000);
    // Long-poll: ≤ 25 s per poll. Doorbell: a safety poll every 300 s.
    expect(PRESENCE_LISTENING_WINDOW_MS).toBeGreaterThan(2 * PULSE_MAX_WAIT_S * 1000);
    expect(PRESENCE_LISTENING_WINDOW_DOORBELL_MS).toBeGreaterThan(2 * 300_000);
  });

  it('picks the listening window by listener transport, not core mode', () => {
    expect(presenceWindows({ doorbell: false })).toEqual({ liveMs: 150_000, ingestLiveMs: 600_000, listeningMs: 70_000 });
    expect(presenceWindows({ doorbell: true })).toEqual({ liveMs: 150_000, ingestLiveMs: 600_000, listeningMs: 630_000 });
  });
});

describe('recurringSlot', () => {
  const MIN = 60_000;
  it('lands 5 s before the next boundary so the tick at that boundary sees it due', () => {
    // A cron tick at :00.3 arms the next run: due at :55, picked up by the :60 tick.
    expect(recurringSlot(10 * MIN + 300, MIN)).toEqual({ slot: 11, runAfterMs: MIN - 300 - 5_000 });
  });

  it('a job running just before its boundary re-arms for the following one (a new dedupe slot)', () => {
    const ranAt = 11 * MIN - 5_000; // slot 11 ran at :55
    const next = recurringSlot(ranAt, MIN);
    expect(next.slot).toBe(12);
    expect(ranAt + next.runAfterMs).toBe(12 * MIN - 5_000);
    // The tick at the boundary re-arms the same slot (deduped), not another one.
    expect(recurringSlot(11 * MIN + 400, MIN).slot).toBe(12);
  });

  it('works for longer periods', () => {
    const r = recurringSlot(3 * 5 * MIN + 1_000, 5 * MIN);
    expect(r.slot).toBe(4);
    expect(r.runAfterMs).toBe(5 * MIN - 1_000 - 5_000);
  });
});
