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
 * The execution graph (page doc 07 §9) / 执行图（页面文档 07 §9）。
 *
 * Nodes, edges, critical path, diagnostics, and layout are all computed in one pass — keeping
 * layout on the server is deliberate: it is a pure function, so here it can be cached,
 * exhaustively tested, and guaranteed to render the same graph on every client (a screenshot
 * pasted into the weekly report matches what everyone else sees).
 * 节点、边、关键路径、诊断、布局一次算完 —— 布局放服务端是刻意的：
 * 它是纯函数，放这里才能缓存、被测试穷举，也才能保证同一张图在不同客户端
 * 长得一样（截图发进周报里对得上）。
 */
export async function getGraph(db: Database, projectId: string, layout: LayoutKind) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw notFound('project');

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
    // Dangling edges to cross-project or deleted items make the layout produce odd empty
    // columns
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

/**
 * Diagnostics and attribution only; no layout / 只要诊断与归因，不要布局。
 *
 * ★★ "Problem diagnostics" used to be visible on the execution-graph page alone — and there
 *   every problem carries an actionable button (reassign / nudge / adjust the policy), which
 *   makes it the most useful block in the product (issues #38 / #40). Seeing a blocked task on
 *   the board or the overview, all a user could do was open it and work it out themselves.
 *
 * ★ Shares the same domain functions as `getGraph` rather than carrying a second copy of the
 *   judgment — the cost of two implementations is not duplicated code, it is two answers that
 *   disagree.
 *
 * ★ Skips `layoutGraph`: layout is the most expensive step in the set, and the overview draws
 *   no graph.
 *   「问题诊断」此前只在执行图那一页看得见 —— 那里的每条问题都带着
 *   「改派 / 催办 / 调整 Policy」这类可执行按钮，而这恰恰是全站最有用的
 *   一块（问题记录 #38 / #40）。看板与总览上看到一条阻塞任务时，
 *   用户能做的只有点开它自己想办法。
 *   与 `getGraph` 共用同一套 domain 函数，不另写一份判定 ——
 *   两份实现的代价不是重复代码，是两个对不上的答案。
 *   跳过 `layoutGraph`：布局是这一整套里最贵的一步，而总览上不画图。
 */
export async function getProjectDiagnostics(db: Database, projectId: string) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw notFound('project');

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
    return { metrics: { totalHours: 0, remainingHours: 0, delayRisk: 0, primaryCause: null, criticalPaths: [] }, diagnostics: [] };
  }

  const ids = items.map((i) => i.id);
  const nodes = await buildNodes(db, items, project.identifier);
  const edges: GraphEdge[] = deps
    .filter((d) => ids.includes(d.fromId) && ids.includes(d.toId))
    .map((d) => ({ from: d.fromId, to: d.toId, type: d.type, lagMinutes: d.lagMinutes }));

  const cp = computeCriticalPath(nodes, edges);
  return { metrics: computeMetrics(nodes, edges, cp), diagnostics: diagnose(nodes, edges, cp) };
}

type ItemRow = typeof workItems.$inferSelect;

/** Fallback duration per work-item type when no estimate exists (hours) */
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
    // ★ Planning runs have no work item, so they never enter this work-item-keyed map
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
      // ★ Flag that this number is a guess — the critical path is computed from it, and the
      // user is entitled to know how much to trust it
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
 * Deciding a node's kind (page doc 07 §5.1) / 节点类型判定（页面文档 07 §5.1）。
 *
 * The order matters: an item waiting on a human decision is classified as an approval node
 * first, whatever its own type says — the graph has to show "stuck on a person" at a glance,
 * and that matters far more than "it was originally a task".
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
  // No executor assigned yet — draw it as waiting, because right now it genuinely cannot move
  return 'waiting';
}

/**
 * The execution graph draws only the part still in motion / 执行图只画「还在流动的部分」。
 *
 * ★ A few months in, a project has hundreds of finished tasks; drawing them all produces a
 *   graph nobody can read, while the question this page answers is "why is this chain not
 *   moving" — and an isolated task finished three months ago contributes nothing to it.
 *
 *   But terminal items cannot simply be cut either: for a task waiting on a predecessor, the
 *   fact that its predecessor is **done** is itself the key information ("upstream finished, so
 *   why have I not started?"). Hence the rule: keep every non-terminal item, and keep only
 *   those terminal items directly connected to a non-terminal one.
 *   项目跑上几个月会攒下几百个已完成任务，全画出来的图没人看得懂，
 *   而这一页要回答的是「为什么这条链走不动」—— 三个月前做完的孤立任务
 *   对这个问题一点贡献都没有。
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
