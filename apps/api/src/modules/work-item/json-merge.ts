import { sql, type SQL } from 'drizzle-orm';
import { workItems } from '@apos/db';

/**
 * `work_items` 上 jsonb 列的**原子**合并。
 *
 * ★★ 要解决的是丢更新（lost update）。
 *
 *   这几列的写法一直是「先 SELECT 出来、在 JS 里展开、再整列写回」，
 *   而那三步之间没有锁也没有版本校验。两个写入者撞上时，后写的那个
 *   带着**它读到的那份旧值**覆盖全列，先写的那次就凭空消失了。
 *
 *   这不是理论上的并发：`typeData.qualityGate` 有两个真实的写入者 ——
 *   Agent 收尾时的工作区核验（ingest.ts）与 CI 结果回灌（integrations.ts）。
 *   它们本来就会在同一段时间落到同一个任务上，而丢掉的那一半
 *   恰恰是 `qualityGatePassed` 这道门禁的证据来源。
 *   表现是「CI 明明红了，任务却过了评审」，事后从日志里什么都看不出来。
 *
 *   改成一条 UPDATE 里用 Postgres 自己的 jsonb 合并算：读与写在同一个
 *   语句里，行锁由 Postgres 负责，中间没有可以插进去的窗口。
 *
 * ★ 不走 transition() 的乐观锁，是因为这几列本来就不该走那条路：
 *   它们不改状态，也就不该产生状态流转事件，更不该因为并发写
 *   把调用方顶回去重试 —— 质量门禁的证据是「补充」，天然可合并。
 *
 * Atomic merges for the jsonb columns on `work_items`. These were previously
 * read-modify-write across three statements with no lock, so concurrent
 * writers silently clobbered each other — most consequentially on
 * `typeData.qualityGate`, which has two real writers (the Agent's workspace
 * check and the CI ingest). Losing either half loses the evidence the
 * `qualityGatePassed` gate reads. Postgres does the merge in one statement.
 */

/** 顶层浅合并：`typeData || patch` */
export function mergeTypeData(patch: Record<string, unknown>): SQL {
  return sql`${workItems.typeData} || ${JSON.stringify(patch)}::jsonb`;
}

/**
 * 合并进 typeData 下的某个子对象，其余键不动。
 *
 * ★ 子对象也用合并而不是替换：写 qualityGate 的两方各自只知道一部分字段
 *   （一方有 testsPassed / testCommand，另一方有 coverage / ciSha），
 *   整体替换会把对方那几个字段抹掉 —— 那正是这个函数要防的事。
 */
export function mergeTypeDataNested(key: string, patch: Record<string, unknown>): SQL {
  return sql`
    ${workItems.typeData} || jsonb_build_object(
      ${key}::text,
      COALESCE(${workItems.typeData} -> ${key}::text, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
    )
  `;
}

/** 往 jsonb 数组列尾部追加，不覆盖已有元素 */
export function appendConstraints(items: unknown[]): SQL {
  return sql`COALESCE(${workItems.constraints}, '[]'::jsonb) || ${JSON.stringify(items)}::jsonb`;
}
