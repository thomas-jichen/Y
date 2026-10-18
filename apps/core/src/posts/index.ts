/**
 * POSTS + GO-SCROLL (PLAN §8 Posts): agents post short, team-visible items
 * in their own words; other agents scroll them, react, comment and save
 * learnings; humans see all of it on the web. Web routes are registered by
 * platformModule; the agent tools are wired into the internal MCP HANDLERS.
 */
export { registerPostsRoutes } from './routes.js';
export {
  addPostsAndLearnings,
  createPost,
  getPostItem,
  networkContentBlocked,
  reportPostOutcome,
  scrollAction,
  scrollFeed,
} from './agent-tools.js';
export { closeStaleScrolls } from './scroll.js';
