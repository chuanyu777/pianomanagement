import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: process.env.CORE_API_PROXY_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: true,
    globals: true,
    // Several interaction specs legitimately take ~4.5s; on a loaded machine the
    // default 5s budget trips before the assertion is reached.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
