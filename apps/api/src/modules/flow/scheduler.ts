import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  agentRuns,
  agents,
  projects,
  workItemDependencies,
  workItems,
  type Database,
} from '@apos/db';
import { ACTIVE_RUN_STATUSES, SYSTEM_ACTOR, type WorkItemType } from '@apos/contracts';
import { isDependencyMet, matchExecutors, type AgentCandidate, type MatchTarget } from '@apos/domain';
import type { RuntimeRegistry } from '@apos/agent-runtimes';
import { emit } from '../event/emitter';
import { loadDependencies } from './context';
import { dispatchRun } from '../agent/dispatch';

export interface ScheduleOutcome {
  workItemId: string;
  title: string;
  action: 'dispatched' | 'assigned_to_human' | 'skipped';
  reason: string;
  agentId?: string;
  runId?: string;
}

export interface ScheduleReport {
  scanned: number;
  outcomes: ScheduleOutcome[];
}

/**
 * 调度一轮 —— 「Agent 推进」的引擎。
 *
 * 传统看板等用户拖卡片，Flow Engine 主动找活干：
 * 找出依赖已满足的 ready 任务 → 检查 WIP 与预算 → 解析执行主体 → 派发。
 *
 * docs/tech/04-flow-engine.md §4
 */
export async function scheduleRound(
  db: Database,
  registry: RuntimeRegistry,
  opts: { projectId?: string; limit?: number; correlationId: string },
): Promise<ScheduleReport> {
  const candidates = await findSchedulable(db, opts.projectId, opts.limit ?? 50);
  const outcomes: ScheduleOutcome[] = [];

  for (const item of candidates) {
    outcomes.push(await scheduleOne(db, registry, item, opts.correlationId));
  }

  return { scanned: candidates.length, outcomes };
}

type WorkItemRow = typeof workItems.$inferSelect;

/**
 * 候选查询。依赖判定分两步：SQL 先过滤掉明显不满足的（性能），
 * 应用层再按七种依赖类型精确判定（正确性）。
 */
async function findSchedulable(
  db: Database,
  projectId: string | undefined,
  limit: number,
): Promise<WorkItemRow[]> {
  const rows = await db
    .select()
    .from(workItems)
    .innerJoin(projects, eq(projects.id, workItems.projectId))
    .where(
      and(
        eq(workItems.status, 'ready'),
        isNull(workItems.deletedAt),
        eq(projects.status, 'active'),
        projectId ? eq(workItems.projectId, projectId) : undefined,
      ),
    )
    .orderBy(workItems.priority, sql`${workItems.plannedStart} NULLS LAST`)
    .limit(limit);

  const items = rows.map((r) => r.work_items);
  const schedulable: WorkItemRow[] = [];

  for (const item of items) {
    const deps = await loadDependencies(db as never, item.id);
    if (deps.every(isDependencyMet)) schedulable.push(item);
  }

  return schedulable;
}

async function scheduleOne(
  db: Database,
  registry: RuntimeRegistry,
  item: WorkItemRow,
  correlationId: string,
): Promise<ScheduleOutcome> {
  const base = { workItemId: item.id, title: item.title };

  // ── WIP 检查（产品文档 8.6.3）──
  const wip = await checkWip(db, item);
  if (!wip.ok) {
    return { ...base, action: 'skipped', reason: wip.reason };
  }

  // ── 预算检查：派发前预防，而不是执行到一半才发现 ──
  const budget = await checkBudget(db, item);
  if (!budget.ok) {
    await db.transaction(async (tx) => {
      await emit(tx, {
        type: 'project.budget_threshold_reached',
        orgId: item.orgId,
        projectId: item.projectId,
        actor: SYSTEM_ACTOR,
        subjectType: 'project',
        subjectId: item.projectId,
        payload: { reason: budget.reason, workItemId: item.id },
        correlationId,
      });
    });
    return { ...base, action: 'skipped', reason: budget.reason };
  }

  // ── 执行主体解析 ──
  if (item.executorType === 'human' && item.executorId) {
    return { ...base, action: 'assigned_to_human', reason: '已指派给人类，等待其开始' };
  }

  let agentId = item.executorType === 'agent' ? item.executorId : null;
  let matchReasons: string[] = [];

  if (!agentId) {
    const match = await resolveExecutor(db, item);
    if (!match.candidates.length) {
      const why = match.rejected.length
        ? `无匹配 Agent：${match.rejected.map((r) => `${r.agentName}（${r.reason}）`).join('；')}`
        : '项目中没有可用 Agent';
      await markBlocked(db, item, why, correlationId);
      return { ...base, action: 'skipped', reason: why };
    }
    const best = match.candidates[0]!;
    agentId = best.agentId;
    matchReasons = best.reasons;

    // 执行主体的落库由 dispatchRun 负责，这里只记录「为什么选它」
    await db.transaction(async (tx) => {
      await emit(tx, {
        type: 'work_item.assigned',
        orgId: item.orgId,
        projectId: item.projectId,
        actor: SYSTEM_ACTOR,
        subjectType: 'work_item',
        subjectId: item.id,
        payload: { executorType: 'agent', executorId: agentId, matchReasons, score: best.score },
        correlationId,
      });
    });
  }

  const result = await dispatchRun(db, registry, {
    workItemId: item.id,
    agentId: agentId!,
    correlationId,
  });

  if (!result.ok) {
    return { ...base, action: 'skipped', reason: `派发失败：${result.code}`, agentId: agentId! };
  }

  return {
    ...base,
    action: 'dispatched',
    reason: matchReasons.join('；') || '沿用已分配的执行主体',
    agentId: agentId!,
    runId: result.runId,
  };
}

