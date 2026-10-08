import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Vite + Vitest config for the Aero desktop UI.
 * Dev server proxies /api and /health to the Fastify server (npm run api)
 * so the UI talks to the real engine; in production Fastify serves web/dist.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/health': 'http://127.0.0.1:3000',
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    restoreMocks: true,
  },
});
