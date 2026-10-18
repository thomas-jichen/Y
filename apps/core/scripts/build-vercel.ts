/**
 * Bundles the Vercel function: src/vercel-entry.ts + every workspace package (consumed as
 * TypeScript source) into api/index.mjs, so Vercel's Node builder only sees plain JS.
 * PGlite is replaced by a stub: serverless core always uses Postgres (DATABASE_URL).
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const stub = fileURLToPath(new URL('./pglite-stub.ts', import.meta.url));

await build({
  entryPoints: [`${root}src/vercel-entry.ts`],
  outfile: `${root}api/index.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'linked',
  external: ['pg-native'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  plugins: [{
    name: 'stub-pglite',
    setup(b) {
      b.onResolve({ filter: /(^@electric-sql\/pglite)|(\/pglite\.js$)/ }, () => ({ path: stub }));
    },
  }],
  logLevel: 'info',
});
