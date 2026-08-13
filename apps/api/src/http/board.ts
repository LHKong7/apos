import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  agentRuns,
  agents,
  artifacts,
  decisions,
  plans,
  projects,
  requirements,
  workItemDependencies,
  workItems,
  type Database,
} from '@apos/db';
import { formatRef } from '../modules/work-item/numbering';
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
  /**
   * 人类可读编号（`ORD-19`）。
   *
   * ★ 卡片上必须有它：站会上指一张卡、聊天里提一条任务、
   *   提交信息里引用一条任务，用的都是这个，而不是 uuid。
   */
  ref: string;
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

/**
 * 「计划待批准」卡片（页面文档 05 §5.2 的原型图，Planning 列那一张）。
 *
 * ★★ 为什么它不是 BoardCard 的一种，而是独立类型：
 *
 *   计划不是工作项 —— 它没有状态机、没有执行者、没有依赖、不能被拖动。
 *   硬塞进 BoardCard 就要给一半字段填 null，而下游那些 `card.status === 'executing'`
 *   的分支会开始处理一个永远不成立的形态。更要命的是 `columns[].items`
 *   被 Kanban / List / Agent / Decision **四个视图**共用，它们一律按工作项
 *   处理：点开会去查一个不存在的 work item，批量重试会把计划一起发出去。
 *
 *   所以它单独挂在 {@link BoardColumn.plans} 上：想渲染的视图去读，
 *   不认识它的视图什么都不用改，也不会误伤。
 */
export interface PlanCard {
  id: string;
  requirementId: string | null;
  /** 需求标题。需求还没结构化出标题时退回原文截断 */
  title: string;
  version: number;
  /** 批准后会带出多少个任务 —— 卡片上的「+6 任务」 */
  taskCount: number;
  /**
   * 谁该批。★ `plan.approve` 是 tech_lead 的权限（rbac/catalog.ts），
   * 所以这里给的是项目的技术负责人，而不是需求的提出者。
   */
  approver: { id: string; name: string } | null;
  estimatedHours: string | null;
  estimatedCost: string | null;
  /**
   * 已经等了多久（分钟）。
   *
   * ★ 是「已等待」而不是原型图上的「⏳ 4h 内」倒计时 —— 计划本身没有
   *   截止时间字段，编一个出来等于在界面上撒谎。等待时长是真实数据，
   *   而且同样能表达「这事拖着没人管」，那正是这个位置要传达的信息。
   */
  waitingMinutes: number;
  createdAt: string;
}

export interface BoardColumn {
  key: StageT;
  name: string;
  wipLimit: number | null;
  count: number;
  items: BoardCard[];
  hasMore: boolean;
  /**
   * 待批准的计划。目前只有 planning 列非空 —— 其余列固定为 `[]`
   * 而不是省略，省得每个消费方都要判一次 undefined。
   */
  plans: PlanCard[];
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
  /**
   * 待认领：标为人工执行、但没有执行者的任务。
   *
   * ★★ 这一档必须能筛出来，否则「批准时确认让它们先没人接」就成了一句空话 ——
   *   那些任务会进 ready 然后停在那里：调度器不碰人工任务，而没有人被通知过
   *   它是自己的。没有这个入口，它们在看板上和别的卡片长得一模一样。
   */
  unclaimedOnly?: boolean;
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
  if (filters.unclaimedOnly) {
    /**
     * ★ 兼容旧数据：executionMode 是从 requiresHuman 拆出来的，
     *   老工作项的 typeData 里只有后者。两个都认，与 executionModeOf 同一条口径。
     */
    conditions.push(
      sql`${workItems.executorId} IS NULL
          AND (${workItems.typeData}->>'executionMode' = 'human'
               OR (${workItems.typeData}->>'executionMode' IS NULL
                   AND ${workItems.typeData}->>'requiresHuman' = 'true'))`,
    );
  }
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

  const enriched = await enrich(db, rows, project.identifier);
  const pendingPlans = await loadPendingPlans(db, projectId, project.techLeadId, filters);

  const columns: BoardColumn[] = Stage.options.map((stage) => {
    const all = enriched.filter((c) => c.stage === stage);
    const limit = stage === 'done' ? DONE_LIMIT : COLUMN_LIMIT;
    /**
     * ★ 计划卡片只落在 planning 列。
     *
     *   这个归属放在服务端而不是让前端自己判「plans 该画在哪一列」——
     *   列的构成本来就是这里定的（STAGE_NAMES、WIP、折叠上限都在这），
     *   分两处决定迟早会漂移成「后端给了但前端没画」。
     */
    const plans = stage === 'planning' ? pendingPlans : [];
    return {
      key: stage,
      name: STAGE_NAMES[stage],
      wipLimit: project.wipLimits?.[stage] ?? null,
      // 列头计数要含计划，否则 Planning 列会显示 0 却挂着一张卡
      count: all.length + plans.length,
      items: all.slice(0, limit),
      hasMore: all.length > limit,
      plans,
    };
  });

