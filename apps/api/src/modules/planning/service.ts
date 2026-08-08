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
import { emitAndPublish } from '../event/bus';
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
  const refToId = new Map<string, string>();
  for (const task of generated.tasks) {
    const [row] = await db
      .insert(workItems)
      .values({
        orgId: req.orgId,
        projectId: req.projectId,
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

    if (task.requiresHuman) {
      humanGates.push({
        taskTitle: task.title,
        reason: '该任务在计划中被标记为需要人类执行',
        assigneeHint: '项目成员',
      });
      continue;
    }

    if (requiresHuman(verdict.action)) {
      humanGates.push({
        taskTitle: task.title,
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
  | { ok: true; planId: string; activatedTasks: number }
  | { ok: false; code: 'BUDGET_EXCEEDED'; estimated: number; budget: number };

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

  await db
    .update(plans)
    .set({
      status: 'approved',
      approvedBy: [input.approverId],
      approvedAt: new Date(),
    })
    .where(eq(plans.id, plan.id));

  const tasks = await db.select().from(workItems).where(eq(workItems.planId, plan.id));

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
      // 批准时的自动化清单快照 —— 追溯「他到底批准了什么」
      autoActionsSnapshot: plan.autoActions,
    },
    correlationId: input.correlationId,
  });

  return { ok: true, planId: plan.id, activatedTasks: activated };
}
