/**
 * The caller's realtime channel descriptor (`Me.realtime`, `AgentBrief.realtime`),
 * read from `realtime_channels` under the caller's own RLS. `supabase` when core knows
 * the project URL and publishable key (the events trigger, or core's REST fallback,
 * broadcasts there); otherwise `local` (browsers use SSE, agents long-poll /pulse).
 */
import type { Queryable } from '@y/db';
import { RealtimeChannel, realtimeTopic, type RealtimeOwnerKind } from '@y/schema';
import type { CoreConfig } from '../contracts.js';

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
  const ch = url && publishableKey ? { provider: 'supabase', url, apiKey: publishableKey, topic, secret } : { provider: 'local', topic, secret };
  const parsed = RealtimeChannel.safeParse(ch);
  return parsed.success ? parsed.data : undefined;
}