  return { columns, summary: summarize(enriched) };
}

/**
 * 待批准的计划。
 *
 * ★ 与 overview.ts 用的是同一个判据（`status = 'awaiting_approval'`）——
 *   总览横幅说「有计划待批准」而看板上没有那张卡，是最难解释的一种不一致。
 */
async function loadPendingPlans(
  db: Database,
  projectId: string,
  techLeadId: string | null,
  filters: BoardFilters,
): Promise<PlanCard[]> {
  /**
   * ★★ 筛选器是按工作项设计的，对计划大多无意义。不能默认「不匹配就留着」——
   *   那会让用户勾了「只看阻塞」之后，Planning 列里那张计划卡岿然不动，
   *   看起来像筛选坏了。
   *
   *   逐条判断它对计划成不成立：
   *   - 阻塞 / 执行者 / 风险：计划没有这些属性 → 该筛选开启时隐藏计划
   *   - Human Gate：计划待批准**本身就是**在等人 → 保留
   *   - 只看我的：我是不是批准人 → 下面单独判
   */
  if (filters.blockedOnly || filters.executorType || filters.riskLevel?.length) return [];
  if (filters.onlyMine && filters.onlyMine !== techLeadId) return [];

  const rows = await db
    .select({
      id: plans.id,
      requirementId: plans.requirementId,
      version: plans.version,
      estimatedHours: plans.estimatedHours,
      estimatedCost: plans.estimatedCost,
      createdAt: plans.createdAt,
      requirementTitle: requirements.title,
      requirementRaw: requirements.rawInput,
    })
    .from(plans)
    .leftJoin(requirements, eq(requirements.id, plans.requirementId))
    .where(and(eq(plans.projectId, projectId), eq(plans.status, 'awaiting_approval')))
    .orderBy(desc(plans.createdAt));

  if (rows.length === 0) return [];

  /**
   * 任务数。★ 计划生成时任务就已经建成 draft 了（planning/service.ts），
   * 所以这里数的是真实存在的行，不是计划里那份清单的长度 —— 两者在
   * 「有人手工删过其中一条」之后会不一样，而卡片该说的是现在有几条。
   */
  const counts = await db
    .select({ planId: workItems.planId, n: sql<number>`count(*)::int` })
    .from(workItems)
    .where(
      and(
        inArray(workItems.planId, rows.map((r) => r.id)),
        isNull(workItems.deletedAt),
      ),
    )
    .groupBy(workItems.planId);
  const taskCount = new Map(counts.map((c) => [c.planId, c.n]));

  const approver = techLeadId ? await lookupUser(db, techLeadId) : null;
  const now = Date.now();

  return rows.map((r) => ({
    id: r.id,
    requirementId: r.requirementId,
    title: planTitle(r.requirementTitle, r.requirementRaw),
    version: r.version,
    taskCount: taskCount.get(r.id) ?? 0,
    approver,
    estimatedHours: r.estimatedHours,
    estimatedCost: r.estimatedCost,
    waitingMinutes: Math.round((now - r.createdAt.getTime()) / 60_000),
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * ★ 需求在结构化之前没有 title，只有用户粘进来的原文。
 *   这时候显示空标题的卡片等于「有个东西要你批，但不告诉你是什么」——
 *   退回原文首句，至少能认出是哪一条。
 */
function planTitle(title: string | null, rawInput: string | null): string {
  if (title?.trim()) return title;
  const raw = rawInput?.trim().split('\n')[0] ?? '';
  if (!raw) return '未命名需求';
  return raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
}

async function lookupUser(db: Database, id: string): Promise<{ id: string; name: string } | null> {
  const { users } = await import('@apos/db');
  const [row] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, id));
  return row ?? null;
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
async function enrich(
  db: Database,
  rows: WorkItemRow[],
  identifier: string,
): Promise<BoardCard[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);

  const runs = await db
    .select()
    .from(agentRuns)
    .where(inArray(agentRuns.workItemId, ids))
    .orderBy(desc(agentRuns.attempt));
  const latestRun = new Map<string, (typeof runs)[number]>();
  for (const r of runs) {
    // ★ 规划 Run 没有工作项，不进这张按工作项索引的表
    if (!r.workItemId) continue;
    if (!latestRun.has(r.workItemId)) latestRun.set(r.workItemId, r);
  }

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
      ref: formatRef(identifier, r.number),
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
