import { eq, sql } from 'drizzle-orm';
import { projects, type Database, type DbTransaction } from '@apos/db';

/**
 * 工作项的人类可读编号 —— `<项目前缀>-<项目内序号>`（`ORD-19`）。
 *
 * ★★ 存在的理由是「能用嘴说出来」。
 *
 *   在此之前工作项只有 uuid：站会上没法念，聊天里没法提，提交信息里
 *   写进去也没人认得 —— 「那个订单导出的任务」是唯一的指代方式，
 *   而一个项目里往往有三个叫这个的。
 *
 * ★ 前缀跟着项目走而不是全局自增：`ORD-19` 一眼看得出属于哪个项目，
 *   而 `#4821` 只说明它是第 4821 条被创建的东西。
 */

const IDENTIFIER_RE = /^[A-Z][A-Z0-9]{1,9}$/;

export { IDENTIFIER_RE };

/**
 * 分配 n 个连号。
 *
 * ★★ 用一条 `UPDATE … RETURNING` 原子地推游标，不是「先读再写」。
 *
 *   读-改-写在并发下会把同一个号发给两个调用者，而后果不是报错 ——
 *   唯一约束会让**第二个插入失败**，表现成「建任务偶尔失败」，
 *   一个只在有人同时操作时出现、复现不了的故障。
 *
 * ★ 一次性要 n 个（计划分解一次建十几条），不是循环调 n 次：
 *   循环会让这十几条的号中间插进别人的号，而同一份计划出来的任务
 *   编号不连续，读起来像是丢了几条。
 *
 * @returns 分配到的号，从小到大
 */
export async function allocateNumbers(
  db: Database | DbTransaction,
  projectId: string,
  count: number,
): Promise<number[]> {
  if (count <= 0) return [];

  const [row] = await db
    .update(projects)
    .set({ workItemSeq: sql`${projects.workItemSeq} + ${count}` })
    .where(eq(projects.id, projectId))
    .returning({ seq: projects.workItemSeq });

  if (!row) throw new Error(`项目 ${projectId} 不存在，无法分配工作项编号`);

  // RETURNING 给的是加完之后的值，所以这批号是 (seq-count, seq]
  const end = row.seq;
  return Array.from({ length: count }, (_, i) => end - count + 1 + i);
}

/** `ORD-19`。number 为空（迁移之前的存量）时回落到 `ORD-?`，不编一个号出来 */
export function formatRef(identifier: string, number: number | null): string {
  return `${identifier}-${number ?? '?'}`;
}

/**
 * 从项目名推一个前缀。
 *
 * ★ 中文名取不出东西（正则之后是空串），回落到 `PRJ` —— 而不是
 *   要求用户先想一个英文缩写。那是把实现细节变成了他的问题。
 */
export function suggestIdentifier(name: string): string {
  const base = name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^[0-9]+/, '')
    .slice(0, 4);
  return IDENTIFIER_RE.test(base) ? base : 'PRJ';
}

/**
 * 在组织内找一个没被占用的前缀。
 *
 * ★ 组织内唯一而不是全局唯一：`ORD-19` 要在**一个组织的语境里**
 *   无歧义就够了，跨组织撞车没人会看到。全局唯一的话，
 *   第二家公司建"订单系统"就得叫 ORD2，而他们并不知道为什么。
 */
export async function freeIdentifier(
  db: Database | DbTransaction,
  orgId: string,
  name: string,
): Promise<string> {
  const base = suggestIdentifier(name);
  const taken = new Set(
    (
      await db
        .select({ identifier: projects.identifier })
        .from(projects)
        .where(eq(projects.orgId, orgId))
    ).map((r) => r.identifier),
  );

  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`前缀 ${base} 及其编号变体都被占用了`);
}
