import { desc, eq } from 'drizzle-orm';
import {
  plans,
  policies,
  projects,
  requirements,
  workItemDependencies,
  workItems,
  type Database,
} from '@apos/db';
import {
  humanActor,
  STATUS_STAGE,
  SYSTEM_ACTOR,
  type PolicyContext,
} from '@apos/contracts';
import { BASELINE_POLICIES, compile, evaluate, explainAction, requiresHuman } from '@apos/domain';
import { executionModeOf } from '../agent/matching';
import { emitAndPublish } from '../event/bus';
import { allocateNumbers } from '../work-item/numbering';
import { transition } from '../flow/transition';
import type { GeneratedPlan, PlanningProvider, StructuredRequirement } from './provider';

export interface AutoAction {
  description: string;
  policyId: string | null;
  policyName: string | null;
  reversible: boolean;
  externalVisible: boolean;
}

export interface HumanGateEntry {
  taskTitle: string;
  /**
   * 这道闸是**为什么**在的。
   *
   * ★★ `execution` = 这活得人干；`approval` = 干完要人批。
   *   两者以前混在同一个列表里，而用户看到它时要做的判断完全不同：
   *   前者是排人，后者是把关。分不开的话，计划页上「仍需人确认的（5）」
   *   里可能一条审批都没有 —— 全是「这几件事得人做」。
   */
  cause: 'execution' | 'approval';
  reason: string;
  assigneeHint: string;
}

export interface PlanSummary {
  planId: string;
  version: number;
  taskCount: number;
  agentTaskCount: number;
  humanTaskCount: number;
  estimatedHours: number;
  estimatedCost: number;
  /** 批准后将自动发生的行为 —— 计划确认页的灵魂 */
  autoActions: AutoAction[];
  humanGates: HumanGateEntry[];
  riskCount: number;
}

/**
 * 生成执行计划。
 *
 * 关键点：auto_actions 由 Policy 预演生成并快照存储。用户批准的是
 * 「当时那份清单」，Policy 后来变了也要能追溯他到底批准了什么。
 */
