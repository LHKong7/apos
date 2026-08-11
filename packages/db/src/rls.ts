import { sql } from 'drizzle-orm';
import type { Database } from './client';

export interface RlsAudit {
  /**
   * 这个库上是否存在 PostgREST 的角色。
   *
   * 存在就说明库跑在 Supabase 这类托管平台上，public schema 下的表**默认**
   * 会被生成一套匿名 REST 接口；不存在（本机 / docker-compose）就压根没有
   * 那条对外通道，RLS 开不开都不影响暴露面。
   */
  exposed: boolean;
  /** public 下没开 RLS 的表名 */
  unprotected: string[];
}

/**
 * 查一遍 RLS 覆盖情况。
 *
 * ★★ 迁移 0017 已经把当时存在的表全开了 RLS，并回收了默认授权 ——
 *   照理说后面新建的表也进不了 PostgREST。这里再查一次，是因为那两层
 *   都可能被绕开：有人手工 `GRANT`、有人在 Supabase 控制台点了按钮、
 *   或者某次迁移显式改了默认权限。
 *
 * ★ 漏掉的后果没有任何症状（应用照常跑、日志干净），只有被拖库之后才会
 *   知道 —— 所以它必须在**启动时**主动喊出来，而不是等谁想起来去查。
 *   这与 probeGit 是同一个道理：环境缺陷要在启动时暴露，不要等第一次
 *   真实调用才以另一种面貌炸出来。
 */
export async function auditRls(db: Database): Promise<RlsAudit> {
  const rows = await db.execute<{ exposed: boolean; unprotected: string[] }>(sql`
    SELECT
      EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
      ) AS exposed,
      COALESCE(
        (
          SELECT array_agg(c.relname ORDER BY c.relname)
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relkind IN ('r', 'p')
            AND NOT c.relrowsecurity
        ),
        ARRAY[]::text[]
      ) AS unprotected
  `);

  // postgres-js 驱动下 execute 直接返回行数组；只会有一行
  const row = (rows as unknown as Array<{ exposed: boolean; unprotected: string[] }>)[0];
  return {
    exposed: row?.exposed ?? false,
    unprotected: row?.unprotected ?? [],
  };
}
