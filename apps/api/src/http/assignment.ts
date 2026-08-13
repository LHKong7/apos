import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { agents, projectMembers, users, workItems, type Database } from '@apos/db';
import { ExecutionMode } from '@apos/contracts';
import type { RuntimeRegistry } from '@apos/agent-runtimes';
import { executionModeOf, resolveExecutor } from '../modules/agent/matching';
import { ApiError, notFound } from './errors';

/**
 * 执行者分配 —— 「谁来干」与「什么时候开干」分成两件事。
 *
 * ★★ 为什么必须拆开。
 *
 *   此前只有 `POST /work-items/:id/assign`，它在保存执行者的同一次调用里
 *   就把 Run 派了出去。于是「我先把这张卡挂到某个 Agent 名下，回头再跑」
 *   这个再普通不过的动作做不到 —— 用户以为自己只是在下拉框里选了个人，
 *   实际上 Agent 立刻开始改文件、开始烧预算。一个「选择」不该有副作用，
 *   更不该有不可逆的副作用。
 *
 *   拆完之后：
 *     PATCH /work-items/:id/assignee   只写 executor，不动状态、不派发
 *     POST  /work-items/:id/start      真正开始执行（人工点，或调度器来点）
 *
 *   旧的 /assign 保留为「设置执行者并立刻开始」的组合语义（见 routes.ts），
 *   这样已经接了它的调用方不会断，但新界面一律走拆开的这两个。
 */

export const AssigneeInput = z
  .object({
    /** 二选一；两个都不传表示清空执行者，回到「未指定」 */
    agentId: z.string().uuid().nullable().optional(),
    userId: z.string().uuid().nullable().optional(),
    /**
     * 顺带改执行方式。不传就按传入的执行者推断：
     * 指了 Agent 就是 agent，指了人就是 human，都清空就是 auto。
     */
    executionMode: ExecutionMode.optional(),
  })
  .refine((v) => !(v.agentId && v.userId), {
    message: '不能同时指定 agentId 与 userId',
  });

export type AssigneeInputType = z.infer<typeof AssigneeInput>;

/**
 * 只保存执行者，不开始执行。
 *
 * ★ 不走 transition()：这里没有状态流转 —— 一张 ready 的卡换个执行者之后
 *   还是 ready。硬套一次流转只会在事件流里制造出「进入 ready」这种
 *   根本没发生的事，而事件流是审计与 Analytics 的唯一数据源。
 *   执行者变更本身作为领域事件单独发（调用方负责，见 routes.ts）。
 */
export async function setAssignee(
  db: Database,
  workItemId: string,
  input: AssigneeInputType,
) {
  const [item] = await db.select().from(workItems).where(eq(workItems.id, workItemId));
  if (!item) throw notFound('任务');

  if (input.agentId) await assertAgentAssignable(db, item.projectId, input.agentId);
  if (input.userId) await assertUserAssignable(db, item.projectId, input.userId);

  const executorType = input.agentId ? 'agent' : input.userId ? 'human' : null;
  const executorId = input.agentId ?? input.userId ?? null;
  const mode =
    input.executionMode ??
    (executorType === 'agent' ? 'agent' : executorType === 'human' ? 'human' : 'auto');

  await db
    .update(workItems)
    .set({
      executorType,
      executorId,
      // ★ executionMode 存在 typeData 里，与 requiredSkills / requiredTools 同处
      typeData: { ...item.typeData, executionMode: mode },
      updatedAt: new Date(),
    })
    .where(eq(workItems.id, workItemId));

  return {
    ok: true as const,
    workItemId,
    executorType,
    executorId,
    executionMode: mode,
  };
}

/**
 * Agent 必须是**本项目成员**才能被指派。
 *
 * ★★ 与调度器同一条判据（modules/agent/matching.ts）。两处各写一套的话，
 *   会出现「手动指派得上、调度器却说它不是候选」这种自相矛盾的状态。
 */
async function assertAgentAssignable(db: Database, projectId: string, agentId: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) throw notFound('Agent');

  const [member] = await db
    .select({ actorId: projectMembers.actorId })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.actorType, 'agent'),
        eq(projectMembers.actorId, agentId),
      ),
    );
  if (!member) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `${agent.name} 不是这个项目的成员 —— 先在「成员与角色」里把它加进来`,
      { agentId },
    );
  }
  if (agent.status !== 'active') {
    throw new ApiError('VALIDATION_FAILED', `${agent.name} 当前状态是 ${agent.status}`, { agentId });
  }
}

async function assertUserAssignable(db: Database, projectId: string, userId: string) {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (!user) throw notFound('用户');

  const [member] = await db
    .select({ actorId: projectMembers.actorId })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.actorType, 'human'),
        eq(projectMembers.actorId, userId),
      ),
    );
  if (!member) {
    throw new ApiError('VALIDATION_FAILED', '这个人不是项目成员，不能被指派', { userId });
  }
}

/**
 * 候选执行者清单 —— 能选谁、为什么不能选谁。
 *
 * ★★ 不可选的也要返回，并带上原因。
 *
 *   只回可选项的话，用户看到的是一个空下拉框，然后无从下手：
 *   是没配 Agent？没加进项目？还是满载了？这四种原因的下一步动作
 *   完全不同。页面文档 04 §5.4 要求改派下拉展示匹配依据，
 *   这里把「不匹配的依据」一并给出来。
 */
export async function listCandidates(
  db: Database,
  registry: RuntimeRegistry,
  workItemId: string,
) {
  const [item] = await db.select().from(workItems).where(eq(workItems.id, workItemId));
  if (!item) throw notFound('任务');

  const match = await resolveExecutor(db, item, { registry });

  const agentRows = await db.select().from(agents).where(eq(agents.orgId, item.orgId));
  const byId = new Map(agentRows.map((a) => [a.id, a]));

  const humanRows = await db
    .select({ id: users.id, name: users.name, email: users.email, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.actorId))
    .where(
      and(eq(projectMembers.projectId, item.projectId), eq(projectMembers.actorType, 'human')),
    );

  const decorate = (agentId: string) => {
    const a = byId.get(agentId);
    return {
      runtimeKind: a?.runtimeKind ?? null,
      status: a?.status ?? null,
      registered: registry.has(agentId),
      maxConcurrency: a?.maxConcurrency ?? null,
    };
  };

  return {
    executionMode: executionModeOf(item.typeData),
    current: { executorType: item.executorType, executorId: item.executorId },
    agents: {
      eligible: match.candidates.map((c) => ({
        agentId: c.agentId,
        name: c.agentName,
        score: c.score,
        reasons: c.reasons,
        ...decorate(c.agentId),
      })),
      ineligible: match.rejected.map((r) => ({
        agentId: r.agentId,
        name: r.agentName,
        reason: r.reason,
        ...decorate(r.agentId),
      })),
    },
    humans: humanRows.map((h) => ({
      userId: h.id,
      name: h.name,
      email: h.email,
      role: h.role,
    })),
  };
}
