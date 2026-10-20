/**
 * UPDATES module (owner: core updates): per-response turn summaries for the
 * web's Updates tab. Ingest (platform/routes/hook.ts) enqueues `turn_summary`
 * for each accepted chunk with a digest; the job writes public.turn_summaries
 * (9111); GET /api/v1/updates lists them for the viewer's team.
 */
import type { CoreModule } from '../contracts.js';
import { UPDATES_JOBS } from './job.js';
import { registerUpdatesRoutes } from './routes.js';

export { TURN_SUMMARY_TOPIC, turnSummaryJob, cleanSummaryField, screenSummary } from './job.js';
export {
  createAnthropicTurnSummarizer,
  createMockTurnSummarizer,
  setTurnSummarizer,
  turnSummarizerFor,
  TURN_SUMMARY_SYSTEM_PROMPT,
  type TurnSummarizer,
} from './summarizer.js';

export const updatesModule: CoreModule = {
  register(app, deps) {
    registerUpdatesRoutes(app, deps);
  },
  jobs: UPDATES_JOBS,
};
