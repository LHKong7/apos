import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { projects, workItemDependencies, workItems, type Database } from '@apos/db';
import { SYSTEM_ACTOR, sameBlockedDetail, type BlockedDetail } from '@apos/contracts';
import { formatTokens, isDependencyMet } from '@apos/domain';
import type { RuntimeRegistry } from '@apos/agent-runtimes';
import { emitAndPublish } from '../event/bus';
import { loadDependencies } from './context';
import { dispatchRun } from '../agent/dispatch';
import { resolveExecutor } from '../agent/matching';
import type { WorkspaceService } from '../workspace';

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
  opts: {
    projectId?: string;
    limit?: number;
    correlationId: string;
    workspaces?: WorkspaceService;
  },
): Promise<ScheduleReport> {
  const candidates = await findSchedulable(db, opts.projectId, opts.limit ?? 50);
  const outcomes: ScheduleOutcome[] = [];

  for (const item of candidates) {
    outcomes.push(await scheduleOne(db, registry, item, opts.correlationId, opts.workspaces));
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
  workspaces: WorkspaceService | undefined,
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
    await emitAndPublish(db, {
      type: 'project.budget_threshold_reached',
      orgId: item.orgId,
      projectId: item.projectId,
      actor: SYSTEM_ACTOR,
      subjectType: 'project',
      subjectId: item.projectId,
      payload: { reason: budget.reason, workItemId: item.id },
      correlationId,
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
      /**
       * ★ 除了那句中文，把**逐个候选为什么被淘汰**也落库。
       *   界面拿到的是 (agentId, code, scope)，才能按层级分组、
       *   给出「把它加进项目」这种直达按钮，而不是让用户去读一行
       *   六个分号串起来的长句（问题记录 #2 / #12）。
       */
      await markBlocked(db, item, why, correlationId, {
        kind: match.rejected.length ? 'no_matching_agent' : 'no_agents_in_project',
        candidates: match.rejected.map((r) => ({
          agentId: r.agentId,
          agentName: r.agentName,
          code: r.code,
          scope: r.scope,
          params: r.params,
        })),
        detail: null,
      });
      return { ...base, action: 'skipped', reason: why };
    }
    const best = match.candidates[0]!;
    agentId = best.agentId;
    matchReasons = best.reasons;

    // 执行主体的落库由 dispatchRun 负责，这里只记录「为什么选它」
    await emitAndPublish(db, {
      type: 'work_item.assigned',
      orgId: item.orgId,
      projectId: item.projectId,
      actor: SYSTEM_ACTOR,
      subjectType: 'work_item',
      subjectId: item.id,
      payload: { executorType: 'agent', executorId: agentId, matchReasons, score: best.score },
      correlationId,
    });
  }

  const result = await dispatchRun(
    db,
    registry,
    { workItemId: item.id, agentId: agentId!, correlationId },
    { workspaces },
  );

  if (!result.ok) {
    /**
     * ★ 工作区准备不出来是**配置问题**，不是「这一轮先跳过」。
     *   不标 blocked 的话调度器会每 5 秒重试一次，日志刷满而看板上
     *   那张卡片始终显示 ready —— 用户根本不知道它卡在哪。
     */
    if (result.code === 'WORKSPACE_UNAVAILABLE') {
      const why = (result.detail as { reason?: string })?.reason ?? '工作区不可用';
      await markBlocked(db, item, why, correlationId, {
        kind: 'workspace_unavailable',
        candidates: [],
        detail: why,
      });
      return { ...base, action: 'skipped', reason: why, agentId: agentId! };
    }
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
  if (!project?.tokenBudget) return { ok: true };

  const spent = project.tokensSpent;
  const budget = project.tokenBudget;
  const estimated = item.estimatedTokens ?? 0;

  if (spent >= budget) {
    return {
      ok: false,
      reason: `项目已用 ${formatTokens(spent)} token，达到预算 ${formatTokens(budget)}，停止调度新任务`,
    };
  }
  if (spent + estimated > budget) {
    return {
      ok: false,
      reason: `预估 ${formatTokens(estimated)} token 将使项目超出预算（已用 ${formatTokens(spent)} / ${formatTokens(budget)}）`,
    };
  }
  return { ok: true };
}

/**
 * 标记阻塞。
 *
 * ★★ 只在**首次阻塞或原因变化**时写库与发事件。
 *
 *   调度器每轮都会重新推出同一个结论（Agent 还是没被加进项目），
 *   无条件写的代价是两处：Timeline 上堆出几十条一模一样的
 *   `work_item.blocked`，把真正的状态变更淹掉；以及 `blockedSince`
 *   每轮刷新一次，于是卡片上的阻塞时长**永远显示 0m** ——
 *   那一栏本来是用来判断「卡了多久」的，刷新之后它恒等于「刚刚」。
 *   （问题记录 #43 / #2）
 *
 *   Only write on first block or when the reason actually changes. The
 *   scheduler re-derives the same verdict every tick; writing unconditionally
 *   floods the timeline and keeps resetting `blockedSince`, so the card
 *   permanently reads "blocked 0m".
 */
async function markBlocked(
  db: Database,
  item: WorkItemRow,
  reason: string,
  correlationId: string,
  detail: Omit<BlockedDetail, 'at'>,
) {
  const previous = item.blockedDetail as BlockedDetail | null;
  const unchanged =
    item.blockedSince !== null &&
    item.blockedReason === reason &&
    sameBlockedDetail(previous, detail);

  if (unchanged) return;

  await db
    .update(workItems)
    .set({
      // ★ 已在阻塞中就保留原来的起点 —— 它衡量的是「卡了多久」，不是「上次扫到是什么时候」
      blockedSince: item.blockedSince ?? new Date(),
      blockedReason: reason,
      blockedDetail: { ...detail, at: new Date().toISOString() },
    })
    .where(eq(workItems.id, item.id));

  await emitAndPublish(db, {
    type: 'work_item.blocked',
    orgId: item.orgId,
    projectId: item.projectId,
    actor: SYSTEM_ACTOR,
    subjectType: 'work_item',
    subjectId: item.id,
    payload: { reason, detail },
    correlationId,
  });
}

export { workItemDependencies };
