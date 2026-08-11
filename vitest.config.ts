import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.{ts,tsx}', 'apps/*/src/**/*.test.{ts,tsx}'],
    environment: 'node',
    // 前端组件测试要 DOM，其余保持 node（快得多）
    environmentMatchGlobs: [['apps/web/**', 'jsdom']],
    setupFiles: ['./apps/web/src/test/setup.ts'],
    globals: false,
    // 集成测试共用一个数据库并在 beforeEach 里 TRUNCATE，
    // 文件级并行会互相清表。整套跑完只需几秒，串行代价可接受。
    fileParallelism: false,
    hookTimeout: 20_000,
  },
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      // ★ 与 apps/web/vite.config.ts 和 tsconfig 保持一致 —— shadcn 组件
      //   之间用 `@/lib/utils` 互相引用，三处缺一处测试就跑不起来
      '@': new URL('./apps/web/src', import.meta.url).pathname,
      '@apos/contracts': new URL('./packages/contracts/src/index.ts', import.meta.url).pathname,
      '@apos/domain': new URL('./packages/domain/src/index.ts', import.meta.url).pathname,
      '@apos/db': new URL('./packages/db/src/index.ts', import.meta.url).pathname,
      '@apos/agent-runtimes': new URL('./packages/agent-runtimes/src/index.ts', import.meta.url)
        .pathname,
      '@apos/workspace-providers': new URL(
        './packages/workspace-providers/src/index.ts',
        import.meta.url,
      ).pathname,
    },
  },
});
