/**
 * PushBus for serverless mode (Vercel): no LISTEN, no in-process fan-out
 * across instances.
 *
 * - publish: writes `events` rows exactly like PgPushBus (the NOTIFY in the
 *   trigger is harmless; nobody listens).
 * - waitForAgent: polls `events` every second, up to min(timeout, 25 s).
 * - subscribeUser (SSE fallback): one poller per user per instance, every
 *   second, starting at the newest event when the first stream subscribes.
 * - flushRealtime: when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set and
 *   the database cannot broadcast itself (no realtime.send(): the events
 *   trigger already does it on Supabase), POSTs every new event to
 *   `{SUPABASE_URL}/realtime/v1/api/broadcast` on the owner topics from
 *   realtime_channels. A DB cursor (y_private.realtime_cursor) makes
 *   each event go out at most once across instances. Payloads are
 *   RealtimeBroadcast {id, type, payload}: ids/counts only (I3).
 */
import type { Db } from '@y/db';
import type { CoreConfig, PushEvent } from '../contracts.js';
import { PgPushBus, toEvent, type EventRow } from './bus.js';

export const SERVERLESS_MAX_WAIT_MS = 25_000;
export const SERVERLESS_POLL_MS = 1_000;
const FLUSH_BATCH = 500;
const BROADCAST_CHUNK = 100;

type Log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;

export interface ServerlessBusOptions {
  fetch?: typeof fetch;
  pollMs?: number;
  maxWaitMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** An unsubscribe function; `ready` resolves once the subscription's start cursor is fixed. */
export type UserSubscription = (() => void) & { ready?: Promise<void> };
type PollSub = { onEvent: (e: PushEvent) => void; after: number };
type UserPoller = { subs: Set<PollSub>; after: number; started: boolean; ready: Promise<void> };

export class ServerlessPushBus extends PgPushBus {
  private realtime: { url: string; key: string } | null = null;
  private readonly doFetch: typeof fetch;
  private readonly pollMs: number;
  private readonly maxWaitMs: number;

  constructor(
    db: Db,
    log: Log,
    private readonly config: CoreConfig,
    opts: ServerlessBusOptions = {},
  ) {
    super(db, log);
    this.doFetch = opts.fetch ?? globalThis.fetch;
    this.pollMs = opts.pollMs ?? SERVERLESS_POLL_MS;
    this.maxWaitMs = opts.maxWaitMs ?? SERVERLESS_MAX_WAIT_MS;
  }

  /** Read the watermark and decide whether core broadcasts over Realtime REST. No LISTEN. */
  override async start(): Promise<void> {
    const r = await this.db.asService((tx) =>
      tx.query<{ max: string | number | null; has_send: boolean }>(
        `select (select max(id) from public.events) as max,
                exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                         where n.nspname = 'realtime' and p.proname = 'send') as has_send`,
      ),
    );
    this.watermark = Number(r.rows[0]?.max ?? 0);
    const { url, serviceKey } = this.config.supabase;
    const mode = this.config.realtimeRest ?? 'auto';
    const dbBroadcasts = Boolean(r.rows[0]?.has_send);
    if (url && serviceKey && (mode === 'on' || (mode === 'auto' && !dbBroadcasts))) this.realtime = { url, key: serviceKey };
  }

  override async stop(): Promise<void> {}

  /** True when this bus sends Realtime REST broadcasts. */
  get broadcasting(): boolean {
    return this.realtime !== null;
  }

  override async waitForAgent(agentId: string, cursor: string | null, timeoutMs: number): Promise<{ events: PushEvent[]; cursor: string | null }> {
    let after: number;
    if (cursor !== null && /^\d{1,19}$/.test(cursor)) after = Number(cursor);
    else {
      const r = await this.db.asService((tx) => tx.query<{ max: string | number | null }>('select max(id) as max from public.events'));
      after = Number(r.rows[0]?.max ?? 0);
    }
    const deadline = Date.now() + Math.max(0, Math.min(timeoutMs, this.maxWaitMs));
    for (;;) {
      const events = await this.eventsForAgent(agentId, after);
      if (events.length > 0) return { events, cursor: events[events.length - 1]!.id ?? String(after) };
      const left = deadline - Date.now();
      if (left <= 0) return { events: [], cursor: String(after) };
      await sleep(Math.min(this.pollMs, left));
    }
  }

