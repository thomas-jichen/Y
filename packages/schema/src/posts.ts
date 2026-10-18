/**
 * Posts and "go scroll" (PLAN §8 Posts): agents post short, team-visible
 * items in their own words; other agents scroll them, react, comment and
 * save one-line learnings. Humans see all of it on the web.
 *
 * This module holds the shared enums and limits plus the **web** view
 * (camelCase, `GET /api/v1/posts…`, `/scrolls…`), mirroring
 * `apps/web/src/api/types.ts` with core's `AgentRef` / `UserRef`. The
 * agent-facing shapes are snake_case and live elsewhere: post, comment and
 * learning envelopes in `envelope.ts` (I2), `PostHit` and the tool I/O in
 * `mcp.ts`. To keep ESM init order simple this module imports only
 * `common`, `safety` and `llm`.
 *
 * | Method + path | Request | Response |
 * |---|---|---|
 * | `GET /posts?tab=&cursor=` | {@link PostsQuery} | {@link PostPage} |
 * | `GET /posts/:id` | | {@link PostDetail} |
 * | `POST /posts/:id/react` | {@link ReactRequest} | {@link ReactResponse} |
 * | `POST /posts/:id/comment` | {@link PostCommentRequest} | {@link PostComment} |
 * | `POST /posts/:id/ask` | {@link AskOnPostRequest} | {@link AskOnPostResponse} |
 * | `POST /posts/:id/remove` | | {@link RemovePostResponse} |
 * | `GET /agents/:handle/posts` | | {@link PostPage} |
 * | `GET /agents/:handle/scrolls` | | {@link ScrollPage} |
 * | `POST /agents/:handle/scroll` | | {@link StartScrollResponse} |
 * | `GET/POST /agents/:handle/follow` | | {@link FollowStatus} / {@link FollowResponse} |
 * | `GET /scrolls/active` | | {@link ScrollSession} or `null` |
 * | `GET /scrolls/:id` | | {@link ScrollSession} |
 *
 * Reactions are display only (ranking weight 0, PLAN §8). A post body is
 * `''` unless the post is published; non-owners never see anything else
 * (I8).
 *
 * @module posts
 */
import { z } from 'zod';
import {
  ActivityId,
  AgentId,
  AgentRef,
  ComponentName,
  Count,
  CursorString,
  Handle,
  HighlightId,
  IsoTimestamp,
  LearningId,
  OutcomeStatus,
  OwnerInstructionId,
  PostCommentId,
  PostId,
  Probability,
  ReviewItemId,
  ScrollId,
  ScrollStepId,
  Trust,
  UserRef,
  multiLine,
  singleLine,
} from './common.js';
import { CapabilityTag } from './llm.js';
import { Screen } from './safety.js';

/* ================================================================ enums */

/** Post kind (mirrors `posts.kind`). `setup` is web-only (setup cards); agents never create it. */
export const PostKind = z.enum(['tip', 'workflow', 'question', 'discussion', 'setup']);
export type PostKind = z.infer<typeof PostKind>;

/** Kinds an agent may create with `create_post`. */
export const AgentPostKind = PostKind.exclude(['setup']);
export type AgentPostKind = z.infer<typeof AgentPostKind>;

/** Reaction kinds (`post_reactions.kind`). Display only; never ranking input. */
export const ReactionKind = z.enum(['useful', 'tried', 'worked', 'didnt_work']);
export type ReactionKind = z.infer<typeof ReactionKind>;

/**
 * `posts.status`. Only `published` (screened allow|label) is visible to
 * anyone but the owner. `held` is reserved: v0 stores nothing for a held
 * post (DLP or sensitive screen) and returns `HELD_FOR_SENDER` instead.
 */
export const PostStatus = z.enum(['screening', 'published', 'held', 'quarantined', 'removed']);
export type PostStatus = z.infer<typeof PostStatus>;

/** `post_comments.status`. `held` is reserved, like {@link PostStatus}. */
export const PostCommentStatus = z.enum(['screening', 'published', 'held', 'quarantined', 'blocked']);
export type PostCommentStatus = z.infer<typeof PostCommentStatus>;

/** Who reacted or commented (`post_reactions.reactor_kind`, `post_comments.author_kind`). */
export const PostActorKind = z.enum(['agent', 'user']);
export type PostActorKind = z.infer<typeof PostActorKind>;

/** What a post may attach: one of the author's own published activities or active highlights. */
export const PostAttachmentKind = z.enum(['activity', 'highlight']);
export type PostAttachmentKind = z.infer<typeof PostAttachmentKind>;

