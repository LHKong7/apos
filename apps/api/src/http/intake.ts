import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  plans,
  projects,
  requirementClarifications,
  requirements,
  users,
  workItems,
  type Database,
} from '@apos/db';
import type { AutonomyLevel } from '@apos/contracts';
import { auditPolicies, diffPlans, type PlanSide } from '@apos/domain';
import { notFound } from './errors';
import { loadProjectPolicies } from './policies';

/**
 * 需求录入与计划确认的读取端（页面文档 03 / 04 §9）。
 *
 * 写操作复用已有的 requirement / planning service —— 那里是走真实链路的地方，
 * 这里只负责把它们的产物拼成页面要的形状。
 */

export async function listRequirements(db: Database, projectId: string) {
  const rows = await db
    .select()
    .from(requirements)
    .where(and(eq(requirements.projectId, projectId), isNull(requirements.deletedAt)))
    .orderBy(desc(requirements.createdAt));

  const planRows = await db.select().from(plans).where(eq(plans.projectId, projectId));
  const planByReq = new Map<string, (typeof planRows)[number]>();
  for (const p of planRows) {
    if (!p.requirementId) continue;
    const seen = planByReq.get(p.requirementId);
    if (!seen || p.version > seen.version) planByReq.set(p.requirementId, p);
  }

  return {
    requirements: rows.map((r) => ({
      id: r.id,
      title: r.title ?? firstLine(r.rawInput),
      status: r.status,
      priority: r.priority,
      createdAt: r.createdAt.toISOString(),
      approvedAt: r.approvedAt?.toISOString() ?? null,
      /** 已经有计划的需求，入口应该直接指向计划页而不是需求页 */
      latestPlanId: planByReq.get(r.id)?.id ?? null,
      latestPlanStatus: planByReq.get(r.id)?.status ?? null,
    })),
  };
}

/**
 * 计划详情（页面文档 04 §4 / §5.2 / §5.3）。
 *
 * ★ 「批准后将自动发生」用的是计划生成时的**快照**，不是展示时重算。
 *   用户批准的是「当时那份清单」—— Policy 后来改了，
 *   追溯「他到底批准了什么」必须看快照，而不是一份现在才算出来的清单。
 *   同时给出「按当前规则重算」的结果，两者不一致时页面会明确提示。
 */
export async function getPlanDetail(db: Database, planId: string) {
  const [plan] = await db.select().from(plans).where(eq(plans.id, planId));
  if (!plan) throw notFound('计划');

  const [project] = await db.select().from(projects).where(eq(projects.id, plan.projectId));
  if (!project) throw notFound('项目');

  const tasks = await db
    .select()
    .from(workItems)
    .where(eq(workItems.planId, planId))
    .orderBy(workItems.position);

  const requirement = plan.requirementId
    ? (await db.select().from(requirements).where(eq(requirements.id, plan.requirementId)))[0]
    : undefined;

  const assumptions = requirement
    ? (
        await db
          .select()
          .from(requirementClarifications)
          .where(eq(requirementClarifications.requirementId, requirement.id))
      ).filter((c) => c.level === 'assumption_ok' || c.answer === null)
    : [];

  const userRows = await db.select({ id: users.id, name: users.name }).from(users);
  const userName = new Map(userRows.map((u) => [u.id, u.name]));

  const estimatedTokens = plan.estimatedTokens ?? 0;
  const budget = project.tokenBudget;
  const spent = project.tokensSpent;

  // 当前规则下的边界，用来和快照对照
  const policies = await loadProjectPolicies(db, project.orgId, plan.projectId);
  const current = auditPolicies(policies, project.autonomyLevel as AutonomyLevel);

  /**
   * ★ 人机拆分要从「批准后将自动发生」的快照里推，不能数 work_items 的 executorType。
   *
   *   计划批准之前任务还没被调度，executorType 全是 null ——
   *   按它数出来永远是「🤖 0　👤 0」，而快照同时写着「4 个任务将由 Agent 自动执行」。
   *   这个数字会出现在批准弹窗里，也就是用户让渡执行权的那一刻，
   *   在那里给一个错的自动化比例，比不给还糟。
   */
  const gates = plan.humanGates as { taskTitle: string }[];
  const gatedTitles = new Set(gates.map((g) => g.taskTitle));
  const humanTasks = tasks.filter((t) => gatedTitles.has(t.title)).length;
  const agentTasks = tasks.length - humanTasks;

  return {
    plan: {
      id: plan.id,
      version: plan.version,
      status: plan.status,
      projectId: plan.projectId,
      requirementId: plan.requirementId,
      model: plan.model,
      generationCost: Number(plan.generationCost ?? 0),
      generationMs: plan.generationMs,
      estimatedHours: Number(plan.estimatedHours ?? 0),
      estimatedTokens,
      createdAt: plan.createdAt.toISOString(),
      approvedAt: plan.approvedAt?.toISOString() ?? null,
      approvedBy: plan.approvedBy.map((id) => userName.get(id) ?? id),
      revisionFeedback: plan.revisionFeedback,
      risks: plan.risks,
      phases: plan.phases,
    },
    metrics: {
      taskCount: tasks.length,
      agentTasks,
      humanTasks,
      estimatedHours: Number(plan.estimatedHours ?? 0),
      estimatedTokens,
      budget,
      spent,
      /** ★ 超预算要阻断批准，所以这个判断放服务端算，不让前端各算各的 */
      overBudget: budget !== null && spent + estimatedTokens > budget,
      humanGateCount: (plan.humanGates as unknown[]).length,
      highRiskTasks: tasks.filter((t) => t.riskLevel === 'high' || t.riskLevel === 'critical').length,
    },
    /** 批准时的快照 */
    autoActions: plan.autoActions,
    humanGates: plan.humanGates,
    /** 按当前 Policy 重算的边界，供对照 */
    currentBoundary: {
      auto: current.summary.auto.map((o) => o.label),
      human: current.summary.human.map((o) => o.label),
      depends: current.summary.depends.map((o) => ({ label: o.label, when: o.when })),
    },
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      type: t.type,
      status: t.status,
      stage: t.stage,
      riskLevel: t.riskLevel,
      estimatedHours: t.estimatedHours === null ? null : Number(t.estimatedHours),
      estimatedTokens: t.estimatedTokens,
      executorType: t.executorType,
      executorName:
        t.executorType === 'human' && t.executorId ? (userName.get(t.executorId) ?? '未知') : null,
      /**
       * 批准前执行主体还没绑定，只能说「这一步会不会来找人」。
       * 写成「未分配」会被读成「漏排了」，而实际是「等调度时再挑 Agent」。
       */
      requiresHuman: gatedTitles.has(t.title),
      ownerName: t.ownerId ? (userName.get(t.ownerId) ?? '未知') : null,
      position: t.position,
    })),
    /**
     * 本计划基于哪些未经二次确认的假设（页面文档 04 §5，回应 03 §12.2）。
     * 需求页里「记录假设后继续」的那些问题，到计划页要再复述一遍 ——
     * 计划是基于它们做的，而用户当时可能只是划过去了。
     */
    assumptions: assumptions.map((c) => ({
      id: c.id,
      question: c.question,
      answer: c.answer,
      level: c.level,
      confirmed: c.answer !== null,
    })),
  };
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 40 ? `${line.slice(0, 40)}…` : line || '（无标题）';
}