export async function generatePlan(
  db: Database,
  provider: PlanningProvider,
  input: {
    requirementId: string;
    correlationId: string;
    /**
     * 「要求修改」时用户写的意见。
     *
     * ★ 它只传给规划器，不写进新版本的 revisionFeedback。
     *   那个列的语义是「**这一版**为什么被要求改」，由 supersede 时写入 ——
     *   新版本也往里写一份「我是基于什么意见生成的」，两种含义就共用了一列，
     *   于是 v3 被 v4 取代时，「取代 v3 的理由」直接覆盖了「v3 是怎么来的」，
     *   页面上 v3 会顶着一句它根本不是基于其生成的意见。
     *   「这一版是基于什么生成的」= 上一版的 revisionFeedback，不需要再存一份。
     */
    feedback?: string;
  },
): Promise<PlanSummary> {
  const started = Date.now();

  const [req] = await db
    .select()
    .from(requirements)
    .where(eq(requirements.id, input.requirementId));
  if (!req) throw new Error(`需求不存在: ${input.requirementId}`);
  if (req.status !== 'approved') {
    throw new Error(`需求尚未确认，当前状态: ${req.status}`);
  }

  const [project] = await db.select().from(projects).where(eq(projects.id, req.projectId));

  const structured: StructuredRequirement = {
    title: req.title ?? '',
    businessContext: req.businessContext ?? '',
    userProblem: req.userProblem ?? '',
    businessGoal: req.businessGoal ?? '',
    userStories: req.userStories as string[],
    scope: req.scope as { inScope: string[]; outOfScope: string[] },
    nonFunctional: req.nonFunctional as string[],
    successMetrics: req.successMetrics as string[],
    constraints: req.constraints as string[],
    risks: req.risks as string[],
    acceptanceCriteria: req.acceptanceCriteria,
    clarifications: [],
    assumptions: [],
    provenance: {},
    cost: 0,
    model: '',
  };

  // ★ 意见必须传给规划器，不能只存进数据库 —— 只存不用等于「要求修改」是个假按钮
  const generated = await provider.generatePlan(
    structured,
    project?.type ?? 'development',
    input.feedback,
    { orgId: req.orgId, projectId: req.projectId },
  );

  const [prev] = await db
    .select({ version: plans.version })
    .from(plans)
    .where(eq(plans.requirementId, req.id))
    .orderBy(desc(plans.version))
    .limit(1);

  const version = (prev?.version ?? 0) + 1;

  const rules = await loadRules(db, req.orgId, req.projectId);
  const { autoActions, humanGates } = predictPolicyOutcomes(generated, {
    projectType: project?.type ?? 'development',
    autonomyLevel: project?.autonomyLevel ?? 'agent_led_approval',
    budget: project?.budgetAmount ? Number(project.budgetAmount) : null,
    spent: Number(project?.costSpent ?? 0),
    rules,
  });

  const estimatedHours = generated.tasks.reduce((s, t) => s + t.estimatedHours, 0);
  const estimatedCost = generated.tasks.reduce((s, t) => s + (t.estimatedCost ?? 0), 0);

  const [plan] = await db
    .insert(plans)
    .values({
      projectId: req.projectId,
      requirementId: req.id,
      version,
      status: 'awaiting_approval',
      phases: [...new Set(generated.tasks.map((t) => t.phase))],
      milestones: generated.milestones,
      risks: generated.risks,
      estimatedHours: String(estimatedHours),
      estimatedCost: String(estimatedCost),
      autoActions: autoActions as unknown[],
      humanGates: humanGates as unknown[],
      model: generated.model,
      generationCost: String(generated.cost),
      generationMs: Date.now() - started,
    })
    .returning();

  // 任务先建为 draft，批准后才转 ready
  /**
   * ★ 一次把这批号全要过来，不是每条各要一个。
   *   循环分配会让别人的号插进中间，同一份计划出来的任务编号不连续 ——
   *   读起来像是丢了几条。
   */
  const numbers = await allocateNumbers(db, req.projectId, generated.tasks.length);
  const refToId = new Map<string, string>();
  for (const [index, task] of generated.tasks.entries()) {
    const [row] = await db
      .insert(workItems)
      .values({
        orgId: req.orgId,
        projectId: req.projectId,
        number: numbers[index]!,
        requirementId: req.id,
        planId: plan!.id,
        type: task.type,
        status: 'draft',
        stage: STATUS_STAGE['draft'],
        title: task.title,
        description: task.description,
        riskLevel: task.riskLevel,
        estimatedHours: String(task.estimatedHours),
        estimatedCost: task.estimatedCost === null ? null : String(task.estimatedCost),
        acceptanceCriteria: task.acceptanceCriteria,
        typeData: {
          phase: task.phase,
          requiredSkills: task.requiredSkills,
          requiredTools: task.requiredTools,
          /**
           * ★★ executionMode 与 approvalGate 是两件事。
           *
           *   「这活只能人干」和「干完要不要人批」在产品上正交：一段需要人写的
           *   文案不一定要审批，一次自动的生产发布几乎一定要。合成一个
           *   requiresHuman 之后，「Agent 执行 + 人类审批」表达不了，
           *   而计划页那一栏会显示成「🤖 Agent」，看不出后面还有一道闸。
           *
           * ★ requiresHuman 一并留着：老工作项只有它，读取处（executionModeOf）
           *   两个都认。等历史数据都带上 executionMode 之后再删。
           */
          executionMode: task.requiresHuman ? 'human' : 'auto',
          requiresHuman: task.requiresHuman,
          ...(task.operationType ? { operationType: task.operationType } : {}),
          ...(task.environment ? { environment: task.environment } : {}),
        },
      })
      .returning({ id: workItems.id });
    refToId.set(task.ref, row!.id);
  }

  for (const task of generated.tasks) {
    for (const dep of task.dependsOn) {
      const fromId = refToId.get(dep.ref);
      const toId = refToId.get(task.ref);
      if (!fromId || !toId) continue;
      await db.insert(workItemDependencies).values({
        projectId: req.projectId,
        fromId,
        toId,
        type: dep.type,
        createdByType: 'system',
      });
    }
  }

  await emitAndPublish(db, {
    type: 'plan.generated',
    orgId: req.orgId,
    projectId: req.projectId,
    actor: SYSTEM_ACTOR,
    subjectType: 'plan',
    subjectId: plan!.id,
    payload: {
      version,
      taskCount: generated.tasks.length,
      estimatedCost,
      estimatedHours,
      durationMs: Date.now() - started,
      model: generated.model,
    },
    correlationId: input.correlationId,
  });

  const humanTaskCount = generated.tasks.filter((t) => t.requiresHuman).length;

  return {
    planId: plan!.id,
    version,
    taskCount: generated.tasks.length,
    agentTaskCount: generated.tasks.length - humanTaskCount,
    humanTaskCount,
    estimatedHours,
    estimatedCost,
    autoActions,
    humanGates,
    riskCount: generated.risks.length,
  };
}