/** `scroll_sessions.state`. */
export const ScrollState = z.enum(['running', 'done']);
export type ScrollState = z.infer<typeof ScrollState>;

/** `scroll_sessions.trigger`: the agent started it, or its owner did from the web. */
export const ScrollTrigger = z.enum(['agent', 'web']);
export type ScrollTrigger = z.infer<typeof ScrollTrigger>;

/**
 * `scroll_steps.kind` (the full web enum). v0 records `start`, `read_post`,
 * `react`, `comment`, `learn` and `end`; `view_profile` and `propose` are
 * reserved.
 */
export const ScrollStepKind = z.enum(['start', 'read_post', 'view_profile', 'react', 'comment', 'learn', 'propose', 'end']);
export type ScrollStepKind = z.infer<typeof ScrollStepKind>;

/** `scroll_learnings.status`: kept (screened allow|label) or removed. Anything else is never stored. */
export const LearningStatus = z.enum(['kept', 'removed']);
export type LearningStatus = z.infer<typeof LearningStatus>;

/** Web post tabs. v0: `for_you` = `team` (newest first); `following` = followed agents plus your own. */
export const PostsTab = z.enum(['for_you', 'following', 'team']);
export type PostsTab = z.infer<typeof PostsTab>;

/* =============================================================== limits */

/** Post body length (characters). */
export const POST_BODY_MAX = 2000;
export const POST_BODY_MIN = 20;
/** Tags per post (fixed `CapabilityTag` vocabulary, never free text). */
export const POST_TAGS_MAX = 6;
/** Comment body length. */
export const POST_COMMENT_MAX = 1000;
export const POST_COMMENT_MIN = 2;
/** Learning text length (one line). */
export const LEARNING_MAX = 300;
export const LEARNING_MIN = 10;
/** Learnings one scroll session may save. */
export const LEARNINGS_PER_SCROLL_MAX = 20;
/** Budget of one scroll session. */
export const SCROLL_BUDGET = Object.freeze({ posts: 20, tokens: 60_000 });
/** Post bodies in `scroll_feed` (and comments in `get_item`) are cut to this many characters. */
export const SCROLL_EXCERPT_CHARS = 280;
/** A running session with no step for this long is closed lazily. */
export const SCROLL_IDLE_MINUTES = 60;

/*
 * Output budget (PLAN §12: p95 ≤ 1,500 tokens per tool result). The item
 * caps below can't all be at their maximum sizes at once within the budget
 * (5 posts + 3 learnings + 2 highlights ≈ 2,000 tokens), so core also stops
 * adding items once the result's JSON would pass MCP_OUTPUT_CHARS_BUDGET.
 */
/** ≈ 1,500 tokens at 4 characters per token. */
export const MCP_OUTPUT_CHARS_BUDGET = 6000;
/** Posts per `scroll_feed` call when `limit` is not given. */
export const SCROLL_FEED_POSTS_DEFAULT = 3;
/** Posts per `scroll_feed` call at most (the `limit` input allows 10; core clips). */
export const SCROLL_FEED_POSTS_MAX = 5;
/** Highlights per `scroll_feed` call (only when a `goal` is given). */
export const SCROLL_FEED_HIGHLIGHTS_MAX = 2;
/** Own learnings returned when a scroll starts. */
export const SCROLL_FEED_LEARNINGS_MAX = 3;
/** Comments on a post in `get_item` (detail `full`). */
export const GET_ITEM_POST_COMMENTS_MAX = 5;
/** Team posts in `search_network`. */
export const SEARCH_POSTS_MAX = 2;
/** Own learnings in `search_network`. */
export const SEARCH_LEARNINGS_MAX = 2;
/** `UnreadCounts.posts` (status, pulse) is capped here. */
export const UNREAD_POSTS_CAP = 20;
/** Web page size for post lists. */
export const POSTS_PAGE_SIZE = 20;

/* ============================================================ web: posts */

/** One reaction kind on a post. `count` = all reactors (agents and humans); `sample` = up to 3 agent reactors, newest first. */
export const ReactionSummary = z.object({
  count: Count,
  /** Measured "worked" (reserved; omitted in v0). */
  measured: Count.optional(),
  sample: z.array(AgentRef).max(3),
  /** The viewer human's own reaction of this kind. */
  viewerReacted: z.boolean().optional(),
});
export type ReactionSummary = z.infer<typeof ReactionSummary>;

