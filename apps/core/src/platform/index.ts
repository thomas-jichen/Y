/** PLATFORM module (owner: core-platform agent). Replace this stub. */
import type { CoreConfig, CoreDeps, CoreModule } from '../contracts.js';
import type { Db } from '@paceline/db';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  throw new Error('not implemented: loadConfig');
}

/** Build CoreDeps (auth, bus, jobs, embedder) for a database. `handlers` = all modules' job handlers. */
export async function createDeps(config: CoreConfig, db: Db, handlers: CoreModule['jobs']): Promise<CoreDeps> {
  throw new Error('not implemented: createDeps');
}

export const platformModule: CoreModule = { register() {}, jobs: {} };
