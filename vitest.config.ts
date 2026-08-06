import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
  resolve: {
    alias: {
      '@apos/contracts': new URL('./packages/contracts/src/index.ts', import.meta.url).pathname,
      '@apos/domain': new URL('./packages/domain/src/index.ts', import.meta.url).pathname,
      '@apos/db': new URL('./packages/db/src/index.ts', import.meta.url).pathname,
    },
  },
});
