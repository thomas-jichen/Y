/** In-memory SlackClient for tests: records calls, scripted failures. Not exported from index. */
import type { SlackClient } from './client.js';
import { SlackApiError } from './client.js';

export class FakeSlackClient implements SlackClient {
  calls: { method: string; args: any }[] = [];
  team = { teamId: 'T0TEST001', teamName: 'Test Workspace', botUserId: 'U0BOT0001' };
  /** method name -> error thrown once by the next call to it. */
  failNext: Partial<Record<string, SlackApiError>> = {};
  private seq = 0;

  private fail(method: string) {
    const e = this.failNext[method];
    if (e) { delete this.failNext[method]; throw e; }
  }
  of(method: string) { return this.calls.filter((c) => c.method === method); }
  reset() { this.calls = []; }

  async authTest(opts?: { timeoutMs?: number }) { this.calls.push({ method: 'authTest', args: { ...opts } }); this.fail('authTest'); return { ...this.team }; }
  async openIm(userId: string) { this.calls.push({ method: 'openIm', args: { userId } }); this.fail('openIm'); return `D${userId.slice(1)}`.slice(0, 20); }
  async postMessage(m: { channel: string; text: string; blocks?: unknown[]; threadTs?: string }) {
    this.calls.push({ method: 'postMessage', args: m }); this.fail('postMessage');
    return { channel: m.channel, ts: `1700000000.${String(++this.seq).padStart(6, '0')}` };
  }
  async postEphemeral(m: { channel: string; user: string; text: string; blocks?: unknown[]; threadTs?: string }) {
    this.calls.push({ method: 'postEphemeral', args: m }); this.fail('postEphemeral');
  }
  async updateMessage(m: { channel: string; ts: string; text: string; blocks?: unknown[] }) {
    this.calls.push({ method: 'updateMessage', args: m }); this.fail('updateMessage');
  }
}

export { SlackApiError };
