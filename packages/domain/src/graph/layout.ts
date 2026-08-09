import { adjacency, reverseAdjacency, topologicalOrder } from './critical-path';
import type { GraphEdge, GraphNode } from './types';

export const LAYOUTS = ['layered', 'stage', 'executor'] as const;
export type LayoutKind = (typeof LAYOUTS)[number];

export interface PositionedNode {
  id: string;
  x: number;
  y: number;
  /** 泳道布局时的分组键，前端据此画泳道背景与标题 */
  lane: string | null;
}

export interface LayoutResult {
  positions: PositionedNode[];
  lanes: { key: string; label: string; y: number; height: number }[];
  width: number;
  height: number;
}

export const NODE_W = 168;
export const NODE_H = 64;
const COL_GAP = 72;
const ROW_GAP = 28;
const LANE_PAD = 16;

/**
 * 布局。
 *
 * ★ 在服务端算而不是前端（docs/product/pages/07 §9）：布局是纯函数，
 *   放服务端才能缓存、才能被测试穷举、也才能保证同一张图在不同客户端
 *   长得一样（截图发到周报里对得上）。
 *
 * ★ 稳定性优先于美观（§11）：节点位置在实时更新里跳动比布局丑糟糕得多。
 *   排序全部用确定性的键（层内按重心，重心相同按 position/id），
 *   同样的输入永远得到同样的输出。
 */
export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  kind: LayoutKind,
): LayoutResult {
  if (nodes.length === 0) return { positions: [], lanes: [], width: 0, height: 0 };

  const ranks = computeRanks(nodes, edges);

  if (kind === 'layered') return layered(nodes, ranks, edges);
  return swimlanes(nodes, ranks, edges, kind);
}

/**
 * 分层：节点的列 = 它在依赖图上的最长前驱深度。
 *
 * 用最长而不是最短，是为了让所有前置都排在自己左边 ——
 * 用最短深度会出现「箭头往回指」，图立刻变得难读。
 */
function computeRanks(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const rank = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const order = topologicalOrder(nodes, edges);
  const incoming = reverseAdjacency(nodes, edges);

  // 有环时退化为全部同层，图仍然能画出来（环本身由诊断阻断）
  for (const id of order ?? []) {
    const preds = incoming.get(id) ?? [];
    const deepest = preds.reduce((max, p) => Math.max(max, (rank.get(p) ?? 0) + 1), 0);
    rank.set(id, deepest);
  }

  return rank;
}

function layered(
  nodes: GraphNode[],
  ranks: Map<string, number>,
  edges: GraphEdge[],
): LayoutResult {
  const columns = groupBy(nodes, (n) => String(ranks.get(n.id) ?? 0));
  const sortedKeys = [...columns.keys()].sort((a, b) => Number(a) - Number(b));

  const orderInColumn = minimizeCrossings(columns, sortedKeys, edges);
  const positions: PositionedNode[] = [];
  let maxRows = 0;

  sortedKeys.forEach((key, col) => {
    const ordered = orderInColumn.get(key)!;
    maxRows = Math.max(maxRows, ordered.length);
    ordered.forEach((node, row) => {
      positions.push({
        id: node.id,
        x: col * (NODE_W + COL_GAP),
        y: row * (NODE_H + ROW_GAP),
        lane: null,
      });
    });
  });

  return {
    positions,
    lanes: [],
    width: sortedKeys.length * (NODE_W + COL_GAP) - COL_GAP,
    height: maxRows * (NODE_H + ROW_GAP) - ROW_GAP,
  };
}

const STAGE_LABELS: Record<string, string> = {
  intake: 'Intake',
  planning: 'Planning',
  execution: 'Execution',
  review: 'Review',
  release: 'Release',
  done: 'Done',
};

const STAGE_ORDER = ['intake', 'planning', 'execution', 'review', 'release', 'done'];

/**
 * 泳道布局：横轴仍是依赖深度，纵轴按阶段或执行者分组。
 *
 * 保留横轴的依赖语义很重要 —— 只按分组堆叠的话，图就退化成分组列表，
 * 「谁依赖谁」这个执行图存在的理由就没了。
 */
