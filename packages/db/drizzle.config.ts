import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // 5433 —— 与 main.ts / seed-dev.ts / test/db.ts 及 docker-compose 一致。
    // 这里曾经是 5432，于是不带 DATABASE_URL 直接跑 `pnpm db:migrate`
    // 会连到宿主机上那个不相干的 Postgres 去
    url: process.env['DATABASE_URL'] ?? 'postgres://apos:apos@localhost:5433/apos',
  },
  casing: 'snake_case',
});
