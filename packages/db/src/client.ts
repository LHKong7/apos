import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { inspectConnection } from './connection';
import * as schema from './schema/index';

export type Database = ReturnType<typeof createDatabase>;

/**
 * 事务句柄。
 *
 * ★ 有些函数（建组织时预置内置角色）既要能独立调用，也要能在事务里调用。
 *   `Database` 上多一个 `$client`，事务句柄没有 —— 所以签名要写成两者的并集，
 *   否则调用方只能在事务里 `as never` 蒙混过去，而那会连真正的类型错误一起吞掉。
 */
export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DbConfig {
  url: string;
  max?: number;
  /** 测试环境用 1，避免连接池导致事务隔离问题 */
  singleConnection?: boolean;
}

export function createDatabase(config: DbConfig) {
  /**
   * ★ prepare / ssl 由连接串自己决定，调用方不用关心连的是本机还是 Supabase
   *   （判定规则与它的代价见 connection.ts）。直连与 Session Pooler 下
   *   prepare 是 true，与 postgres.js 的默认值一致 —— 也就是说本机与
   *   docker-compose 的行为一个字都没变。
   */
  const shape = inspectConnection(config.url);
  const sql = postgres(shape.url, {
    max: config.singleConnection ? 1 : (config.max ?? 10),
    prepare: shape.prepare,
    // 传 undefined 会盖掉 postgres.js 从连接串里解析出来的 sslmode，所以要条件展开
    ...(shape.ssl ? { ssl: shape.ssl } : {}),
    onnotice: () => {},
  });
  return drizzle(sql, { schema, casing: 'snake_case' });
}

export { schema };
