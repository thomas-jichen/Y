/**
 * PushBus: events rows (ids/counts only, I3) + NOTIFY paceline_events → in-process
 * fan-out to agent long-poll waiters and web SSE subscribers. Cursor = events.id.
 */
import type { Db, Tx, Unlisten } from '@paceline/db';
import { NOTIFY_CHANNEL } from '@paceline/schema';
import type { PushBus, PushEvent } from '../contracts.js';

const SYSTEM_TYPES = new Set(['kill_switch.changed', 'takedown', 'wake.requested']);
const MAX_AUDIENCE = 100;

export interface EventRow {
  id: string | number;
  type: string;
  audience_agent_ids: string[] | null;
  audience_user_ids: string[] | null;
  payload: Record<string, unknown> | null;
}

export function toEvent(r: EventRow): PushEvent {
  return {
    id: String(r.id),
    type: r.type,
    audienceAgentIds: r.audience_agent_ids ?? [],
    audienceUserIds: r.audience_user_ids ?? [],
    payload: r.payload ?? {},
  };
}

type Waiter = { after: number; resolve: (events: PushEvent[]) => void };

export class PgPushBus implements PushBus {
  protected watermark = 0;
  private readonly agentWaiters = new Map<string, Set<Waiter>>();
  private readonly userSubs = new Map<string, Set<(e: PushEvent) => void>>();
  private pumping: Promise<void> | null = null;
  private pumpAgain = false;
  private unlisten: Unlisten | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    protected readonly db: Db,
    protected readonly log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void,
  ) {}

  async start(): Promise<void> {
    const r = await this.db.asService((tx) => tx.query<{ max: string | number | null }>('select max(id) as max from public.events'));
    this.watermark = Number(r.rows[0]?.max ?? 0);
    this.unlisten = await this.db.listen(NOTIFY_CHANNEL, () => void this.pump(), { onReconnect: () => void this.pump() });
    // Safety net for missed NOTIFYs while someone is waiting.
    this.timer = setInterval(() => {
      if (this.agentWaiters.size > 0 || this.userSubs.size > 0) void this.pump();
    }, 1000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.unlisten?.();
  }

  /** Latest event id this process has seen (a pulse cursor). */
  get cursor(): string {
    return String(this.watermark);
  }

  async publish(event: PushEvent, tx?: Tx): Promise<void> {
    const agents = [...new Set(event.audienceAgentIds)];
    const users = [...new Set(event.audienceUserIds)];

    // Larger audiences are split into several events (events.audience_* ≤ 100).
    const chunks: Array<[string[], string[]]> = [];
    for (let i = 0; i < Math.max(agents.length, users.length, 1); i += MAX_AUDIENCE) {
      chunks.push([agents.slice(i, i + MAX_AUDIENCE), users.slice(i, i + MAX_AUDIENCE)]);
    }
    const run = async (q: Tx) => {
      // Worker/service contexts use emit_system_event (service_role only, no audience checks);
      // user contexts use emit_event, which checks the caller may notify every audience member.
      const who = await q.query<{ u: string; s: boolean }>(
        `select current_user::text as u, coalesce((select r.rolsuper or r.rolbypassrls from pg_catalog.pg_roles r where r.rolname = current_user), false) as s`,
      );
      const service = who.rows[0]?.u === 'service_role' || Boolean(who.rows[0]?.s);
      if (!service && SYSTEM_TYPES.has(event.type)) throw new Error(`${event.type} is a system event (worker only)`);
      const fn = service ? 'api.emit_system_event' : 'api.emit_event';
      for (const [a, u] of chunks) {
        await q.query(`select ${fn}($1, $2::uuid[], $3::uuid[], $4::jsonb)`, [event.type, a, u, JSON.stringify(event.payload)]);
      }
    };
    if (tx) await run(tx);
    else {
      await this.db.asService(run);
      await this.pump();
    }
  }

  /** Read events after the watermark and dispatch them. Serialized; coalesces concurrent calls. */
  pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return this.pumping;
    }
    this.pumping = (async () => {
      try {
        do {
          this.pumpAgain = false;
          const r = await this.db.asService((tx) =>
            tx.query<EventRow>(
              `select id, type, to_jsonb(audience_agent_ids) as audience_agent_ids, to_jsonb(audience_user_ids) as audience_user_ids, payload
                 from api.events_since($1, 500)`,
              [
              this.watermark,
            ]),
          );
          for (const row of r.rows) {
            this.watermark = Math.max(this.watermark, Number(row.id));
            this.dispatch(toEvent(row));
          }
          if (r.rows.length === 500) this.pumpAgain = true;
        } while (this.pumpAgain);
      } catch (e) {
        this.log('warn', 'bus pump failed', { err: String(e) });
      } finally {
        this.pumping = null;
      }
    })();
    return this.pumping;
  }

  private dispatch(e: PushEvent): void {
    const id = Number(e.id);
    for (const agentId of e.audienceAgentIds) {
      const set = this.agentWaiters.get(agentId);
      if (!set) continue;
      for (const w of [...set]) if (id > w.after) w.resolve([e]);
    }
    for (const userId of e.audienceUserIds) {
      for (const cb of this.userSubs.get(userId) ?? []) {
        try {
          cb(e);
        } catch (err) {
          this.log('warn', 'sse subscriber threw', { err: String(err) });
        }
      }
    }
  }

  protected async eventsForAgent(agentId: string, after: number): Promise<PushEvent[]> {
    const r = await this.db.asService((tx) =>
      tx.query<EventRow>(
        `select id, type, to_jsonb(audience_agent_ids) as audience_agent_ids, to_jsonb(audience_user_ids) as audience_user_ids, payload from public.events
          where id > $1 and audience_agent_ids @> array[$2::uuid] order by id limit 100`,
        [after, agentId],
      ),
    );
    return r.rows.map(toEvent);
  }

  async waitForAgent(agentId: string, cursor: string | null, timeoutMs: number): Promise<{ events: PushEvent[]; cursor: string | null }> {
    const parsed = cursor !== null && /^\d{1,19}$/.test(cursor) ? Number(cursor) : null;
    let after = parsed;
    if (after === null) {
      const r = await this.db.asService((tx) => tx.query<{ max: string | number | null }>('select max(id) as max from public.events'));
      after = Number(r.rows[0]?.max ?? 0);
    }
    const from = after;
    let waiter: Waiter | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const woke = new Promise<PushEvent[]>((resolve) => {
      waiter = { after: from, resolve };
      let set = this.agentWaiters.get(agentId);
      if (!set) this.agentWaiters.set(agentId, (set = new Set()));
      set.add(waiter);
      timer = setTimeout(() => resolve([]), Math.max(0, timeoutMs));
    });
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      const set = this.agentWaiters.get(agentId);
      if (set && waiter) {
        set.delete(waiter);
        if (set.size === 0) this.agentWaiters.delete(agentId);
      }
    };
    try {
      // Waiter registered first, so nothing dispatched between this read and the wait is lost.
      const existing = await this.eventsForAgent(agentId, from);
      if (existing.length > 0) return { events: existing, cursor: existing[existing.length - 1]!.id ?? String(from) };
      const first = await woke;
      if (first.length === 0) return { events: [], cursor: String(from) };
      const all = await this.eventsForAgent(agentId, from);
      const events = all.length > 0 ? all : first;
      return { events, cursor: events[events.length - 1]!.id ?? String(from) };
    } finally {
      cleanup();
    }
  }

  subscribeUser(userId: string, onEvent: (e: PushEvent) => void): () => void {
    let set = this.userSubs.get(userId);
    if (!set) this.userSubs.set(userId, (set = new Set()));
    set.add(onEvent);
    return () => {
      const s = this.userSubs.get(userId);
      s?.delete(onEvent);
      if (s && s.size === 0) this.userSubs.delete(userId);
    };
  }
}
