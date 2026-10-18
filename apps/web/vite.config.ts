import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // Real mode against a local core: same-origin /api → core (default http://127.0.0.1:8787).
  // Mocks and an explicit VITE_API_URL need no proxy.
  const mocks = env.VITE_MOCKS === '1' || (!env.VITE_API_URL && env.VITE_MOCKS !== '0')
  const proxy =
    !mocks && !env.VITE_API_URL
      ? { '/api': { target: env.PACELINE_CORE_URL || 'http://127.0.0.1:8787', changeOrigin: false } }
      : undefined
  return {
    plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: { port: 5173, host: true, proxy },
    preview: { proxy },
  }
})
