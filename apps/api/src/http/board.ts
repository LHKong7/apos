import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  agentRuns,
  agents,
  artifacts,
  decisions,
  projects,
  workItemDependencies,
  workItems,
  type Database,
} from '@apos/db';
import { notFound } from './errors';
import {
  HUMAN_GATE_PRIORITY,
  Stage,
  stageFor,
  type HumanGate,
  type Stage as StageT,
  type WorkItemStatus,
} from '@apos/contracts';

/**
 * 看板卡片。字段对应页面文档 05 §5.3 —— 卡片按状态决定显示什么，
 * 因此这里把各状态需要的字段都查出来，由前端按状态取用。
 */
export interface BoardCard {
  id: string;
  title: string;
  type: string;
  status: string;
  stage: StageT;
  priority: number;
  riskLevel: string;
  executor: { type: string; id: string; name: string } | null;
  owner: { id: string; name: string } | null;
  humanGate: HumanGate | null;
  humanGateRef: string | null;
  /** 决策剩余时限，负数表示已超时 */
  decisionDueInMinutes: number | null;
  blockedSince: string | null;
  blockedReason: string | null;
  blockedMinutes: number | null;
  progress: { step: number; total: number | null; description: string | null } | null;
  cost: string;
  estimatedCost: string | null;
  runId: string | null;
  runStatus: string | null;
  consecutiveFailures: number;
  latestNote: string | null;
  artifactCount: number;
  unmetDependencies: number;
  updatedAt: string;
}

export interface BoardColumn {
  key: StageT;
  name: string;
  wipLimit: number | null;
  count: number;
  items: BoardCard[];
  hasMore: boolean;
}

const STAGE_NAMES: Record<StageT, string> = {
  intake: 'Intake',
  planning: 'Planning',
  execution: 'Execution',
  review: 'Review',
  release: 'Release',
  done: 'Done',
};

/** Done 列默认折叠，避免长期项目的 Done 列无限增长 */
const DONE_LIMIT = 5;
const COLUMN_LIMIT = 20;

export interface BoardFilters {
  onlyMine?: string;
  riskLevel?: string[];
  executorType?: string;
  humanGateOnly?: boolean;
  blockedOnly?: boolean;
}

export async function getBoard(
  db: Database,
  projectId: string,
  filters: BoardFilters = {},
): Promise<{ columns: BoardColumn[]; summary: BoardSummary }> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  // 抛普通 Error 会被错误处理器归为 500，让调用方以为是服务端故障
  if (!project) throw notFound('项目');

  const conditions = [eq(workItems.projectId, projectId), isNull(workItems.deletedAt)];
  if (filters.riskLevel?.length) {
    conditions.push(inArray(workItems.riskLevel, filters.riskLevel as never[]));
  }
  if (filters.executorType) {
    conditions.push(eq(workItems.executorType, filters.executorType as never));
  }
  if (filters.blockedOnly) conditions.push(sql`${workItems.blockedSince} IS NOT NULL`);
  if (filters.humanGateOnly) conditions.push(sql`${workItems.humanGate} IS NOT NULL`);
  if (filters.onlyMine) {
    conditions.push(
      sql`(${workItems.ownerId} = ${filters.onlyMine} OR ${workItems.executorId} = ${filters.onlyMine})`,
    );
  }

  const rows = await db
    .select()
    .from(workItems)
    .where(and(...conditions))
    .orderBy(workItems.priority, desc(workItems.updatedAt));

  const enriched = await enrich(db, rows);

  const columns: BoardColumn[] = Stage.options.map((stage) => {
    const all = enriched.filter((c) => c.stage === stage);
    const limit = stage === 'done' ? DONE_LIMIT : COLUMN_LIMIT;
    return {
      key: stage,
      name: STAGE_NAMES[stage],
      wipLimit: project.wipLimits?.[stage] ?? null,
      count: all.length,
      items: all.slice(0, limit),
      hasMore: all.length > limit,
    };
  });

  return { columns, summary: summarize(enriched) };
}

export interface BoardSummary {
  pendingDecisions: number;
  overdueDecisions: number;
  blocked: number;
  executing: number;
  failed: number;
}

function summarize(cards: BoardCard[]): BoardSummary {
  return {
    pendingDecisions: cards.filter((c) => c.humanGateRef).length,
    overdueDecisions: cards.filter(
      (c) => c.decisionDueInMinutes !== null && c.decisionDueInMinutes < 0,
    ).length,
    blocked: cards.filter((c) => c.blockedSince).length,
    executing: cards.filter((c) => c.status === 'executing').length,
    failed: cards.filter((c) => c.status === 'failed').length,
  };
}

type WorkItemRow = typeof workItems.$inferSelect;