async function loadRules(db: Database, orgId: string, projectId: string) {
  const rows = await db.select().from(policies).where(eq(policies.orgId, orgId));
  const scoped = rows.filter((r) => r.projectId === null || r.projectId === projectId);
  const storedIds = new Set(scoped.map((p) => p.id));
  const baseline = BASELINE_POLICIES.filter((p) => !storedIds.has(p.id)).map((p) => ({
    ...p,
    orgId,
  }));
  return compile([
    ...baseline,
    ...scoped.map((r) => ({
      id: r.id,
      orgId: r.orgId,
      projectId: r.projectId,
      name: r.name,
      description: r.description,
      priority: r.priority,
      enabled: r.enabled,
      condition: r.condition,
      action: r.action,
    })),
  ]);
}

/**
 * Policy 预演 —— 把抽象规则翻译成「批准后会发生什么」。
 *
 * 页面文档 04 §5.3：批准计划 = 批准一批自动化行为，
 * 用户必须清楚看到自己让渡了什么，以及安全网在哪。
 */
function predictPolicyOutcomes(
  plan: GeneratedPlan,
  ctx: {
    projectType: string;
    autonomyLevel: PolicyContext['autonomyLevel'];
    budget: number | null;
    spent: number;
    rules: ReturnType<typeof compile>;
  },
): { autoActions: AutoAction[]; humanGates: HumanGateEntry[] } {
  const autoActions: AutoAction[] = [];
  const humanGates: HumanGateEntry[] = [];
  const autoTaskTitles: string[] = [];

  for (const task of plan.tasks) {
    const policyCtx: PolicyContext = {
      projectType: ctx.projectType,
      workItemType: task.type,
      riskLevel: task.riskLevel,
      reversible: task.operationType !== 'db_ddl' && task.operationType !== 'delete_resource',
      externalFacing: false,
      environment: (task.environment as PolicyContext['environment']) ?? null,
      dataSensitivity: null,
      impactTaskCount: plan.tasks.filter((t) => t.dependsOn.some((d) => d.ref === task.ref)).length,
      impactServices: [],
      operationType: (task.operationType as PolicyContext['operationType']) ?? 'code_change',
      agentType: task.requiresHuman ? null : 'code',
      agentConfidence: null,
      agentSuccessRate: null,
      consecutiveFailures: 0,
      runCost: task.estimatedCost ?? 0,
      projectCostSpent: ctx.spent,
      projectBudget: ctx.budget,
      budgetUsedPct: ctx.budget ? (ctx.spent / ctx.budget) * 100 : null,
      testsResult: 'not_run',
      testCoverage: null,
      securityScan: 'not_run',
      agentReview: 'not_run',
      autonomyLevel: ctx.autonomyLevel,
    };

    const verdict = evaluate(policyCtx, ctx.rules);

    /**
     * ★★ 「人来执行」不等于「要人批准」。
     *
     *   这一条以前和 Policy 判出来的审批闸混在同一个列表里，于是计划页上
     *   「仍需人确认的」既包含「这活得人干」也包含「这活干完要人批」——
     *   而用户看到它时要做的判断完全不同：前者是排人，后者是把关。
     *   cause 把两者分开，文案也分开。
     */
    if (task.requiresHuman) {
      humanGates.push({
        taskTitle: task.title,
        cause: 'execution',
        reason: '该任务需要人来执行（不是审批闸）',
        assigneeHint: '项目成员',
      });
      continue;
    }

    if (requiresHuman(verdict.action)) {
      humanGates.push({
        taskTitle: task.title,
        cause: 'approval',
        reason: verdict.matchedPolicyName
          ? `Policy「${verdict.matchedPolicyName}」要求人工介入`
          : `项目自治等级下 ${task.riskLevel} 风险任务需人工确认`,
        assigneeHint: explainAction(verdict.action),
      });
    } else {
      autoTaskTitles.push(task.title);
    }
  }

  if (autoTaskTitles.length > 0) {
    autoActions.push({
      description: `${autoTaskTitles.length} 个任务将由 Agent 自动执行：${autoTaskTitles.join('、')}`,
      policyId: null,
      policyName: null,
      reversible: true,
      externalVisible: false,
    });
  }

  const totalCost = plan.tasks.reduce((s, t) => s + (t.estimatedCost ?? 0), 0);
  if (totalCost > 0) {
    const pct = ctx.budget ? ((totalCost / ctx.budget) * 100).toFixed(1) : null;
    autoActions.push({
      description: `预计消耗 $${totalCost.toFixed(2)}${pct ? `（占预算 ${pct}%）` : ''}`,
      policyId: null,
      policyName: null,
      reversible: false,
      externalVisible: false,
    });
  }

  if (plan.tasks.some((t) => t.requiredTools.includes('create_pr'))) {
    autoActions.push({
      description: '将自动创建 Pull Request',
      policyId: null,
      policyName: null,
      reversible: true,
      externalVisible: true,
    });
  }

  return { autoActions, humanGates };
}

