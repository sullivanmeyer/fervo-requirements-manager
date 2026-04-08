import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://api:8000',
        changeOrigin: true,
        timeout: 0,         // no proxy timeout — LLM calls can take 60+ s
        proxyTimeout: 0,    // covers the backend response wait as well
      },
    },
  },
})
