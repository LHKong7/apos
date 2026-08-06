import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

export type Database = ReturnType<typeof createDatabase>;

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
