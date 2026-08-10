import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
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
  const sql = postgres(config.url, {
    max: config.singleConnection ? 1 : (config.max ?? 10),
    onnotice: () => {},
  });
  return drizzle(sql, { schema, casing: 'snake_case' });
}

export { schema };
