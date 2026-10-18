/**
 * Supabase Realtime "doorbell" for the serverless listener (CONTRACTS:
 * "Serverless pulse"). In production core runs on Vercel and `/api/v1/pulse`
 * does not hold, so the listener keeps one websocket to the agent's secret
 * broadcast topic (`AgentBrief.realtime`) and calls `/pulse?wait=0` when it
 * rings. The broadcast payload is ids/counts only and is never rendered or
 * forwarded: a ring just means "go ask core" (I3).
 *
 * Phoenix channel protocol v1.0.0 (JSON frames `{topic, event, payload, ref}`),
 * the subset Supabase Realtime needs: `phx_join` on `realtime:<topic>` with
 * `private: false`, a heartbeat on topic `phoenix` every 25 s, and
 * `broadcast` frames. Node built-ins only: uses the global `WebSocket`
 * (Node ≥ 22); without it the listener falls back to slow polling.
 */
import type { RealtimeChannel } from '@y/schema/hosting';

/** The part of the WHATWG WebSocket we use (injectable for tests). */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WsCtor = new (url: string) => WsLike;

export const HEARTBEAT_MS = 25_000;

export type SupabaseChannel = Extract<RealtimeChannel, { provider: 'supabase' }>;

/** `wss://<ref>.supabase.co/realtime/v1/websocket?apikey=…&vsn=1.0.0` from the channel's https URL. */
export function realtimeSocketUrl(ch: SupabaseChannel): string {
  const base = ch.url.replace(/\/+$/, '').replace(/^http/, 'ws');
  const root = /\/realtime\/v1$/.test(base) ? base : `${base}/realtime/v1`;
  const q = new URLSearchParams({ apikey: ch.apiKey, vsn: '1.0.0' });
  return `${root}/websocket?${q}`;
}

export function globalWebSocket(): WsCtor | undefined {
  const W = (globalThis as { WebSocket?: unknown }).WebSocket;
  return typeof W === 'function' ? (W as WsCtor) : undefined;
}

export type RingResult = 'ring' | 'timeout' | 'closed';

/**
 * One connection, one channel. `wait(ms)` resolves `ring` as soon as a
 * broadcast arrives (or one arrived since the last wait), `closed` when the
 * socket dies, else `timeout`.
 */
export class Doorbell {
  private ws: WsLike | undefined;
  private rang = false;
  private dead = false;
  private ref = 0;
  private hb: ReturnType<typeof setInterval> | undefined;
  private waiter: ((r: RingResult) => void) | undefined;

  constructor(
    private readonly ch: SupabaseChannel,
    private readonly Ws: WsCtor,
  ) {}

  start(): void {
    let ws: WsLike;
    try {
      ws = new this.Ws(realtimeSocketUrl(this.ch));
    } catch {
      this.die();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.send(`realtime:${this.ch.topic}`, 'phx_join', {
        config: { broadcast: { ack: false, self: false }, presence: { key: '' }, private: false },
      });
      this.hb = setInterval(() => this.send('phoenix', 'heartbeat', {}), HEARTBEAT_MS);
      (this.hb as { unref?: () => void }).unref?.();
    };
    ws.onmessage = (ev) => this.onFrame(ev.data);
    ws.onclose = () => this.die();
    ws.onerror = () => this.die();
  }

  private send(topic: string, event: string, payload: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify({ topic, event, payload, ref: String(++this.ref) }));
    } catch {
      this.die();
    }
  }

  private onFrame(data: unknown): void {
    if (typeof data !== 'string' || data.length > 65_536) return;
    let f: { topic?: unknown; event?: unknown; payload?: unknown };
    try {
      f = JSON.parse(data);
    } catch {
      return;
    }
    if (f.topic !== `realtime:${this.ch.topic}`) return;
    if (f.event === 'broadcast') {
      this.ring();
    } else if (f.event === 'phx_reply') {
      const p = f.payload as { status?: unknown } | undefined;
      if (p && p.status === 'error') this.die();
    } else if (f.event === 'phx_error' || f.event === 'phx_close') {
      this.die();
    }
  }

  private ring(): void {
    this.rang = true;
    this.settle('ring');
  }

  private die(): void {
    if (this.dead) return;
    this.dead = true;
    if (this.hb) clearInterval(this.hb);
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.settle('closed');
  }

  private settle(r: RingResult): void {
    const w = this.waiter;
    this.waiter = undefined;
    w?.(r);
  }

  get closed(): boolean {
    return this.dead;
  }

  wait(ms: number): Promise<RingResult> {
    if (this.rang) {
      this.rang = false;
      return Promise.resolve('ring');
    }
    if (this.dead) return Promise.resolve('closed');
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiter = undefined;
        resolve('timeout');
      }, ms);
      this.waiter = (r) => {
        clearTimeout(t);
        if (r === 'ring') this.rang = false;
        resolve(r);
      };
    });
  }

  close(): void {
    this.die();
  }
}