function swimlanes(
  nodes: GraphNode[],
  ranks: Map<string, number>,
  edges: GraphEdge[],
  kind: 'stage' | 'executor',
): LayoutResult {
  const keyOf = (n: GraphNode) =>
    kind === 'stage' ? n.stage : (n.executor?.id ?? 'unassigned');
  const labelOf = (n: GraphNode) =>
    kind === 'stage'
      ? (STAGE_LABELS[n.stage] ?? n.stage)
      : (n.executor?.name ?? '未分配');

  const groups = groupBy(nodes, keyOf);
  const laneKeys = [...groups.keys()].sort((a, b) => {
    if (kind === 'stage') return STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b);
    // 未分配排最后：它是「还没安排」，不是一个真正的执行者
    if (a === 'unassigned') return 1;
    if (b === 'unassigned') return -1;
    return a.localeCompare(b);
  });

  const positions: PositionedNode[] = [];
  const lanes: LayoutResult['lanes'] = [];
  let cursorY = 0;
  let maxCol = 0;

  for (const laneKey of laneKeys) {
    const members = groups.get(laneKey)!;
    // 泳道内部仍按依赖深度分列，同列的堆叠
    const byColumn = groupBy(members, (n) => String(ranks.get(n.id) ?? 0));
    let laneRows = 0;

    for (const [colKey, colNodes] of byColumn) {
      const col = Number(colKey);
      maxCol = Math.max(maxCol, col);
      laneRows = Math.max(laneRows, colNodes.length);

      sortStable(colNodes).forEach((node, row) => {
        positions.push({
          id: node.id,
          x: col * (NODE_W + COL_GAP),
          y: cursorY + LANE_PAD + row * (NODE_H + ROW_GAP),
          lane: laneKey,
        });
      });
    }

    const height = laneRows * (NODE_H + ROW_GAP) - ROW_GAP + LANE_PAD * 2;
    lanes.push({ key: laneKey, label: labelOf(members[0]!), y: cursorY, height });
    cursorY += height;
  }

  return {
    positions,
    lanes,
    width: (maxCol + 1) * (NODE_W + COL_GAP) - COL_GAP,
    height: cursorY,
  };
}

/**
 * 层内排序：重心启发式（barycenter）。
 *
 * 把每个节点放到它前驱平均位置附近，能显著减少连线交叉。
 * 不追求最优 —— 最小交叉是 NP-hard，而对 200 个节点以内的图，
 * 一轮重心排序的效果已经和「看得懂」之间没有差距了。
 */
function minimizeCrossings(
  columns: Map<string, GraphNode[]>,
  sortedKeys: string[],
  edges: GraphEdge[],
): Map<string, GraphNode[]> {
  const result = new Map<string, GraphNode[]>();
  const indexOf = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const e of edges) {
    incoming.set(e.to, [...(incoming.get(e.to) ?? []), e.from]);
  }

  for (const key of sortedKeys) {
    const nodes = columns.get(key)!;

    const ordered = [...nodes].sort((a, b) => {
      const ba = barycenter(a.id, incoming, indexOf);
      const bb = barycenter(b.id, incoming, indexOf);
      if (ba !== bb) return ba - bb;
      // 重心相同时用确定性的兜底键，保证布局可重复
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.id.localeCompare(b.id);
    });

    ordered.forEach((n, i) => indexOf.set(n.id, i));
    result.set(key, ordered);
  }

  return result;
}

function barycenter(
  id: string,
  incoming: Map<string, string[]>,
  indexOf: Map<string, number>,
): number {
  const preds = (incoming.get(id) ?? []).map((p) => indexOf.get(p)).filter((v): v is number => v !== undefined);
  if (preds.length === 0) return Number.MAX_SAFE_INTEGER;
  return preds.reduce((a, b) => a + b, 0) / preds.length;
}

function sortStable(nodes: GraphNode[]): GraphNode[] {
  return [...nodes].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    map.set(k, [...(map.get(k) ?? []), item]);
  }
  return map;
}

export { adjacency };
