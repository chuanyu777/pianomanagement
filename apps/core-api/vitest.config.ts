import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Forked workers need room to boot. With the default fan-out, running the whole
    // monorepo at once intermittently produces "Timeout waiting for worker to
    // respond" even though every file passes when this workspace runs alone.
    maxWorkers: 2,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