/**
 * 计划版本对比（页面文档 04）。
 *
 * ★ 用户要批准的是 v2，脑子里记得的是 v1。不给 diff 的话他只能把
 *   三十行任务清单整个重读一遍 —— 而重读一遍的真实结果通常是不读，直接批。
 *   diff 不是便利功能，是让「批准」这个动作重新有意义的东西。
 *
 * ★ 两版的人机拆分都要从各自的 humanGates 快照推。
 *   批准前 work_items.executorType 全是 null，按它数出来两版都是「👤 0」，
 *   于是「这一版把三个人工确认点改成了自动」这条最该被看见的变化，
 *   在 diff 里会完全消失。
 */
export async function comparePlans(db: Database, planId: string, againstVersion?: number) {
  const [plan] = await db.select().from(plans).where(eq(plans.id, planId));
  if (!plan) throw notFound('计划');

  const siblings = await db
    .select()
    .from(plans)
    .where(eq(plans.projectId, plan.projectId))
    .orderBy(desc(plans.version));
  const sameRequirement = siblings.filter((p) => p.requirementId === plan.requirementId);

  const previous =
    againstVersion !== undefined
      ? sameRequirement.find((p) => p.version === againstVersion)
      : sameRequirement.find((p) => p.version < plan.version);

  const versions = sameRequirement.map((p) => ({
    id: p.id,
    version: p.version,
    status: p.status,
    createdAt: p.createdAt.toISOString(),
    isCurrent: p.id === plan.id,
  }));

  if (!previous) {
    // 第一版没有可比对象，如实说，而不是拿一份空计划去 diff 出「全部新增」
    return { versions, diff: null, against: null, feedback: plan.revisionFeedback };
  }

  const [beforeSide, afterSide] = await Promise.all([
    planSide(db, previous),
    planSide(db, plan),
  ]);

  return {
    versions,
    against: { id: previous.id, version: previous.version },
    /**
     * ★ 只取上一版的。当前版本的 revisionFeedback 是「它自己后来被要求改」，
     *   拿来当「它是怎么来的」会张冠李戴。
     */
    feedback: previous.revisionFeedback,
    diff: diffPlans(beforeSide, afterSide),
  };
}

async function planSide(db: Database, row: typeof plans.$inferSelect): Promise<PlanSide> {
  const tasks = await db
    .select()
    .from(workItems)
    .where(eq(workItems.planId, row.id))
    .orderBy(workItems.position);

  const gates = (row.humanGates as { taskTitle: string }[]) ?? [];
  const gated = new Set(gates.map((g) => g.taskTitle));

  return {
    version: row.version,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    estimatedHours: Number(row.estimatedHours ?? 0),
    estimatedTokens: row.estimatedTokens ?? 0,
    autoActions: (row.autoActions as { title: string; detail?: string }[]) ?? [],
    humanGates: gates,
    risks: (row.risks as { title?: string; description?: string }[]) ?? [],
    tasks: tasks.map((t) => ({
      title: t.title,
      type: t.type,
      riskLevel: t.riskLevel,
      estimatedHours: t.estimatedHours === null ? null : Number(t.estimatedHours),
      estimatedTokens: t.estimatedTokens,
      requiresHuman: gated.has(t.title),
    })),
  };
}
