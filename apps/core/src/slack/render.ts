/**
 * Slack message layouts (spec §10). Pure.
 *
 * Every user, agent or third-party string is normalized (controls, bidi),
 * escaped (&, <, >) and has @channel/@here/@everyone broken with a zero-width
 * space, so nothing can ping a channel, mention a user or forge a link. Free
 * text goes in plain_text objects where possible. The fallback `text` (the
 * push notification) carries fixed words and handles only.
 */
import { normalizeUntrusted } from '@y/safety';

export interface SlackMessage { text: string; blocks: unknown[] }

const ZWSP = '​';
// C0/C1 controls (except tab/newline), bidi controls and other invisibles.
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g;

export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Break broadcast mentions and special `<!…>` / `<@…>` sequences. Idempotent on escaped text. */
export function neutralizeMentions(s: string): string {
  return s
    .replace(/@(channel|here|everyone)\b/gi, `@${ZWSP}$1`)
    .replace(/<!/g, '&lt;!')
    .replace(/<@/g, '&lt;@');
}

/** Normalize untrusted text to one clean line (or keep newlines with multiline). */
export function cleanText(s: string, max: number, opts: { multiline?: boolean } = {}): string {
  let t = normalizeUntrusted(String(s ?? '')).text.replace(CONTROLS, '');
  t = opts.multiline ? t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n') : t.replace(/\s+/g, ' ');
  t = t.trim();
  if (t.length > max) t = t.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
  return t;
}

/** Untrusted text made safe for any Slack text field (mrkdwn or plain_text). */
export function safe(s: string, max = 300, opts: { multiline?: boolean } = {}): string {
  return escapeMrkdwn(cleanText(s, max, opts)).replace(/@(channel|here|everyone)\b/gi, `@${ZWSP}$1`);
}

/** A handle (`alice-cc` or `@alice-cc`) as `@alice-cc`, escaped. */
export function at(handle: string | null | undefined): string {
  const h = String(handle ?? 'someone').replace(/^@+/, '');
  return ('@' + safe(h, 64)).replace(/@(channel|here|everyone)\b/gi, `@${ZWSP}$1`);
}

export function plainText(s: string): { type: 'plain_text'; text: string; emoji: false } {
  return { type: 'plain_text', text: s.slice(0, 3000) || ' ', emoji: false };
}
function mrkdwn(s: string) { return { type: 'mrkdwn', text: s.slice(0, 3000) || ' ' }; }
function section(s: string) { return { type: 'section', text: mrkdwn(s) }; }
function sectionPlain(s: string) { return { type: 'section', text: plainText(s) }; }
function context(s: string) { return { type: 'context', elements: [mrkdwn(s)] }; }
function urlButton(text: string, url: string, style?: 'primary' | 'danger') {
  return { type: 'button', action_id: 'y_open', text: plainText(text), url, ...(style ? { style } : {}) };
}
function button(text: string, actionId: string, value: string, style?: 'primary' | 'danger', confirm?: { title: string; text: string; confirm: string; deny: string }) {
  return {
    type: 'button', action_id: actionId, text: plainText(text), value, ...(style ? { style } : {}),
    ...(confirm ? { confirm: { title: plainText(confirm.title), text: plainText(confirm.text), confirm: plainText(confirm.confirm), deny: plainText(confirm.deny) } } : {}),
  };
}
function actions(elements: unknown[], blockId?: string) { return { type: 'actions', ...(blockId ? { block_id: blockId } : {}), elements }; }

/** Inbound Slack text -> plain text for Y (links, mentions, entities). */
export function slackToPlain(text: string): string {
  return String(text ?? '')
    .replace(/<((?:https?|mailto):[^|>\s]+)\|([^>]*)>/g, (_m, url: string, label: string) => (label && label !== url ? `${label} (${url})` : url))
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
    .replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, '@slack-user')
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<#[A-Z0-9]+>/g, '#channel')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<![^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

/* ---------------------------------------------------------------- formatting */

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(n));
}

export function fmtDuration(ms: number): string {
  const m = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 60_000));
  if (m < 1) return 'under 1m';
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

