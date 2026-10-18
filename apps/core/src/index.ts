/** Public entry for embedding core in-process (e2e tests, serverless adapters). */
export { createApp, allJobHandlers, MODULES } from './app.js';
export { createDeps, loadConfig, CORE_MIGRATIONS_DIR, type CreateDepsOptions } from './platform/index.js';
export type { CoreConfig, CoreDeps, CoreModule } from './contracts.js';
export { createServerlessHandler, type ServerlessHandler, type ServerlessOptions } from './serverless.js';
export { loadSeedHighlights, defaultSeedDir, fit, type SeedResult } from './platform/seed.js';
