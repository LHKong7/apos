import { and, count, eq, inArray, isNull, ne } from 'drizzle-orm';
import { agentRuns, agents, artifacts, decisions, projects, workItemDependencies, workItems } from '@apos/db';
import type { PolicyContext, Stage, WorkItemStatus } from '@apos/contracts';
import type { DependencyView, GuardContext } from '@apos/domain';
import type { Tx } from '../event/emitter';

type WorkItemRow = typeof workItems.$inferSelect;

/** 依赖视图：把跨表的满足条件一次性查出来，让 guard 保持纯函数 */
export async function loadDependencies(tx: Tx, itemId: string): Promise<DependencyView[]> {
  const rows = await tx
    .select({
      fromId: workItemDependencies.fromId,
      type: workItemDependencies.type,
      title: workItems.title,
      fromStatus: workItems.status,
      fromActualStart: workItems.actualStart,
    })
    .from(workItemDependencies)
    .innerJoin(workItems, eq(workItems.id, workItemDependencies.fromId))
    .where(eq(workItemDependencies.toId, itemId));

  if (rows.length === 0) return [];

  const fromIds = rows.map((r) => r.fromId);

  // artifact 依赖：前置任务是否产出了产物
  const artifactRows = await tx
    .select({ workItemId: artifacts.workItemId })
    .from(artifacts)
    .where(inArray(artifacts.workItemId, fromIds));
  const withArtifact = new Set(artifactRows.map((r) => r.workItemId));

  // decision 依赖：关联决策是否已批准
  const decisionRows = await tx
    .select({ workItemId: decisions.workItemId, status: decisions.status })
    .from(decisions)
    .where(inArray(decisions.workItemId, fromIds));
  const approvedDecision = new Set(
    decisionRows.filter((r) => r.status === 'approved').map((r) => r.workItemId),
  );

  return rows.map((r) => ({
    fromId: r.fromId,
    title: r.title,
    type: r.type,
    fromStatus: r.fromStatus,
    fromActualStart: r.fromActualStart?.toISOString() ?? null,
    artifactPresent: withArtifact.has(r.fromId),
    decisionApproved: approvedDecision.has(r.fromId),
    // permission / external / data 依赖的状态由各自的集成模块维护，
    // MVP 阶段未接入时保守判定为未满足
    permissionGranted: false,
    externalReady: false,
    dataReady: false,
  }));
}

export async function buildGuardContext(
  tx: Tx,
  item: WorkItemRow,
  targetStage: Stage,
): Promise<GuardContext> {
  const [project] = await tx.select().from(projects).where(eq(projects.id, item.projectId));

  const [stageCountRow] = await tx
    .select({ n: count() })
    .from(workItems)
    .where(
      and(
        eq(workItems.projectId, item.projectId),
        eq(workItems.stage, targetStage),
        isNull(workItems.deletedAt),
        ne(workItems.id, item.id),
      ),
    );

  const artifactRows = await tx
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(eq(artifacts.workItemId, item.id))
    .limit(1);

  const [latestRun] = await tx
    .select({ progressNote: agentRuns.progressNote })
    .from(agentRuns)
    .where(eq(agentRuns.workItemId, item.id))
    .orderBy(agentRuns.attempt)
    .limit(1);

  const quality = (item.typeData['qualityGate'] ?? {}) as Record<string, unknown>;

  return {
    status: item.status,
    targetStage,
    dependencies: await loadDependencies(tx, item.id),
    acceptanceCriteria: item.acceptanceCriteria,
    executorType: item.executorType,
    executorId: item.executorId,
    hasArtifact: artifactRows.length > 0,
    hasOutputText: Boolean(latestRun?.progressNote),
    stageCount: stageCountRow?.n ?? 0,
    wipLimits: project?.wipLimits ?? {},
    qualityGate: {
      testsPassed: quality['testsPassed'] !== false,
      securityScanPassed: quality['securityScanPassed'] !== false,
      criticalBugs: typeof quality['criticalBugs'] === 'number' ? quality['criticalBugs'] : 0,
      coverage: typeof quality['coverage'] === 'number' ? quality['coverage'] : null,
      minCoverage: typeof quality['minCoverage'] === 'number' ? quality['minCoverage'] : null,
    },
  };
}

/**
 * 构建 Policy 评估上下文。
 *
 * ★ 这里产出的对象会被原样写入事件的 context_snapshot，
 *   是 Policy 模拟回放的唯一数据来源 —— 字段缺失事后无法补救。
 */
export async function buildPolicyContext(
  tx: Tx,
  item: WorkItemRow,
  overrides?: Partial<PolicyContext>,
): Promise<PolicyContext> {
  const [project] = await tx.select().from(projects).where(eq(projects.id, item.projectId));

  const [agent] = item.executorType === 'agent' && item.executorId
    ? await tx.select().from(agents).where(eq(agents.id, item.executorId))
    : [undefined];

  const downstream = await tx
    .select({ n: count() })
    .from(workItemDependencies)
    .where(eq(workItemDependencies.fromId, item.id));

  const budget = project?.budgetAmount ? Number(project.budgetAmount) : null;
  const spent = Number(project?.costSpent ?? 0);
  const meta = item.typeData;
  const quality = (meta['qualityGate'] ?? {}) as Record<string, unknown>;
  const agentStats = (agent?.stats ?? {}) as Record<string, unknown>;

  return {
    projectType: project?.type ?? 'development',
    workItemType: item.type,
    riskLevel: item.riskLevel,
    reversible: meta['reversible'] !== false,
    externalFacing: meta['externalFacing'] === true,

    environment: (meta['environment'] as PolicyContext['environment']) ?? null,
    dataSensitivity: (meta['dataSensitivity'] as PolicyContext['dataSensitivity']) ?? null,
    impactTaskCount: downstream[0]?.n ?? 0,
    impactServices: Array.isArray(meta['impactServices']) ? (meta['impactServices'] as string[]) : [],
    operationType: (meta['operationType'] as PolicyContext['operationType']) ?? 'code_change',

    agentType: agent?.type ?? null,
    agentConfidence: typeof meta['agentConfidence'] === 'number' ? meta['agentConfidence'] : null,
    agentSuccessRate:
      typeof agentStats['successRate'] === 'number' ? agentStats['successRate'] : null,
    consecutiveFailures: item.consecutiveFailures,

    runCost: Number(item.actualCost),
    projectCostSpent: spent,
    projectBudget: budget,
    budgetUsedPct: budget && budget > 0 ? (spent / budget) * 100 : null,

    testsResult: quality['testsPassed'] === true ? 'passed'
      : quality['testsPassed'] === false ? 'failed' : 'not_run',
    testCoverage: typeof quality['coverage'] === 'number' ? quality['coverage'] : null,
    securityScan: quality['securityScanPassed'] === true ? 'passed'
      : quality['securityScanPassed'] === false ? 'failed' : 'not_run',
    agentReview: (meta['agentReview'] as PolicyContext['agentReview']) ?? 'not_run',

    autonomyLevel: project?.autonomyLevel ?? 'agent_led_approval',
    ...overrides,
  };
}

export type { WorkItemStatus };
