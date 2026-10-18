/** zod parsers for Slack's inbound wire (loose: unknown fields are ignored). */
import { z } from 'zod';

export const Ts = z.string().regex(/^[0-9]{1,12}\.[0-9]{1,8}$/);
export const TeamId = z.string().regex(/^[A-Z0-9]{5,20}$/);
export const SlackUser = z.string().regex(/^[A-Z0-9]{5,20}$/);
export const ChannelId = z.string().regex(/^[CDG][A-Z0-9]{4,19}$/);

export const SlashCommand = z.looseObject({
  team_id: TeamId,
  user_id: SlackUser,
  channel_id: ChannelId,
  command: z.literal('/y'),
  text: z.string().max(500).default(''),
  response_url: z.url().optional(),
  team_domain: z.string().max(100).optional(),
  /** Display only (the link preview); never used for identity. */
  user_name: z.string().max(200).optional(),
});
export type SlashCommand = z.infer<typeof SlashCommand>;

export const SlackMessageEvent = z.looseObject({
  type: z.string(),
  subtype: z.string().optional(),
  bot_id: z.string().optional(),
  app_id: z.string().optional(),
  user: SlackUser.optional(),
  text: z.string().max(40_000).optional(),
  ts: Ts,
  thread_ts: Ts.optional(),
  channel: ChannelId,
  channel_type: z.enum(['im', 'channel', 'group', 'mpim']).optional(),
  edited: z.unknown().optional(),
});

export const EventCallback = z.looseObject({
  type: z.literal('event_callback'),
  team_id: TeamId,
  event_id: z.string().regex(/^[A-Za-z0-9]{6,64}$/),
  event: SlackMessageEvent,
});
export type EventCallback = z.infer<typeof EventCallback>;

export const BlockActions = z.looseObject({
  type: z.literal('block_actions'),
  user: z.looseObject({ id: SlackUser }),
  team: z.looseObject({ id: TeamId }),
  container: z.looseObject({ channel_id: ChannelId.optional(), message_ts: Ts.optional() }),
  channel: z.looseObject({ id: ChannelId }).optional(),
  message: z.looseObject({ ts: Ts, thread_ts: Ts.optional() }).optional(),
  actions: z.array(z.looseObject({ action_id: z.string().max(64), value: z.string().max(200).optional(), action_ts: Ts })).min(1).max(1),
});
export type BlockActions = z.infer<typeof BlockActions>;

/* Job payloads (validated in the handlers). */
const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
export const NotifyMessageJob = z.object({ userId: Uuid, threadId: Ulid, messageId: Ulid });
export const ReviewJob = z.object({ reviewId: Ulid });
export const FeedJob = z.object({ activityId: Ulid });
export const WelcomeJob = z.object({ userId: Uuid });
export const UpdateMessageJob = z.object({ channel: ChannelId, ts: Ts, kind: z.enum(['review', 'pending']), id: Ulid });
export const EventJob = z.object({
  teamId: TeamId, eventId: z.string().min(6).max(64), channel: ChannelId, channelType: z.enum(['im', 'channel', 'group']),
  user: SlackUser, text: z.string().max(4000), ts: Ts, threadTs: Ts, tooLong: z.boolean().optional(),
});
export type EventJob = z.infer<typeof EventJob>;