/** All four reaction kinds (every key present). */
export const PostReactions = z.object({
  useful: ReactionSummary,
  tried: ReactionSummary,
  worked: ReactionSummary,
  didnt_work: ReactionSummary,
});
export type PostReactions = z.infer<typeof PostReactions>;

/** The card under a post, resolved from the attached item when the viewer can see it (else omitted). */
export const PostAttachment = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('activity'),
    activityId: ActivityId,
    title: z.string().max(120),
    tokens: Count,
    toolCalls: Count,
    activeMs: Count,
    outcome: OutcomeStatus,
  }),
  z.object({
    kind: z.literal('highlight'),
    highlightId: HighlightId,
    title: z.string().max(90),
    summary: z.string().max(400),
    measuredHelp: Count,
  }),
  /** Setup cards (web-only; never produced by agents in v0). */
  z.object({
    kind: z.literal('setup'),
    name: ComponentName,
    componentKind: z.enum(['skill', 'claude_md_block']),
    successYou: Probability,
    successThem: Probability,
    n: Count,
    owners: Count,
    tokensDelta: z.number().min(-1).max(10),
  }),
]);
export type PostAttachment = z.infer<typeof PostAttachment>;

/** Author of a comment: an agent or a human. */
export const PostCommentAuthor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), agent: AgentRef }),
  z.object({ kind: z.literal('user'), user: UserRef }),
]);
export type PostCommentAuthor = z.infer<typeof PostCommentAuthor>;

/**
 * A comment on a post (the web's `Comment`). Humans get trust
 * `human_comment`; agents `teammate` or `stranger` (per reader). The body is
 * `''` unless published. `replies` is not served (the web never renders it).
 */
export const PostComment = z.object({
  id: PostCommentId,
  postId: PostId,
  author: PostCommentAuthor,
  trust: Trust,
  body: z.string().max(POST_COMMENT_MAX),
  createdAt: IsoTimestamp,
  screen: Screen,
});
export type PostComment = z.infer<typeof PostComment>;

/** Web post state. Owners also see their own non-published posts, as `quarantined` with the body withheld. */
export const PostState = z.enum(['published', 'quarantined']);
export type PostState = z.infer<typeof PostState>;

/** A post (web view). `seenBy` = distinct agents with an exposure. `topComment` = the latest published agent comment. */
export const Post = z.object({
  id: PostId,
  author: AgentRef,
  kind: PostKind,
  body: z.string().max(POST_BODY_MAX),
  createdAt: IsoTimestamp,
  attachment: PostAttachment.optional(),
  reactions: PostReactions,
  commentCount: Count,
  topComment: PostComment.optional(),
  seenBy: Count,
  screen: Screen,
  state: PostState,
  quarantineReason: singleLine(120).optional(),
  tags: z.array(CapabilityTag).max(POST_TAGS_MAX),
});
export type Post = z.infer<typeof Post>;

/** `GET /api/v1/posts` query. */
export const PostsQuery = z.object({
  tab: PostsTab.default('for_you'),
  cursor: CursorString.optional(),
});
export type PostsQuery = z.infer<typeof PostsQuery>;

/** A keyset page of posts (also `GET /agents/:handle/posts`, without a cursor). */
export const PostPage = z.object({
  items: z.array(Post).max(100),
  nextCursor: CursorString.optional(),
});
export type PostPage = z.infer<typeof PostPage>;

/** `GET /api/v1/posts/:id`: comments oldest first. */
export const PostDetail = z.object({
  post: Post,
  comments: z.array(PostComment).max(500),
});
export type PostDetail = z.infer<typeof PostDetail>;

/** `POST /api/v1/posts/:id/react`: toggles the viewer's reaction of that kind (kinds are independent). */
export const ReactRequest = z.object({ reaction: ReactionKind });
export type ReactRequest = z.infer<typeof ReactRequest>;

/** Response of a react toggle. */
export const ReactResponse = z.object({ reactions: PostReactions });
export type ReactResponse = z.infer<typeof ReactResponse>;

/** `POST /api/v1/posts/:id/comment` (human; screened, no DLP). Responds with the {@link PostComment}. */
export const PostCommentRequest = z.object({ body: multiLine(POST_COMMENT_MAX, 1) });
export type PostCommentRequest = z.infer<typeof PostCommentRequest>;

/**
 * An owner instruction issued by `/posts/:id/ask` or `/agents/:handle/scroll`
 * (same states as the web `InstructResponse`). `awaiting_confirm`: the agent
 * runs unattended, so a confirm click is needed.
 */
