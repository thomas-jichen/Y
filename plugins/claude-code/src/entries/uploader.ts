/** `node scripts/dist/uploader.mjs [--final]`: detached outbox drainer. */
import { drainOutbox } from '../uploader.js';
import { loadConfig, paths } from '../runtime.js';

async function main(): Promise<void> {
  const final = process.argv.includes('--final');
  const config = loadConfig(process.env);
  await drainOutbox({ config, paths: paths(config.dataDir), fetch, budgetMs: final ? 20_000 : 90_000 });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
