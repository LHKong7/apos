import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { projects, workItems, type Database } from '@apos/db';
import { humanActor, OperationType, STATUS_STAGE, WorkItemType } from '@apos/contracts';
import { emitAndPublish } from '../modules/event/bus';
import { allocateNumbers, formatRef } from '../modules/work-item/numbering';
import { notFound } from './errors';

/**
 * 手工创建工作项。
 *
 * ★★ 在此之前工作项**只能被生成出来**：唯一的创建路径是
 *   `需求 → analyze → 计划 → 批准 → 分解成任务`。
 *   那条链是产品的核心（两道 Human Gate 都在上面），但它同时意味着
 *   「随手记一个 bug」「加一条调研」这类动作在系统里做不到 ——
 *   而那正是任何任务系统最高频的一个动作。
 *
 * ★★ 补上入口的同时不能把门禁一起补没了。
 *
 *   手工建的任务如果建完就能派发，那么任何能建任务的人都可以让 Agent
 *   去做任意事情 —— `requirement.approve` 与 `plan.approve` 两道
 *   Human Gate 就都被绕开了，而且绕开的方式在接口清单上完全看不出来。
 *
 *   所以：**手工建的任务一律停在 `draft`**，它不可派发。
 *   要让它跑起来，得走 `draft → ready`，而那一步要 `plan.approve`
 *   （见 routes.ts 的状态路由）。门禁没有消失，只是粒度从
 *   「批一份计划」变成「批一个任务」。
 */

export const WorkItemInput = z.object({
  title: z.string().min(1, '标题不能为空').max(500),
  description: z.string().max(20_000).nullable().optional(),
  type: WorkItemType.default('task'),
  /** 1 = 最高。与计划生成出来的任务同一套口径 */
  priority: z.number().int().min(0).max(4).default(2),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']).default('low'),
  /** 人类负责人（问责）。执行主体另外指派 —— 两者刻意分开 */
  ownerId: z.string().uuid().nullable().optional(),
  estimatedHours: z.number().min(0).max(10_000).nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  /**
   * 这个任务算哪一类操作（Policy 的 `operationType` fact）。
   *
   * ★★ 不给就是 `code_change`（在 buildPolicyContext 里兜底）—— 而这个兜底
   *   对「随手记一个 bug」是对的，对「清理一批线上资源」是错的：
   *   后者会被当成改代码来评估，删资源那条安全底线根本轮不到。
   *   手工建卡是唯一没有规划阶段替它标操作类型的入口，所以要问一句。
   *
   * ★ 严格枚举，认不出的值直接 400。兜底成 `code_change` 等于往**宽**的
   *   一侧猜，而这一栏的全部意义就是别让人猜。
   *
   * Which operation class this item is. Absent means `code_change`, which is
   * right for "jot down a bug" and wrong for "clean up some production
   * resources": the latter would be judged as a code change and never reach
   * the delete-resource floor. Manual creation is the one entry point with no
   * planning stage to mark this, so it asks.
   */
  operationType: OperationType.optional(),
});

export async function createWorkItem(
  db: Database,
  ctx: { projectId: string; actorId: string; correlationId: string },
  input: z.infer<typeof WorkItemInput>,
) {
  const [project] = await db
    .select({ id: projects.id, orgId: projects.orgId, identifier: projects.identifier })
    .from(projects)
    .where(eq(projects.id, ctx.projectId));
  if (!project) throw notFound('project');

  if (input.parentId) {
    const [parent] = await db
      .select({ projectId: workItems.projectId })
      .from(workItems)
      .where(eq(workItems.id, input.parentId));
    /**
     * ★ 父任务必须在同一个项目里。跨项目的父子关系会让子树查询、
     *   依赖图、看板的归属全部说不清 —— 而这三处各自都不会报错，
     *   只是各显示各的。
     */
    if (!parent || parent.projectId !== ctx.projectId) {
      throw notFound('parent_work_item');
    }
  }

  const [number] = await allocateNumbers(db, ctx.projectId, 1);

  const [row] = await db
    .insert(workItems)
    .values({
      orgId: project.orgId,
      projectId: ctx.projectId,
      number: number!,
      type: input.type,
      /**
       * ★★ 一律 draft，不接受调用方指定状态。
       *   开一个 `status` 参数就等于把上面那道门禁交给调用方自觉。
       */
      status: 'draft',
      stage: STATUS_STAGE['draft'],
      title: input.title.trim(),
      description: input.description?.trim() || null,
      priority: input.priority,
      riskLevel: input.riskLevel,
      ownerId: input.ownerId ?? ctx.actorId,
      parentId: input.parentId ?? null,
      estimatedHours:
        input.estimatedHours === null || input.estimatedHours === undefined
          ? null
          : String(input.estimatedHours),
      /** ★ 留痕：这条不是计划分解出来的。审计时「它是怎么来的」要答得上 */
      typeData: {
        origin: 'manual',
        createdBy: ctx.actorId,
        ...(input.operationType ? { operationType: input.operationType } : {}),
      },
    })
    .returning();

  await emitAndPublish(db, {
    orgId: project.orgId,
    projectId: ctx.projectId,
    type: 'work_item.created',
    actor: humanActor(ctx.actorId),
    subjectType: 'work_item',
    subjectId: row!.id,
    payload: {
      title: row!.title,
      type: row!.type,
      origin: 'manual',
      ref: formatRef(project.identifier, row!.number),
    },
    correlationId: ctx.correlationId,
  });

  return {
    item: { ...row, ref: formatRef(project.identifier, row!.number) },
    /**
     * ★ 明确告诉调用方它现在还跑不了、以及下一步是什么。
     *   不说的话，界面上会出现一条建好了却什么都不发生的任务，
     *   而用户完全看不出缺了哪一步。
     */
    notice:
      '任务已创建为草稿。手工建的任务不经过「需求 → 计划 → 批准」那条链，' +
      '所以要由有批准权限的人（tech_lead）放行后才会进入待执行队列。',
  };
}