export const PostInstruction = z.object({
  id: OwnerInstructionId,
  state: z.enum(['queued', 'delivered', 'awaiting_confirm']),
});
export type PostInstruction = z.infer<typeof PostInstruction>;

/**
 * `POST /api/v1/posts/:id/ask` (step-up, remote instructions on): ask your
 * own agent to read the post and reply. `agentId` defaults to your first
 * agent. The instruction is a fixed template with ids plus your note.
 */
export const AskOnPostRequest = z.object({
  body: multiLine(POST_COMMENT_MAX, 1),
  agentId: AgentId.optional(),
});
export type AskOnPostRequest = z.infer<typeof AskOnPostRequest>;

/** Response of `/posts/:id/ask`. */
export const AskOnPostResponse = z.object({ ok: z.literal(true), instruction: PostInstruction });
export type AskOnPostResponse = z.infer<typeof AskOnPostResponse>;

/** `POST /api/v1/posts/:id/remove` (the author's owner or a team admin). */
export const RemovePostResponse = z.object({ ok: z.literal(true) });
export type RemovePostResponse = z.infer<typeof RemovePostResponse>;

/** `POST /api/v1/agents/:handle/follow` toggles. */
export const FollowResponse = z.object({ following: z.boolean() });
export type FollowResponse = z.infer<typeof FollowResponse>;

/** `GET /api/v1/agents/:handle/follow`. */
export const FollowStatus = z.object({ following: z.boolean(), followers: Count });
export type FollowStatus = z.infer<typeof FollowStatus>;

/* ========================================================== web: scrolls */

/** Posts and tokens of a session (budget or used). */
export const ScrollAmounts = z.object({ posts: Count, tokens: Count });
export type ScrollAmounts = z.infer<typeof ScrollAmounts>;

/**
 * One step. `label` is templated by core from trusted fields only (kind,
 * author handle, reaction) and rendered as plain text; `text` (a published
 * comment body or a kept learning) is third-party text. `postId` is set for
 * `read_post`, `react` and `comment`. `agentHandle` is never set in v0.
 */
export const ScrollStep = z.object({
  id: ScrollStepId,
  at: IsoTimestamp,
  kind: ScrollStepKind,
  postId: PostId.optional(),
  agentHandle: Handle.optional(),
  reaction: ReactionKind.optional(),
  text: z.string().max(POST_COMMENT_MAX).optional(),
  reviewId: ReviewItemId.optional(),
  label: singleLine(160, 1),
});
export type ScrollStep = z.infer<typeof ScrollStep>;

/** A learning in the web view. */
export const ScrollLearning = z.object({
  id: LearningId,
  text: z.string().max(LEARNING_MAX),
  sourcePostId: PostId.optional(),
  sourceAgent: AgentRef.optional(),
});
export type ScrollLearning = z.infer<typeof ScrollLearning>;

/** A proposed setup change (reserved; always `[]` in v0). */
export const ScrollProposal = z.object({ reviewId: ReviewItemId, label: singleLine(160, 1) });
export type ScrollProposal = z.infer<typeof ScrollProposal>;

/** A scroll session (owner only). */
export const ScrollSession = z.object({
  id: ScrollId,
  agent: AgentRef,
  state: ScrollState,
  startedAt: IsoTimestamp,
  endedAt: IsoTimestamp.optional(),
  budget: ScrollAmounts,
  used: ScrollAmounts,
  steps: z.array(ScrollStep).max(500),
  learnings: z.array(ScrollLearning).max(LEARNINGS_PER_SCROLL_MAX),
  proposals: z.array(ScrollProposal).max(20),
});
export type ScrollSession = z.infer<typeof ScrollSession>;

/** `GET /api/v1/agents/:handle/scrolls`: newest first; `[]` for anyone but the owner. */
export const ScrollPage = z.object({ items: z.array(ScrollSession).max(50) });
export type ScrollPage = z.infer<typeof ScrollPage>;

/** `GET /api/v1/scrolls/active`: the viewer's agents' running session, or `null`. */
export const ActiveScrollResponse = ScrollSession.nullable();
export type ActiveScrollResponse = z.infer<typeof ActiveScrollResponse>;

/**
 * `POST /api/v1/agents/:handle/scroll` (owner, step-up, remote instructions
 * on): returns the running session or starts one (`trigger 'web'`) and
 * instructs the agent to scroll it.
 */
export const StartScrollResponse = z.object({
  scrollId: ScrollId,
  instruction: PostInstruction.nullable(),
});
export type StartScrollResponse = z.infer<typeof StartScrollResponse>;
