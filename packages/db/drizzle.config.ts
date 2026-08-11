import { defineConfig } from 'drizzle-kit';
import { inspectConnection, toConnectionUrl } from './src/connection';

/**
 * 迁移用哪条连接串。
 *
 * ★★ DDL 不要走 Transaction Pooler（Supabase 的 :6543）。
 *
 *   那个池子是按**语句**而不是按会话分配后端连接的，而迁移依赖会话内的连续性
 *   （建表 → 建索引 → 加外键在同一个事务里）。它不一定当场报错，更常见的是
 *   跑到一半失败 —— 而迁移失败最贵的形态就是「一半应用了」。
 *
 *   所以留一个 DATABASE_DIRECT_URL：平时后端走 Transaction Pooler（serverless
 *   友好），迁移这一条走直连或 Session Pooler。不设就沿用 DATABASE_URL，
 *   本机与 docker-compose 下两者本来就是同一个。
 */
const raw =
  process.env['DATABASE_DIRECT_URL'] ??
  process.env['DATABASE_URL'] ??
  // 5433 —— 与 main.ts / seed-dev.ts / test/db.ts 及 docker-compose 一致。
  // 这里曾经是 5432，于是不带 DATABASE_URL 直接跑 `pnpm db:migrate`
  // 会连到宿主机上那个不相干的 Postgres 去
  'postgres://apos:apos@localhost:5433/apos';

const shape = inspectConnection(raw);

/**
 * ★ 判定结果要说出来。走错池子的表现是「迁移偶尔失败」，
 *   而运维手上没有任何线索指向端口号。
 */
if (shape.mode === 'pooled-transaction') {
  console.warn(
    `[drizzle] 迁移连的是 Transaction Pooler（${shape.host}:${shape.port}）—— ` +
      'DDL 请改用直连或 Session Pooler，把那条连接串放进 DATABASE_DIRECT_URL。',
  );
}

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // ★ 过一道 inspectConnection：剥掉 `?supa=...` 这类客户端专用参数，
    //   并在连的是 Supabase 时补上 sslmode（drizzle-kit 只收 url，
    //   没法在旁边再传一个 ssl 选项）
    url: toConnectionUrl(shape),
  },
  casing: 'snake_case',
});