async function checkWip(db: Database, item: WorkItemRow): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [project] = await db.select().from(projects).where(eq(projects.id, item.projectId));
  const limit = project?.wipLimits?.['execution'];
  if (limit === undefined) return { ok: true };

  const [row] = await db
    .select({ n: count() })
    .from(workItems)
    .where(
      and(
        eq(workItems.projectId, item.projectId),
        eq(workItems.stage, 'execution'),
        inArray(workItems.status, ['executing']),
        isNull(workItems.deletedAt),
      ),
    );

  const current = row?.n ?? 0;
  return current < limit
    ? { ok: true }
    : { ok: false, reason: `Execution 阶段已达 WIP 上限 ${limit}，任务排队中` };
}

async function checkBudget(
  db: Database,
  item: WorkItemRow,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [project] = await db.select().from(projects).where(eq(projects.id, item.projectId));
  if (!project?.budgetAmount) return { ok: true };

  const spent = Number(project.costSpent);
  const budget = Number(project.budgetAmount);
  const estimated = Number(item.estimatedCost ?? 0);

  if (spent >= budget) {
    return { ok: false, reason: `项目成本 $${spent} 已达预算 $${budget}，停止调度新任务` };
  }
  if (spent + estimated > budget) {
    return {
      ok: false,
      reason: `预估成本 $${estimated} 将使项目超出预算（已用 $${spent} / $${budget}）`,
    };
  }
  return { ok: true };
}

async function resolveExecutor(db: Database, item: WorkItemRow) {
  const rows = await db.select().from(agents).where(eq(agents.orgId, item.orgId));

  const loads = await db
    .select({ agentId: agentRuns.agentId, n: count() })
    .from(agentRuns)
    .where(inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]))
    .groupBy(agentRuns.agentId);
  const loadMap = new Map(loads.map((l) => [l.agentId, l.n]));

  const meta = item.typeData;
  const candidates: AgentCandidate[] = rows.map((a) => {
    const stats = (a.stats ?? {}) as Record<string, unknown>;
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      skills: a.skills,
      applicableTypes: a.applicableTypes as WorkItemType[],
      successRate: typeof stats['successRate'] === 'number' ? stats['successRate'] : null,
      sampleSize: typeof stats['sampleSize'] === 'number' ? stats['sampleSize'] : 0,
      avgCost: typeof stats['avgCost'] === 'number' ? stats['avgCost'] : null,
      currentLoad: loadMap.get(a.id) ?? 0,
      maxConcurrency: a.maxConcurrency,
      costLimitPerRun: a.costLimitPerRun ? Number(a.costLimitPerRun) : null,
      allowedTools: a.allowedTools,
      deniedTools: a.deniedTools,
      contextAffinity: 0.5,
      status: a.status,
    };
  });

  const target: MatchTarget = {
    type: item.type,
    requiredSkills: Array.isArray(meta['requiredSkills']) ? (meta['requiredSkills'] as string[]) : [],
    requiredTools: Array.isArray(meta['requiredTools']) ? (meta['requiredTools'] as string[]) : [],
    estimatedCost: item.estimatedCost ? Number(item.estimatedCost) : null,
    riskLevel: item.riskLevel,
    requiresHuman: meta['requiresHuman'] === true,
  };

  return matchExecutors(target, candidates);
}

async function markBlocked(db: Database, item: WorkItemRow, reason: string, correlationId: string) {
  await db
    .update(workItems)
    .set({ blockedSince: new Date(), blockedReason: reason })
    .where(eq(workItems.id, item.id));

  await db.transaction(async (tx) => {
    await emit(tx, {
      type: 'work_item.blocked',
      orgId: item.orgId,
      projectId: item.projectId,
      actor: SYSTEM_ACTOR,
      subjectType: 'work_item',
      subjectId: item.id,
      payload: { reason },
      correlationId,
    });
  });
}

export { workItemDependencies };
