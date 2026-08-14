import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { agentRuns, agents, projectMembers, users, workItems, type Database } from '@apos/db';
import { ACTIVE_RUN_STATUSES, ExecutionMode } from '@apos/contracts';
import type { RuntimeRegistry } from '@apos/agent-runtimes';
import { executionModeOf, resolveExecutor } from '../modules/agent/matching';
import { mergeTypeData } from '../modules/work-item/json-merge';
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

/**
 * 运行中的任务被改派时怎么处置那次执行。
 *
 * ★★ 没有这一档时，改派是**静默**的：Run 还在跑，卡片上却已经写着另一个人。
 *   那次执行继续改文件、继续花钱，产出最后挂在一张不属于它的卡上，
 *   而新执行者对此一无所知。三种处置都合理，但必须由人选一个 ——
 *   默认哪一个都会在某些场景下出错，所以不给默认值。
 */
export const TakeoverMode = z.enum([
  /** 终止当前 Run，立刻交给新执行者 */
  'terminate',
  /** 让它跑完，改派只对**下一次**执行生效 */
  'wait',
  /** 转人工接管：终止 Run 并把卡片交给人 */
  'handover',
]);
export type TakeoverMode = z.infer<typeof TakeoverMode>;

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
    /**
     * 有 Run 在跑时必须给出处置方式。不给就拒 —— 见 TakeoverMode 的理由。
     */
    takeover: TakeoverMode.optional(),
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
  deps: { registry?: RuntimeRegistry } = {},
) {
  const [item] = await db.select().from(workItems).where(eq(workItems.id, workItemId));
  if (!item) throw notFound('任务');

  /**
   * ★★ 有 Run 在跑时不能静默改派。
   *
   *   Run 还在执行，卡片却已经写着另一个人：那次执行继续改文件、继续花钱，
   *   产出最后挂在一张不属于它的卡上，而新执行者对此一无所知。
   *   拦下来要求调用方明确选一种处置 —— 三种都合理，但没有一个可以当默认。
   */
  const active = await db
    .select({ id: agentRuns.id, agentId: agentRuns.agentId })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.workItemId, workItemId),
        inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
      ),
    );

  const changingExecutor =
    (input.agentId ?? input.userId ?? null) !== item.executorId;

  if (active.length > 0 && changingExecutor && !input.takeover) {
    throw new ApiError(
      'VALIDATION_FAILED',
      '这张卡还有执行中的 Run。改派前要说明怎么处置它：terminate（终止后立刻交接）、' +
        'wait（让它跑完，改派对下一次生效）、handover（终止并转人工接管）。',
      { runIds: active.map((r) => r.id), currentExecutorId: item.executorId },
    );
  }

  if (input.agentId) await assertAgentAssignable(db, item.projectId, input.agentId);
  if (input.userId) await assertUserAssignable(db, item.projectId, input.userId);

  /**
   * ★ handover 要求交给人。交给另一个 Agent 却说「转人工接管」，
   *   两者会在事件流里对不上 —— 而事件流是审计的唯一依据。
   */
  if (input.takeover === 'handover' && !input.userId) {
    throw new ApiError('VALIDATION_FAILED', '转人工接管必须指定接手的人（userId）');
  }

  /**
   * ★★ wait 语义下**不动**正在跑的 Run：改派只对下一次执行生效。
   *   另外两种都要先把 Run 停掉，否则它会继续改文件、继续花钱，
   *   而卡片已经不属于它了。
   */
  const terminated: string[] = [];
  if (active.length > 0 && (input.takeover === 'terminate' || input.takeover === 'handover')) {
    for (const run of active) {
      await terminateRun(db, deps.registry, run, input.takeover);
      terminated.push(run.id);
    }
  }

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
      /**
       * ★ executionMode 存在 typeData 里，与 requiredSkills / requiredTools 同处。
       *   只合并这一个键，不把读到的整份 typeData 写回去 —— 从上面那次 SELECT
       *   到这里之间，qualityGate 可能已经被 CI 或 Agent 收尾改过了，
       *   整列覆盖会把它抹掉。见 work-item/json-merge.ts。
       */
      typeData: mergeTypeData({ executionMode: mode }),
      updatedAt: new Date(),
    })
    .where(eq(workItems.id, workItemId));

  return {
    ok: true as const,
    workItemId,
    executorType,
    executorId,
    executionMode: mode,
    /** ★ 明确回报终止了哪几个 Run —— 调用方要能把这件事显示给用户 */
    terminatedRuns: terminated,
  };
}

/**
 * 改派时终止一次执行。
 *
 * ★ 先发控制指令再写库：库先写完而指令失败的话，Run 在库里是 terminated、
 *   在运行时里还在跑 —— 那种不一致没有任何地方能发现。
 *
 * ★ 运行时不认识这个 Run（进程重启过、适配器没注册）不算失败：
 *   库里标成 terminated 之后，supervisor 那条心跳超时的路径本来就会兜底。
 */
async function terminateRun(
  db: Database,
  registry: RuntimeRegistry | undefined,
  run: { id: string; agentId: string },
  mode: TakeoverMode,
): Promise<void> {
  if (registry?.has(run.agentId)) {
    await registry
      .get(run.agentId)
      .control(run.id, {
        action: 'terminate',
        reason: mode === 'handover' ? '改派：转人工接管' : '改派：更换执行者',
      })
      .catch(() => undefined);
  }

  await db
    .update(agentRuns)
    .set({
      status: 'terminated',
      endedAt: new Date(),
      errorClass: 'runtime_error',
      errorMessage: mode === 'handover' ? '改派：转人工接管' : '改派：更换执行者',
    })
    .where(eq(agentRuns.id, run.id));
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
