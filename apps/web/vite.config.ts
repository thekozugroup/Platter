import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API_TARGET = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    /*
     * The dev server proxies the API rather than enabling permissive CORS, so development
     * runs same-origin exactly like production does — which means cookie behaviour
     * (SameSite, Secure) is exercised for real instead of only in prod.
     */
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: API_TARGET, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    /* Warn early: the API serves this bundle, and a fat SPA slows every cold load. */
    chunkSizeWarningLimit: 600,
    /*
     * Chunking is left to rolldown. Hand-written `manualChunks` groups tend to fight the
     * route-level lazy boundaries the router already establishes, and rolldown's default
     * splitting respects those.
     */
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    /*
     * Only unit tests. `e2e/` holds Playwright specs, which use a different `test` global —
     * collecting them here fails at import with "Playwright Test did not expect
     * test.describe() to be called here", which looks like a broken test rather than the
     * wrong runner. `pnpm test:e2e` runs those.
     */
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
  },
});
