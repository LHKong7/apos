import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  agentRuns,
  agents,
  decisions,
  projects,
  users,
  workItemDependencies,
  workItems,
  type Database,
} from '@apos/db';
import type { Stage, WorkItemStatus } from '@apos/contracts';
import {
  computeCriticalPath,
  computeMetrics,
  diagnose,
  layoutGraph,
  type GraphEdge,
  type GraphNode,
  type LayoutKind,
  type NodeKind,
} from '@apos/domain';
import { formatRef } from '../modules/work-item/numbering';
import { notFound } from './errors';

/**
 * 执行图（页面文档 07 §9）。
 *
 * 节点、边、关键路径、诊断、布局一次算完 —— 布局放服务端是刻意的：
 * 它是纯函数，放这里才能缓存、被测试穷举，也才能保证同一张图在不同客户端
 * 长得一样（截图发进周报里对得上）。
 */
export async function getGraph(db: Database, projectId: string, layout: LayoutKind) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw notFound('项目');

  const all = await db
    .select()
    .from(workItems)
    .where(and(eq(workItems.projectId, projectId), isNull(workItems.deletedAt)))
    .orderBy(workItems.position);

  const deps = await db
    .select()
    .from(workItemDependencies)
    .where(eq(workItemDependencies.projectId, projectId));

  const items = inFlight(all, deps);

  if (items.length === 0) {
    return {
      nodes: [],
      edges: [],
      metrics: { totalHours: 0, remainingHours: 0, delayRisk: 0, primaryCause: null, criticalPaths: [] },
      diagnostics: [],
      layout: { kind: layout, positions: [], lanes: [], width: 0, height: 0 },
    };
  }

  const ids = items.map((i) => i.id);

  const nodes = await buildNodes(db, items, project.identifier);
  const edges: GraphEdge[] = deps
    // 跨项目或已删除任务的悬空边会让布局算出诡异的空列
    .filter((d) => ids.includes(d.fromId) && ids.includes(d.toId))
    .map((d) => ({ from: d.fromId, to: d.toId, type: d.type, lagMinutes: d.lagMinutes }));

  const cp = computeCriticalPath(nodes, edges);

  return {
    nodes,
    edges,
    metrics: computeMetrics(nodes, edges, cp),
    diagnostics: diagnose(nodes, edges, cp),
    layout: { kind: layout, ...layoutGraph(nodes, edges, layout) },
  };
}

type ItemRow = typeof workItems.$inferSelect;

/** 各类型任务缺少估时时的兜底工期（小时） */
const DEFAULT_HOURS: Record<string, number> = {
  approval: 2,
  decision: 2,
  review: 2,
  test: 4,
  research: 4,
  release: 2,
  bug: 4,
  task: 6,
};

async function buildNodes(
  db: Database,
  items: ItemRow[],
  identifier: string,
): Promise<GraphNode[]> {
  const ids = items.map((i) => i.id);

  const agentRows = await db.select({ id: agents.id, name: agents.name }).from(agents);
  const agentName = new Map(agentRows.map((a) => [a.id, a.name]));

  const userRows = await db.select({ id: users.id, name: users.name }).from(users);
  const userName = new Map(userRows.map((u) => [u.id, u.name]));

  const pending = await db
    .select()
    .from(decisions)
    .where(and(inArray(decisions.workItemId, ids), eq(decisions.status, 'pending')));
  const decisionByItem = new Map(pending.map((d) => [d.workItemId!, d]));

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

  const now = Date.now();

  return items.map((item) => {
    const decision = decisionByItem.get(item.id);
    const run = latestRun.get(item.id);
    const estimated = item.estimatedHours === null ? null : Number(item.estimatedHours);

    return {
      id: item.id,
      ref: formatRef(identifier, item.number),
      kind: nodeKindOf(item, Boolean(decision)),
      title: item.title,
      type: item.type,
      status: item.status as WorkItemStatus,
      stage: item.stage as Stage,
      riskLevel: item.riskLevel,
      priority: item.priority,
      executor:
        item.executorType && item.executorId
          ? {
              type: item.executorType,
              id: item.executorId,
              name:
                (item.executorType === 'agent'
                  ? agentName.get(item.executorId)
                  : userName.get(item.executorId)) ?? '未知',
            }
          : null,
      owner: item.ownerId
        ? { id: item.ownerId, name: userName.get(item.ownerId) ?? '未知' }
        : null,
      durationHours: estimated ?? DEFAULT_HOURS[item.type] ?? 4,
      // ★ 标出「这个数字是估的」—— 关键路径基于它算，用户有权知道置信度
      durationEstimated: estimated === null,
      progressPct:
        run && run.stepCurrent !== null && run.stepTotal
          ? Math.round((run.stepCurrent / run.stepTotal) * 100)
          : null,
      tokens: item.actualTokens,
      runId: run?.id ?? null,
      humanGateRef: decision?.id ?? null,
      decisionDueInMinutes: decision?.dueAt
        ? Math.round((decision.dueAt.getTime() - now) / 60_000)
        : null,
      blockedSince: item.blockedSince?.toISOString() ?? null,
      blockedReason: item.blockedReason,
      blockedDetail: item.blockedDetail ?? null,
      blockedMinutes: item.blockedSince
        ? Math.round((now - item.blockedSince.getTime()) / 60_000)
        : null,
      parentId: item.parentId,
    };
  });
}

/**
 * 节点类型判定（页面文档 07 §5.1）。
 *
 * 顺序有讲究：等待人拍板的任务先归为审批节点，不管它本身是什么类型 ——
 * 图上要一眼看出「卡在人这里」，这比「它原本是个 task」重要得多。
 */
function nodeKindOf(item: ItemRow, hasPendingDecision: boolean): NodeKind {
  if (hasPendingDecision || item.status === 'awaiting_decision') return 'approval';
  if (item.type === 'approval' || item.type === 'decision') return 'approval';
  if (item.type === 'release' || item.status === 'releasing') return 'release';
  if (item.type === 'review' || item.type === 'test') return 'verification';
  if (item.status === 'blocked' || item.blockedSince !== null) return 'waiting';
  if (item.executorType === 'human') return 'human_task';
  if (item.executorType === 'agent') return 'agent_task';
  // 还没分配执行主体 —— 画成等待，因为它现在确实动不了
  return 'waiting';
}

/**
 * 执行图只画「还在流动的部分」。
 *
 * ★ 项目跑上几个月会攒下几百个已完成任务，全画出来的图没人看得懂，
 *   而这一页要回答的是「为什么这条链走不动」—— 三个月前做完的孤立任务
 *   对这个问题一点贡献都没有。
 *
 *   但也不能简单地把终态全砍掉：一个正在等前置的任务，它的前置**已完成**
 *   这件事本身就是关键信息（「上游做完了，为什么我还没开始」）。
 *   所以规则是：未终结的全留，终结的只留与未终结项直接相连的那些。
 */
function inFlight(
  items: (typeof workItems.$inferSelect)[],
  deps: (typeof workItemDependencies.$inferSelect)[],
): (typeof workItems.$inferSelect)[] {
  const terminal = (s: string) => s === 'done' || s === 'cancelled';
  const live = new Set(items.filter((i) => !terminal(i.status)).map((i) => i.id));
  if (live.size === 0) return items;

  const keep = new Set(live);
  for (const d of deps) {
    if (live.has(d.toId)) keep.add(d.fromId);
    if (live.has(d.fromId)) keep.add(d.toId);
  }
  return items.filter((i) => keep.has(i.id));
}