/**
 * 批量补齐卡片所需的关联数据。
 *
 * 刻意做成一次性批查而不是逐卡片查询 —— 看板可能有上百张卡片，
 * N+1 会让首屏预算（1.5s）完全没有余地。
 */
async function enrich(db: Database, rows: WorkItemRow[]): Promise<BoardCard[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);

  const runs = await db
    .select()
    .from(agentRuns)
    .where(inArray(agentRuns.workItemId, ids))
    .orderBy(desc(agentRuns.attempt));
  const latestRun = new Map<string, (typeof runs)[number]>();
  for (const r of runs) if (!latestRun.has(r.workItemId)) latestRun.set(r.workItemId, r);

  const agentRows = await db.select().from(agents);
  const agentName = new Map(agentRows.map((a) => [a.id, a.name]));

  const { users } = await import('@apos/db');
  const userRows = await db.select().from(users);
  const userName = new Map(userRows.map((u) => [u.id, u.name]));

  const decisionRows = await db
    .select()
    .from(decisions)
    .where(and(inArray(decisions.workItemId, ids), eq(decisions.status, 'pending')));
  const decisionByItem = new Map(decisionRows.map((d) => [d.workItemId!, d]));

  const artifactRows = await db
    .select({ workItemId: artifacts.workItemId })
    .from(artifacts)
    .where(inArray(artifacts.workItemId, ids));
  const artifactCount = new Map<string, number>();
  for (const a of artifactRows) {
    if (!a.workItemId) continue;
    artifactCount.set(a.workItemId, (artifactCount.get(a.workItemId) ?? 0) + 1);
  }

  const deps = await db
    .select({
      toId: workItemDependencies.toId,
      fromStatus: workItems.status,
    })
    .from(workItemDependencies)
    .innerJoin(workItems, eq(workItems.id, workItemDependencies.fromId))
    .where(inArray(workItemDependencies.toId, ids));
  const unmetDeps = new Map<string, number>();
  for (const d of deps) {
    if (['done', 'released', 'acceptance'].includes(d.fromStatus)) continue;
    unmetDeps.set(d.toId, (unmetDeps.get(d.toId) ?? 0) + 1);
  }

  const now = Date.now();

  return rows.map((r) => {
    const run = latestRun.get(r.id);
    const decision = decisionByItem.get(r.id);

    return {
      id: r.id,
      title: r.title,
      type: r.type,
      status: r.status,
      stage: stageFor(r.status as WorkItemStatus, r.previousStatus),
      priority: r.priority,
      riskLevel: r.riskLevel,
      executor:
        r.executorType && r.executorId
          ? {
              type: r.executorType,
              id: r.executorId,
              name:
                (r.executorType === 'agent'
                  ? agentName.get(r.executorId)
                  : userName.get(r.executorId)) ?? '未知',
            }
          : null,
      owner: r.ownerId ? { id: r.ownerId, name: userName.get(r.ownerId) ?? '未知' } : null,
      /**
       * ★ 有待办决策时，Gate 一定显示为「在等人」。
       *
       * work_items.human_gate 是上一次流转留下的值，会滞后：
       * 一个任务上可能同时挂着两条决策，批掉其中一条会把它写成 approved，
       * 而另一条还在等人 —— 卡片却显示「已批准」，还带着「处理 →」按钮。
       * 待办决策是当下的事实，存量字段只是历史。
       */
      humanGate: decision ? 'waiting_for_decision' : r.humanGate,
      humanGateRef: decision?.id ?? null,
      decisionDueInMinutes: decision?.dueAt
        ? Math.round((decision.dueAt.getTime() - now) / 60_000)
        : null,
      blockedSince: r.blockedSince?.toISOString() ?? null,
      blockedReason: r.blockedReason,
      blockedMinutes: r.blockedSince
        ? Math.round((now - r.blockedSince.getTime()) / 60_000)
        : null,
      progress:
        run && run.stepCurrent !== null
          ? { step: run.stepCurrent, total: run.stepTotal, description: run.stepDescription }
          : null,
      cost: r.actualCost,
      estimatedCost: r.estimatedCost,
      runId: run?.id ?? null,
      runStatus: run?.status ?? null,
      consecutiveFailures: r.consecutiveFailures,
      latestNote: run?.progressNote ?? null,
      artifactCount: artifactCount.get(r.id) ?? 0,
      unmetDependencies: unmetDeps.get(r.id) ?? 0,
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}


/** Human Gate 显示优先级：decision_overdue 覆盖其他状态 */
export function effectiveHumanGate(gates: HumanGate[]): HumanGate | null {
  if (gates.length === 0) return null;
  return gates.reduce((a, b) => (HUMAN_GATE_PRIORITY[a] >= HUMAN_GATE_PRIORITY[b] ? a : b));
}
