import { defineConfig } from 'vitest/config';

// PGlite boots a WASM Postgres per database (~0.1-1 s), so allow generous timeouts.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
