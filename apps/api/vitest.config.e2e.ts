import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    // e2e 连真实数据库，串行跑，避免互相踩数据
    fileParallelism: false,
  },
});