export type ApprovePlanResult =
  | { ok: true; planId: string; activatedTasks: number; unclaimed: number }
  | { ok: false; code: 'BUDGET_EXCEEDED'; estimated: number; budget: number }
  /**
   * ★★ 有人工任务没人认领。
   *
   *   这不是「不许批准」，是「批准之前得知道」。一个 executionMode=human
   *   却没有执行者的任务，批下去之后会进 ready 然后**停在那里**：
   *   调度器不碰人工任务，而没有人被通知过它是自己的。它不报错、不失败，
   *   只是永远不动 —— 计划看起来批了，其中几项其实没人接。
   *
   *   与 BUDGET_EXCEEDED 同一套形态：先拦一次、说清楚是哪几项，
   *   调用方确认后再放行（那时它们进「待认领」）。
   */
  | {
      ok: false;
      code: 'UNASSIGNED_HUMAN_TASKS';
      tasks: { id: string; title: string }[];
    };

/**
 * Human Gate：计划批准。批准后任务从 draft 转 ready，Scheduler 开始接手。
 */
export async function approvePlan(
  db: Database,
  input: {
    planId: string;
    approverId: string;
    correlationId: string;
    acknowledgedOverrun?: boolean;
    /** 确认「这几项人工任务先进待认领队列」 */
    acknowledgedUnassigned?: boolean;
  },
): Promise<ApprovePlanResult> {
  const [plan] = await db.select().from(plans).where(eq(plans.id, input.planId));
  if (!plan) throw new Error(`计划不存在: ${input.planId}`);

  const [project] = await db.select().from(projects).where(eq(projects.id, plan.projectId));
  const estimated = Number(plan.estimatedCost ?? 0);
  const budget = project?.budgetAmount ? Number(project.budgetAmount) : null;

  if (budget !== null && estimated > budget && !input.acknowledgedOverrun) {
    return { ok: false, code: 'BUDGET_EXCEEDED', estimated, budget };
  }

  const tasks = await db.select().from(workItems).where(eq(workItems.planId, plan.id));

  /**
   * ★ 在写 approved 之前判，不是之后 —— 拦下来的时候计划必须还是待批状态，
   *   否则用户补完执行者回来会发现计划已经批过了。
   */
  const unassignedHuman = tasks.filter(
    (t) => t.status === 'draft' && executionModeOf(t.typeData) === 'human' && !t.executorId,
  );
  if (unassignedHuman.length > 0 && !input.acknowledgedUnassigned) {
    return {
      ok: false,
      code: 'UNASSIGNED_HUMAN_TASKS',
      tasks: unassignedHuman.map((t) => ({ id: t.id, title: t.title })),
    };
  }

  await db
    .update(plans)
    .set({
      status: 'approved',
      approvedBy: [input.approverId],
      approvedAt: new Date(),
    })
    .where(eq(plans.id, plan.id));

  let activated = 0;
  for (const task of tasks) {
    if (task.status !== 'draft') continue;
    const moved = await transition(db, {
      workItemId: task.id,
      trigger: 'plan_approved',
      actor: humanActor(input.approverId),
      correlationId: input.correlationId,
    });
    if (moved.ok) activated++;
  }

  await emitAndPublish(db, {
    type: 'plan.approved',
    orgId: project!.orgId,
    projectId: plan.projectId,
    actor: humanActor(input.approverId),
    subjectType: 'plan',
    subjectId: plan.id,
    payload: {
      version: plan.version,
      approvers: [input.approverId],
      acknowledgedOverrun: input.acknowledgedOverrun ?? false,
      activatedTasks: activated,
      /** ★ 留痕：批准时有几项人工任务是没人认领就放行的 */
      unclaimedHumanTasks: unassignedHuman.length,
      // 批准时的自动化清单快照 —— 追溯「他到底批准了什么」
      autoActionsSnapshot: plan.autoActions,
    },
    correlationId: input.correlationId,
  });

  return {
    ok: true,
    planId: plan.id,
    activatedTasks: activated,
    unclaimed: unassignedHuman.length,
  };
}
