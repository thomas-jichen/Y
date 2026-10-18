// Unit tests for the web app's pure logic and static rendering (no DOM, no network).
// vitest comes from the monorepo root (this app is a standalone npm project for Vercel, so it is
// not a dependency here); test files are excluded from tsconfig so the Vercel build never needs it.
import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { include: ['src/**/*.test.{ts,tsx}'], environment: 'node' },
})
