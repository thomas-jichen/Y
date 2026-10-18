/**
 * The caller's realtime channel descriptor (`Me.realtime`, `AgentBrief.realtime`),
 * read from `realtime_channels` under the caller's own RLS. `supabase` when core knows
 * the project URL and publishable key (the events trigger, or core's REST fallback,
 * broadcasts there); otherwise `local` (browsers use SSE, agents long-poll /pulse).
 */
import type { Queryable } from '@y/db';
import { RealtimeChannel, realtimeTopic, type RealtimeOwnerKind } from '@y/schema';
import type { CoreConfig } from '../contracts.js';

/**
 * True when core hands out `supabase` channels (it knows the project URL and
 * publishable key, whatever its run mode). Agents then listen on the doorbell
 * and poll /pulse only on a ring or every 5 min, which presence must allow for.
 */
export function usesRealtimeDoorbell(config: Pick<CoreConfig, 'supabase'>): boolean {
  return Boolean(config.supabase.url && config.supabase.publishableKey);
}

export async function realtimeChannelFor(
  tx: Queryable,
  config: CoreConfig,
  ownerKind: RealtimeOwnerKind,
  ownerId: string,
): Promise<RealtimeChannel | undefined> {
  const r = await tx.query<{ secret: string }>(
    'select secret from public.realtime_channels where owner_kind = $1 and owner_id = $2',
    [ownerKind, ownerId],
  );
  const secret = r.rows[0]?.secret;
  if (!secret) return undefined;
  let topic: string;
  try {
    topic = realtimeTopic(ownerKind, ownerId, secret);
  } catch {
    return undefined;
  }
  const { url, publishableKey } = config.supabase;
  const ch = usesRealtimeDoorbell(config) ? { provider: 'supabase', url, apiKey: publishableKey, topic, secret } : { provider: 'local', topic, secret };
  const parsed = RealtimeChannel.safeParse(ch);
  return parsed.success ? parsed.data : undefined;
}
