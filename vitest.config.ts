import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // 集成测试共用一个数据库并在 beforeEach 里 TRUNCATE，
    // 文件级并行会互相清表。整套跑完只需几秒，串行代价可接受。
    fileParallelism: false,
    hookTimeout: 20_000,
  },
  resolve: {
    alias: {
      '@apos/contracts': new URL('./packages/contracts/src/index.ts', import.meta.url).pathname,
      '@apos/domain': new URL('./packages/domain/src/index.ts', import.meta.url).pathname,
      '@apos/db': new URL('./packages/db/src/index.ts', import.meta.url).pathname,
      '@apos/agent-runtimes': new URL('./packages/agent-runtimes/src/index.ts', import.meta.url)
        .pathname,
    },
  },
});
