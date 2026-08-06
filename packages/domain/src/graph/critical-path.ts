import type { GraphEdge, GraphMetrics, GraphNode } from './types';

const DONE_STATUSES: readonly string[] = ['done', 'released', 'acceptance', 'cancelled'];

export interface CycleReport {
  hasCycle: boolean;
  /** 环上的节点，按发现顺序 */
  nodes: string[];
}

/**
 * 环检测。
 *
 * ★ 必须先于关键路径跑：有环的图上「最长路径」是无穷大，
 *   拓扑排序会静默漏掉环上的节点，算出来的工期看起来正常，实际是错的。
 *   依赖成环要阻断执行（页面文档 07 §5.8），不能当成普通诊断混在后面。
 */
export function detectCycle(nodes: GraphNode[], edges: GraphEdge[]): CycleReport {
  const out = adjacency(nodes, edges);
  const state = new Map<string, 0 | 1 | 2>(); // 0 未访问 / 1 在栈上 / 2 已完成
  const stack: string[] = [];
  let cycle: string[] = [];

  const visit = (id: string): boolean => {
    state.set(id, 1);
    stack.push(id);

    for (const next of out.get(id) ?? []) {
      const s = state.get(next) ?? 0;
      if (s === 1) {
        // 回到栈上的节点 —— 从它开始截取就是环
        cycle = stack.slice(stack.indexOf(next));
        return true;
      }
      if (s === 0 && visit(next)) return true;
    }

    stack.pop();
    state.set(id, 2);
    return false;
  };

  for (const node of nodes) {
    if ((state.get(node.id) ?? 0) === 0 && visit(node.id)) {
      return { hasCycle: true, nodes: cycle };
    }
  }
  return { hasCycle: false, nodes: [] };
}

/** 拓扑序。图有环时返回 null —— 调用方必须显式处理，而不是拿到半个结果 */
export function topologicalOrder(nodes: GraphNode[], edges: GraphEdge[]): string[] | null {
  const out = adjacency(nodes, edges);
  const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));

  for (const e of edges) {
    if (!indegree.has(e.to) || !indegree.has(e.from)) continue;
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  }

  const queue = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of out.get(id) ?? []) {
      const left = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }

  return order.length === nodes.length ? order : null;
}

export interface CriticalPathResult {
  /** 每个节点的最早完成时间（小时），用于分层与诊断 */
  earliestFinish: Map<string, number>;
  paths: string[][];
  totalHours: number;
}

/**
 * 关键路径 = 依赖图上的最长路径。
 *
 * 边上的 lag 也计入 —— 「前置完成后还要等 2 小时才能开始」是真实工期的一部分，
 * 忽略它会让预测系统性偏乐观。
 */
export function computeCriticalPath(
  nodes: GraphNode[],
  edges: GraphEdge[],
): CriticalPathResult {
  const order = topologicalOrder(nodes, edges);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    incoming.set(e.to, [...(incoming.get(e.to) ?? []), e]);
  }

  const finish = new Map<string, number>();
  const predecessor = new Map<string, string | null>();

  // 有环时退化为按节点自身工期，不给出路径 —— 环必须先被处理
  const sequence = order ?? nodes.map((n) => n.id);

  for (const id of sequence) {
    const node = byId.get(id);
    if (!node) continue;

    let best = 0;
    let from: string | null = null;

    for (const edge of incoming.get(id) ?? []) {
      const candidate = (finish.get(edge.from) ?? 0) + edge.lagMinutes / 60;
      if (candidate > best) {
        best = candidate;
        from = edge.from;
      }
    }

    finish.set(id, best + node.durationHours);
    predecessor.set(id, from);
  }

  const totalHours = Math.max(0, ...finish.values());

  // 并列最长时全部返回（页面文档 07 §11：存在 2 条等长关键路径要说明）
  const endpoints = order
    ? [...finish.entries()].filter(([, v]) => nearlyEqual(v, totalHours)).map(([k]) => k)
    : [];

  const paths = endpoints.map((end) => {
    const path: string[] = [];
    let cursor: string | null = end;
    while (cursor) {
      path.unshift(cursor);
      cursor = predecessor.get(cursor) ?? null;
    }
    return path;
  });

  return { earliestFinish: finish, paths, totalHours };
}

/**
 * 顶部信息条的四个数字（页面文档 07 §5.3）。
 *
 * 延期风险不是拍脑袋：它由三个可观测的量合成 ——
 * 关键路径上被阻塞的时长、待决策超时的数量、失败重试消耗的时间。
 * 用不可解释的模型算这个数字，负责人就没法据此行动。
 */