export function hhmm(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

/* ------------------------------------------------------------- links */

export const links = {
  thread: (web: string, bareId: string) => `${web}/chats/t_${bareId}`,
  review: (web: string, bareId: string) => `${web}/review/rv_${bareId}`,
  activity: (web: string, bareId: string) => `${web}/activity/a_${bareId}`,
  link: (web: string, token: string) => `${web}/slack/link?token=${encodeURIComponent(token)}`,
};

/* ------------------------------------------------------- notifications */

export type MessageVerb = { kind: 'agent_dm'; agent: string } | { kind: 'commented' } | { kind: 'replied' } | { kind: 'room' };

export interface NoticeInput {
  sender: string;
  subject: string;
  preview: string | null;
  url: string;
  verb: MessageVerb;
  /** Agents the replier would instruct (only the user's own agents present). */
  instructAgent?: string | null;
}

function verbText(v: MessageVerb): string {
  switch (v.kind) {
    case 'agent_dm': return `messaged your agent ${at(v.agent)}`;
    case 'commented': return 'commented';
    case 'replied': return 'replied';
    case 'room': return 'posted in your team room';
  }
}

/** N1: a new message, top level in the user's IM (starts the bridge). */
export function n1(i: NoticeInput): SlackMessage {
  const subject = i.subject ? safe(i.subject, 120) : 'a conversation';
  const blocks: unknown[] = [section(`*${at(i.sender)}* ${verbText(i.verb)} in *${subject}*`)];
  blocks.push(i.preview ? sectionPlain(i.preview) : context('Preview hidden. Open in Y to read.'));
  blocks.push(actions([urlButton('Open in Y', i.url)]));
  blocks.push(context(i.instructAgent ? `Reply in this thread to instruct ${at(i.instructAgent)} (you'll confirm first).` : 'Reply in this thread to comment.'));
  return { text: `New message from ${at(i.sender)} in Y`, blocks };
}

/** N2: a follow-up in the bridged Slack thread. */
export function n2(i: { sender: string; preview: string | null }): SlackMessage {
  return {
    text: `New message from ${at(i.sender)}`,
    blocks: [i.preview ? sectionPlain(`${at(i.sender)}: ${i.preview}`) : section(`${at(i.sender)} sent a message (preview hidden).`)],
  };
}

/** N-room: at most one per 10 minutes per user per room. */
export function nRoom(i: { sender: string; subject: string; preview: string | null; url: string }): SlackMessage {
  const room = i.subject ? safe(i.subject, 120) : 'Team room';
  const blocks: unknown[] = [section(`New activity in *${room}* · latest from *${at(i.sender)}*`)];
  blocks.push(i.preview ? sectionPlain(i.preview) : context('Preview hidden. Open in Y to read.'));
  blocks.push(actions([urlButton('Open in Y', i.url)]));
  blocks.push(context("Reply in this thread to comment. You'll get at most one notice per 10 minutes for this room."));
  return { text: 'New activity in your team room', blocks };
}

/* ---------------------------------------------------------------- reviews */

export function rvDmRequest(i: { reviewId: string; agent: string; owner: string; yourAgent: string; label: string; url: string }): SlackMessage {
  const rv = `rv_${i.reviewId}`;
  return {
    text: `New DM request from ${at(i.agent)} (outside your teams)`,
    blocks: [
      section(`*${at(i.agent)}* (owner ${at(i.owner)}) wants to message your agent *${at(i.yourAgent)}*. They're outside your teams.`),
      // No Accept here: accepting delivers the intro, so it needs a human who has read it (I4/I8), which only the web shows.
      context(`Screened: ${safe(i.label, 20)}. Read the intro and accept on the web.`),
      actions([urlButton('Review in Y', i.url), button('Decline', 'y_rv_reject', rv, 'danger')], `rv:${i.reviewId}`),
    ],
  };
}

export function rvQuarantined(i: { reviewId: string; sender: string; subject: string; url: string }): SlackMessage {
  const rv = `rv_${i.reviewId}`;
  const subject = i.subject ? safe(i.subject, 120) : 'a conversation';
  return {
    text: 'A message was quarantined by screening',
    blocks: [
      section(`A message from *${at(i.sender)}* in *${subject}* was held by screening.`),
      context('Its content is never shown in Slack.'),
      actions([
        button('Release to agent', 'y_rv_release', rv, 'primary', {
          title: 'Release this message?', text: "Your agent will read it. You haven't seen it; consider reviewing it on the web first.", confirm: 'Release', deny: 'Cancel',
        }),
        button('Reject', 'y_rv_reject', rv, 'danger'),
        urlButton('Review in Y', i.url),
      ], `rv:${i.reviewId}`),
    ],
  };
}

export function rvDraft(i: { reviewId: string; agent: string; summary: string; url: string }): SlackMessage {
  const rv = `rv_${i.reviewId}`;
  return {
    text: `A post draft from ${at(i.agent)} needs your review`,
    blocks: [
      section(safe(i.summary || 'A post draft is ready for review.', 500)),
      actions([
        button('Publish', 'y_rv_approve', rv, 'primary', { title: 'Publish to your team?', text: 'Your teammates will see this post.', confirm: 'Publish', deny: 'Cancel' }),
        button('Reject', 'y_rv_reject', rv, 'danger'),
        urlButton('Preview in Y', i.url),
      ], `rv:${i.reviewId}`),
    ],
  };
}

export function rvChange(i: { kind: string; agent: string; summary: string; url: string }): SlackMessage {
  const text = i.kind === 'change_request' ? `${at(i.agent)} proposed a setup change`
    : i.kind === 'builder_reply' ? 'A builder replied to your report' : 'A report needs your review';
  return {
    text,
    blocks: [
      section(safe(i.summary || text, 500)),
      context('Approve on the web after reviewing the exact change.'),
      actions([urlButton('Review in Y', i.url)]),
    ],
  };
}

export function outcomeWord(kind: string, state: string, decision: string | null, agent?: string | null): string {
  if (state === 'expired') return 'Expired';
  if (state === 'rejected' || decision === 'reject') return kind === 'dm_request' ? 'Declined' : 'Rejected';
  if (decision === 'release') return agent ? `Released to ${at(agent)}` : 'Released';
  if (kind === 'dm_request') return 'Accepted';
  if (kind === 'draft') return 'Published';
  return 'Approved';
}

/** R-done: the review message after a decision (here, on the web, or by expiry). */
export function rvDone(i: { kind: string; state: string; decision: string | null; via: string | null; at: Date | null; agent?: string | null; url: string; already?: boolean; byYou?: boolean }): SlackMessage {
  const word = outcomeWord(i.kind, i.state, i.decision, i.agent);
  const via = i.via === 'slack' ? 'Slack' : i.via === 'web' ? 'web' : i.via === 'native_prompt' ? 'a prompt' : null;
  const parts = [`${i.already ? 'Already decided: ' : ''}*${word}*`];
  if (via) parts.push(`${i.byYou ? 'by you ' : ''}via ${via}`);
  if (i.at) parts.push(hhmm(i.at));
  return { text: `Decided: ${word.replace(/\*/g, '')}`, blocks: [section(parts.join(' · ')), actions([urlButton('Open in Y', i.url)])] };
}

/* --------------------------------------------------------- instructions */

export function p1(i: { pendingId: string; targets: { agentId: string; handle: string }[]; body: string; unattended: string | null }): SlackMessage {
  const first = i.targets[0]!;
  const blocks: unknown[] = [
    section(i.targets.length === 1 ? `Send this to *${at(first.handle)}* as an owner instruction?` : 'Send this to one of your agents as an owner instruction?'),
    sectionPlain(safe(i.body, 300, { multiline: true })),
  ];
  if (i.unattended) blocks.push(context(`Heads up: ${at(i.unattended)} runs unattended (bypass permissions). Confirming delivers it and may wake that session.`));
  blocks.push(actions([
    ...i.targets.slice(0, 5).map((t) => button(`Confirm → ${at(t.handle)}`.slice(0, 75), 'y_oi_confirm', `${i.pendingId}|${t.agentId}`, 'primary')),
    button('Cancel', 'y_oi_cancel', i.pendingId),
  ], `oi:${i.pendingId}`));
  blocks.push(context('Expires in 15 minutes.'));
  return { text: 'Send this to your agent?', blocks };
}

export function pDone(outcome: 'sent' | 'cancelled' | 'expired' | 'handled' | 'remote_off', agent?: string | null, web?: string): SlackMessage {
  const text = outcome === 'sent' ? `Sent to ${at(agent)} as an owner instruction.`
    : outcome === 'cancelled' ? 'Cancelled. Nothing was sent.'
      : outcome === 'expired' ? 'Expired: reply again.'
        : outcome === 'handled' ? 'Already handled.'
          : e6(agent ?? null, web ?? '');
  return { text: outcome === 'sent' ? 'Sent' : outcome === 'cancelled' ? 'Cancelled' : outcome === 'expired' ? 'Expired' : 'Not sent', blocks: [section(text)] };
}

/* ------------------------------------------------------------ commands */

export function c1(url: string): SlackMessage {
  return {
    text: 'Link your Slack account to Y',
    blocks: [
      section('Link this Slack account to your Y account to get notifications and approve requests here. The link works once and expires in 10 minutes.'),
      actions([urlButton('Link account', url, 'primary')]),
      context('Only you can see this message.'),
    ],
  };
}

export function c2(): SlackMessage {
  return { text: 'Link your account first', blocks: [section('Run `/y connect` to link your Slack account to Y.')] };
}

export function f1(team: string, isPrivate: boolean): SlackMessage {
  let s = `Published team sessions for *${safe(team, 64)}* will be posted here. Run \`/y feed off\` to stop.`;
  if (isPrivate) s += '\nThis is a private channel: invite the bot with `/invite @Y`.';
  return { text: 'Y feed on', blocks: [section(s)] };
}

export function h1(): SlackMessage {
  return {
    text: 'Y commands',
    blocks: [section([
      '*Y commands*',
      '• `/y connect`: link this Slack account to your Y account',
      '• `/y disconnect`: unlink it and stop notifications',
      '• `/y status`: what is linked and switched on',
      '• `/y feed [team]`: post published team sessions in this channel',
      '• `/y feed off [team]`: stop the feed in this channel',
      'Reply in a Y notification thread to comment or instruct your agent.',
    ].join('\n'))],
  };
}

export function simple(text: string, fallback = text): SlackMessage {
  return { text: fallback, blocks: [section(text)] };
}

export function w1(handle: string, web: string): SlackMessage {
  return {
    text: "You're connected to Y",
    blocks: [section(`Your Slack account is linked to *${at(handle)}*. You'll get Y notifications here. Turn them off at ${web}/connect, or run \`/y disconnect\`.`)],
  };
}

/** A1: the team feed card. Title is the only free text; no summary, highlights, repo or stack. */
export function a1(i: { title: string; agent: string; outcome: string; toolCalls: number; tokens: number; wallMs: number; turns: number; url: string }): SlackMessage {
  return {
    text: `${at(i.agent)} finished a session`,
    blocks: [
      section(`*${safe(i.title || 'Untitled session', 120)}*`),
      {
        type: 'section',
        fields: [
          mrkdwn(`*Agent*\n${at(i.agent)}`),
          mrkdwn(`*Outcome*\n${safe(i.outcome || 'unknown', 32)}`),
          mrkdwn(`*Tool calls*\n${Math.max(0, Math.round(i.toolCalls))}`),
          mrkdwn(`*Tokens*\n${fmtTokens(i.tokens)}`),
          mrkdwn(`*Duration*\n${fmtDuration(i.wallMs)}`),
          mrkdwn(`*Turns*\n${Math.max(0, Math.round(i.turns))}`),
        ],
      },
      actions([urlButton('View in Y', i.url)]),
    ],
  };
}

/* ------------------------------------------------------------ ephemerals */

export const E1 = 'Not delivered: link your Slack account with /y connect.';
export const E2 = "Not delivered: you're not part of this conversation.";
export const E3 = 'Not delivered: messages to Y must be 1–4000 characters.';
export const E5 = "Held by screening; the other side won't see it unless it's released.";

const E4_TEXT: Record<string, string> = {
  CONFLICT: 'this thread is archived',
  DM_NOT_PERMITTED: "this conversation is awaiting a human's approval",
  NOT_FOUND: 'this conversation no longer exists',
  SCOPE_FORBIDDEN: "you can't post in this conversation",
  VALIDATION: 'the message was not accepted',
  RATE_LIMITED: 'too many messages, try again in a minute',
};
export function e4(code: string): string {
  return `Not delivered: ${E4_TEXT[code] ?? 'Y could not take this message right now'}.`;
}
export function e6(agent: string | null, web: string): string {
  return `Remote instructions are off for ${at(agent)}. Turn them on at ${web}/settings and reply again.`;
}
