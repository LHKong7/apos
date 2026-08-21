import { and, count, eq, inArray, isNull, ne } from 'drizzle-orm';
import { agentRuns, agents, artifacts, decisions, projects, workItemDependencies, workItems } from '@apos/db';
import { DataSensitivity, Environment, OperationType, ReviewResult } from '@apos/contracts';
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
    currentStage: item.stage,
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
 * 从 `typeData` 里取一个枚举 fact，认不出的值**抛错**而不是兜底。
 *
 * ★★ 这是安全底线上的一个口子。以前这里是一次裸的 `as` 断言：
 *   typeData 里写着 `"delete_resrouce"`（拼错一个字母）时，
 *   它会原样变成 `operationType`，而 `NEVER_AUTO_APPROVE.includes()`
 *   认不出它 —— 于是「删资源永远不自动放行」被一个拼写错误整条绕过去，
 *   现场毫无迹象：任务照常跑完，规则一条都没命中。
 *
 * ★ 兜底成 `code_change` 同样不行，那是往**宽**的一侧猜。
 *   一个我们读不懂的操作类型，意味着这个任务此刻无法被治理 ——
 *   无法治理时唯一说得过去的做法是停下来喊一声，不是替它选一个。
 *
 * ★ 值的来源现在都验过了（规划输出走严格枚举、手工建卡走路由的 zod），
 *   所以这条路径在新数据上走不到。它挡的是存量数据与将来新开的写入口。
 *
 * Reads an enum fact out of `typeData`, throwing on a value it cannot parse
 * rather than defaulting. This used to be a bare `as` cast: a typo like
 * "delete_resrouce" passed straight through, `NEVER_AUTO_APPROVE` did not
 * recognise it, and the safety floor was bypassed without a trace. Defaulting
 * to `code_change` is no better — it guesses towards the permissive side. An
 * operation type we cannot read means this item cannot be governed right now,
 * and the only defensible response to that is to stop and say so.
 */
function enumFact<T extends string>(
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
  raw: unknown,
  workItemId: string,
  fact: string,
): T | null {
  if (raw === undefined || raw === null) return null;
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data as T;
  throw new UnknownFactValueError(workItemId, fact, raw);
}

/**
 * ★ 单独一个错误类型，不是一句字符串。
 *   调用方（transition、计划预演）将来可能想把它变成一条「需要澄清」，
 *   而从错误消息里正则出操作类型是没法维护的。
 */
export class UnknownFactValueError extends Error {
  constructor(
    readonly workItemId: string,
    readonly fact: string,
    readonly value: unknown,
  ) {
    super(
      `工作项 ${workItemId} 的 ${fact} 是认不出来的值 ${JSON.stringify(value)}，` +
        `无法评估 Policy。这类值只能是枚举里的取值 —— 兜底一个近似值会让治理规则静默失效。`,
    );
    this.name = 'UnknownFactValueError';
  }
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

  const budget = project?.tokenBudget ?? null;
  const spent = project?.tokensSpent ?? 0;
  const meta = item.typeData;
  const quality = (meta['qualityGate'] ?? {}) as Record<string, unknown>;
  const agentStats = (agent?.stats ?? {}) as Record<string, unknown>;

  return {
    projectType: project?.type ?? 'development',
    workItemType: item.type,
    riskLevel: item.riskLevel,
    reversible: meta['reversible'] !== false,
    externalFacing: meta['externalFacing'] === true,

    environment: enumFact(Environment, meta['environment'], item.id, 'environment') ?? null,
    dataSensitivity:
      enumFact(DataSensitivity, meta['dataSensitivity'], item.id, 'dataSensitivity') ?? null,
    impactTaskCount: downstream[0]?.n ?? 0,
    impactServices: Array.isArray(meta['impactServices']) ? (meta['impactServices'] as string[]) : [],
    operationType:
      enumFact(OperationType, meta['operationType'], item.id, 'operationType') ?? 'code_change',

    agentType: agent?.type ?? null,
    agentConfidence: typeof meta['agentConfidence'] === 'number' ? meta['agentConfidence'] : null,
    agentSuccessRate:
      typeof agentStats['successRate'] === 'number' ? agentStats['successRate'] : null,
    consecutiveFailures: item.consecutiveFailures,

    runTokens: item.actualTokens,
    projectTokensSpent: spent,
    projectTokenBudget: budget,
    budgetUsedPct: budget && budget > 0 ? (spent / budget) * 100 : null,

    testsResult: quality['testsPassed'] === true ? 'passed'
      : quality['testsPassed'] === false ? 'failed' : 'not_run',
    testCoverage: typeof quality['coverage'] === 'number' ? quality['coverage'] : null,
    securityScan: quality['securityScanPassed'] === true ? 'passed'
      : quality['securityScanPassed'] === false ? 'failed' : 'not_run',
    agentReview: enumFact(ReviewResult, meta['agentReview'], item.id, 'agentReview') ?? 'not_run',

    autonomyLevel: project?.autonomyLevel ?? 'agent_led_approval',
    ...overrides,
  };
}

export type { WorkItemStatus };