export function computeMetrics(
  nodes: GraphNode[],
  edges: GraphEdge[],
  cp: CriticalPathResult,
): GraphMetrics {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const critical = new Set(cp.paths.flat());

  const remainingHours = [...critical]
    .map((id) => byId.get(id))
    .filter((n): n is GraphNode => Boolean(n) && !DONE_STATUSES.includes(n!.status))
    .reduce((sum, n) => sum + n.durationHours, 0);

  const criticalNodes = [...critical]
    .map((id) => byId.get(id))
    .filter((n): n is GraphNode => Boolean(n));

  const blockedHours = criticalNodes
    .filter((n) => n.blockedMinutes !== null)
    .reduce((sum, n) => sum + (n.blockedMinutes ?? 0) / 60, 0);

  const overdueDecisions = criticalNodes.filter(
    (n) => n.decisionDueInMinutes !== null && n.decisionDueInMinutes < 0,
  );
  const overdueHours = overdueDecisions.reduce(
    (sum, n) => sum + Math.abs(n.decisionDueInMinutes ?? 0) / 60,
    0,
  );

  const failed = criticalNodes.filter((n) => n.status === 'failed');

  // 已经损失的时间占剩余工期的比例，封顶 0.95 —— 不报 100%，
  // 那会让人觉得「已经没救了」从而放弃行动
  const lost = blockedHours + overdueHours + failed.length * 2;
  const delayRisk = remainingHours > 0 ? Math.min(lost / remainingHours, 0.95) : 0;

  return {
    totalHours: round(cp.totalHours),
    remainingHours: round(remainingHours),
    delayRisk: Math.round(delayRisk * 100) / 100,
    primaryCause: attributeCause({ blockedHours, overdueHours, overdueDecisions, failed, criticalNodes }),
    criticalPaths: cp.paths,
  };
}

/** 归因：挑贡献最大的那一项，并说清楚是哪个节点 */
function attributeCause(input: {
  blockedHours: number;
  overdueHours: number;
  overdueDecisions: GraphNode[];
  failed: GraphNode[];
  criticalNodes: GraphNode[];
}): string | null {
  const candidates: { weight: number; text: string }[] = [];

  const worstBlocked = input.criticalNodes
    .filter((n) => n.blockedMinutes !== null)
    .sort((a, b) => (b.blockedMinutes ?? 0) - (a.blockedMinutes ?? 0))[0];
  if (worstBlocked) {
    candidates.push({
      weight: (worstBlocked.blockedMinutes ?? 0) / 60,
      text: `「${worstBlocked.title}」阻塞 ${formatHours((worstBlocked.blockedMinutes ?? 0) / 60)}`,
    });
  }

  const worstOverdue = input.overdueDecisions.sort(
    (a, b) => (a.decisionDueInMinutes ?? 0) - (b.decisionDueInMinutes ?? 0),
  )[0];
  if (worstOverdue) {
    candidates.push({
      weight: Math.abs(worstOverdue.decisionDueInMinutes ?? 0) / 60,
      text: `决策等待 ${formatHours(Math.abs(worstOverdue.decisionDueInMinutes ?? 0) / 60)}`,
    });
  }

  if (input.failed.length > 0) {
    candidates.push({
      weight: input.failed.length * 2,
      text: `${input.failed.length} 个任务执行失败需重试`,
    });
  }

  return candidates.sort((a, b) => b.weight - a.weight)[0]?.text ?? null;
}

// ── 工具 ──────────────────────────────────────────────────────────────

export function adjacency(nodes: GraphNode[], edges: GraphEdge[]): Map<string, string[]> {
  const map = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (!map.has(e.from) || !map.has(e.to)) continue;
    map.get(e.from)!.push(e.to);
  }
  return map;
}

export function reverseAdjacency(nodes: GraphNode[], edges: GraphEdge[]): Map<string, string[]> {
  return adjacency(
    nodes,
    edges.map((e) => ({ ...e, from: e.to, to: e.from })),
  );
}

/** 某个节点的全部下游（传递闭包）—— 阻塞影响面靠它计算 */
export function descendants(start: string, out: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(out.get(start) ?? [])];

  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(out.get(id) ?? []));
  }
  return seen;
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.01;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function formatHours(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${Math.round(hours * 10) / 10}h`;
  return `${Math.round((hours / 24) * 10) / 10}d`;
}

/**
 * 一句话里出现的两个时长要用同一单位。
 *
 * 「工期 1.3d → 22h」看着像两个不相干的数，读者得先在脑子里换算才能比较；
 * 「31h → 22h」一眼就知道省了多少。单位按较大的那个定。
 */
export function formatHoursSpan(a: number, b: number): [string, string] {
  const useDays = Math.max(a, b) >= 24;
  const fmt = (h: number) =>
    useDays ? `${Math.round((h / 24) * 10) / 10}d` : `${Math.round(h * 10) / 10}h`;
  return [fmt(a), fmt(b)];
}

export { DONE_STATUSES };