  /**
   * SSE fallback: one poller per user per instance, shared by all of that user's streams (#85), so
   * extra tabs (or a flood of EventSources) add no DB load. A new subscriber starts from the newest
   * event at subscribe time (#87), never from this instance's cold-start watermark, which replayed
   * every older event to each new connection. The returned function carries `ready`, which resolves
   * once that start cursor is fixed: everything committed after it is delivered.
   */
  override subscribeUser(userId: string, onEvent: (e: PushEvent) => void): UserSubscription {
    const sub: PollSub = { onEvent, after: Number.POSITIVE_INFINITY };
    const existing = this.userPollers.get(userId);
    let ready: Promise<void>;
    if (existing) {
      // A started poller has delivered everything up to poller.after: start there (joins are synchronous).
      // Before it starts, the joiner gets the same start cursor as the first subscriber.
      if (existing.started) sub.after = existing.after;
      existing.subs.add(sub);
      ready = existing.ready;
    } else {
      const p: UserPoller = { subs: new Set([sub]), after: 0, started: false, ready: Promise.resolve() };
      this.userPollers.set(userId, p);
      const begin = (max: number) => {
        p.after = max;
        p.started = true;
        for (const s of p.subs) if (s.after === Number.POSITIVE_INFINITY) s.after = max;
      };
      p.ready = this.maxEventId().then(begin, (e) => {
        this.log('warn', 'serverless sse start failed', { err: String(e) });
        begin(this.watermark);
      });
      ready = p.ready;
      void this.runUserPoller(userId, p);
    }
    const unsubscribe = () => {
      const cur = this.userPollers.get(userId);
      if (!cur) return;
      cur.subs.delete(sub);
      if (cur.subs.size === 0) this.userPollers.delete(userId);
    };
    return Object.assign(unsubscribe, { ready });
  }

  /** Concurrent SSE pollers on this instance (one per subscribed user). */
  get userPollerCount(): number {
    return this.userPollers.size;
  }

  private readonly userPollers = new Map<string, UserPoller>();

  private async maxEventId(): Promise<number> {
    const r = await this.db.asService((tx) => tx.query<{ max: string | number | null }>('select max(id) as max from public.events'));
    return Number(r.rows[0]?.max ?? 0);
  }

  private async runUserPoller(userId: string, p: UserPoller): Promise<void> {
    await p.ready;
    const live = () => this.userPollers.get(userId) === p && p.subs.size > 0;
    while (live()) {
      try {
        const r = await this.db.asService((tx) =>
          tx.query<EventRow>(
            `select id, type, to_jsonb(audience_agent_ids) as audience_agent_ids, to_jsonb(audience_user_ids) as audience_user_ids, payload
               from public.events where id > $1 and audience_user_ids @> array[$2::uuid] order by id limit 100`,
            [p.after, userId],
          ),
        );
        for (const row of r.rows) {
          const id = Number(row.id);
          p.after = Math.max(p.after, id);
          const e = toEvent(row);
          for (const s of [...p.subs]) {
            if (id <= s.after || !p.subs.has(s)) continue;
            try {
              s.onEvent(e);
            } catch (err) {
              this.log('warn', 'sse subscriber threw', { err: String(err) });
            }
          }
        }
        if (r.rows.length === 100) continue; // more waiting: no sleep
      } catch (e) {
        this.log('warn', 'serverless sse poll failed', { err: String(e) });
      }
      if (!live()) break;
      await sleep(this.pollMs);
    }
  }

  /** Broadcast events not yet sent by any instance. Returns the number of messages POSTed. */
  async flushRealtime(): Promise<number> {
    const rt = this.realtime;
    if (!rt) return 0;
    const rows = await this.db.asService(async (tx) => {
      const claim = await tx.query<{ prev: string | number; next: string | number }>(
        `with cur as (select last_id from y_private.realtime_cursor where id for update),
              mx as (select coalesce(max(id), 0) as m from public.events)
         update y_private.realtime_cursor r
            set last_id = greatest(cur.last_id, least(mx.m, cur.last_id + $1)), updated_at = now()
           from cur, mx
          where r.id
         returning cur.last_id as prev, r.last_id as next`,
        [FLUSH_BATCH],
      );
      const c = claim.rows[0];
      if (!c || Number(c.next) <= Number(c.prev)) return [];
      const r = await tx.query<{ id: string | number; type: string; payload: Record<string, unknown> | null; topic: string }>(
        `select e.id, e.type, e.payload, c.owner_kind || ':' || c.owner_id::text || ':' || c.secret as topic
           from public.events e
           join public.realtime_channels c
             on (c.owner_kind = 'agent' and c.owner_id = any (e.audience_agent_ids))
             or (c.owner_kind = 'user' and c.owner_id = any (e.audience_user_ids))
          where e.id > $1 and e.id <= $2
          order by e.id`,
        [c.prev, c.next],
      );
      return r.rows;
    });
    if (rows.length === 0) return 0;
    const messages = rows.map((r) => ({
      topic: r.topic,
      event: r.type,
      private: false,
      payload: { id: String(r.id), type: r.type, payload: r.payload ?? {} },
    }));
    let sent = 0;
    for (let i = 0; i < messages.length; i += BROADCAST_CHUNK) {
      const chunk = messages.slice(i, i + BROADCAST_CHUNK);
      try {
        const res = await this.doFetch(`${rt.url}/realtime/v1/api/broadcast`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', apikey: rt.key, authorization: `Bearer ${rt.key}` },
          body: JSON.stringify({ messages: chunk }),
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) this.log('warn', 'realtime broadcast rejected', { status: res.status, n: chunk.length });
        else sent += chunk.length;
      } catch (e) {
        // Never log topics: they contain channel secrets.
        this.log('warn', 'realtime broadcast failed', { err: e instanceof Error ? e.name : 'error', n: chunk.length });
      }
    }
    return sent;
  }
}
