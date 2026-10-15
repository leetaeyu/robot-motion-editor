/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Cloudflare Tunnel (cloudflared) serves the dev server under *.trycloudflare.com
  server: { allowedHosts: ['.trycloudflare.com'] },
  test: { testTimeout: 20000, environment: 'node', exclude: ['e2e/**', 'node_modules/**'] },
})
