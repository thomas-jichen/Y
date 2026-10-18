import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { fileURLToPath, URL } from 'node:url'
import { devProxyGuard, lanBypass } from './src/lib/devProxyGuard'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // Real mode against a local core: same-origin /api → core (default http://127.0.0.1:8787).
  // Mocks and an explicit VITE_API_URL need no proxy.
  const allowLan = env.Y_WEB_LAN_API === '1'
  const mocks = env.VITE_MOCKS === '1' || (!env.VITE_API_URL && env.VITE_MOCKS !== '0')
  const proxy =
    !mocks && !env.VITE_API_URL
      ? { '/api': { target: env.Y_CORE_URL || 'http://127.0.0.1:8787', changeOrigin: false, bypass: lanBypass(allowLan) } }
      : undefined
  // The server stays reachable on the LAN (host: true), but the /api proxy to a local core (and its
  // secret-free dev login) answers this machine only unless Y_WEB_LAN_API=1 (src/lib/devProxyGuard.ts):
  // a middleware ahead of the proxy, plus the same check in the proxy entry's bypass.
  const guard = devProxyGuard(allowLan)
  const lanGuard: Plugin = {
    name: 'y-dev-proxy-guard',
    configureServer(server) {
      if (proxy) server.middlewares.use(guard)
    },
    configurePreviewServer(server) {
      if (proxy) server.middlewares.use(guard)
    },
  }
  return {
    plugins: [lanGuard, tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: { port: 5173, host: true, proxy },
    preview: { proxy },
  }
})
