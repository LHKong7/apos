import type { GraphEdge, GraphNode } from '@apos/domain';

export const HIGHLIGHT_MODES = ['critical', 'blocked', 'mine', 'risk'] as const;
export type HighlightMode = (typeof HIGHLIGHT_MODES)[number];

export const MODE_LABELS: Record<HighlightMode, string> = {
  critical: '关键路径',
  blocked: '阻塞链',
  mine: '我的任务',
  risk: '高风险',
};

export interface HighlightResult {
  /** 需要强调的节点。为空表示没开任何模式，全部正常显示 */
  emphasized: Set<string>;
  /** 阻塞链上的节点，额外画红框 */
  blockedChain: Set<string>;
  /** 关键路径上的边（`from→to` 形式的键） */
  criticalEdges: Set<string>;
  /** 是否需要把未强调的节点淡出 */
  dimOthers: boolean;
}

export function edgeKey(from: string, to: string): string {
  return `${from}→${to}`;
}

/**
 * 高亮计算（页面文档 07 §5.4）。
 *
 * 做成纯函数是因为它是这一页唯一「有对错」的渲染逻辑 ——
 * 上下游追溯算错一个节点，用户对影响面的判断就是错的，
 * 而这种错在肉眼看图时完全发现不了。
 */
export function computeHighlight(input: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  modes: HighlightMode[];
  criticalPaths: string[][];
  currentUserId: string | null;
  /** 悬停节点：它的全部上下游链路高亮，其余淡出 */
  hovered: string | null;
}): HighlightResult {
  const { nodes, edges, modes, criticalPaths, currentUserId, hovered } = input;

  const emphasized = new Set<string>();
  const blockedChain = new Set<string>();
  const criticalEdges = new Set<string>();

  const criticalNodes = new Set(criticalPaths.flat());
  for (const path of criticalPaths) {
    for (let i = 1; i < path.length; i++) {
      criticalEdges.add(edgeKey(path[i - 1]!, path[i]!));
    }
  }

  /**
   * ★ 悬停优先于所有高亮模式。
   *
   *   「悬停某节点 → 上下游链路高亮、其余淡出」是理解依赖最有效的交互
   *   （页面文档 07 §5.6）。它是一次即时的、目标明确的追问，
   *   此刻用户不关心关键路径，只关心「这个东西牵扯到谁」。
   *   叠加其他模式只会让答案糊掉。
   */
  if (hovered) {
    const chain = relatedChain(hovered, edges);
    return {
      emphasized: chain,
      blockedChain: new Set(),
      criticalEdges: modes.includes('critical') ? criticalEdges : new Set(),
      dimOthers: true,
    };
  }

  if (modes.includes('critical')) {
    for (const id of criticalNodes) emphasized.add(id);
  }

  if (modes.includes('blocked')) {
    const forward = adjacencyOf(nodes, edges);
    for (const node of nodes) {
      const stuck = node.blockedSince !== null || node.decisionDueInMinutes !== null;
      if (!stuck) continue;
      blockedChain.add(node.id);
      for (const id of downstream(node.id, forward)) blockedChain.add(id);
    }
    for (const id of blockedChain) emphasized.add(id);
  }

  if (modes.includes('mine') && currentUserId) {
    for (const node of nodes) {
      if (node.owner?.id === currentUserId || node.executor?.id === currentUserId) {
        emphasized.add(node.id);
      }
    }
  }

  if (modes.includes('risk')) {
    for (const node of nodes) {
      if (node.riskLevel === 'high' || node.riskLevel === 'critical') emphasized.add(node.id);
    }
  }

  return {
    emphasized,
    blockedChain,
    criticalEdges,
    dimOthers: modes.length > 0,
  };
}

/** 某节点的全部上游 + 下游（含自身）—— 「它牵扯到谁」的完整答案 */
export function relatedChain(id: string, edges: GraphEdge[]): Set<string> {
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  for (const e of edges) {
    forward.set(e.from, [...(forward.get(e.from) ?? []), e.to]);
    backward.set(e.to, [...(backward.get(e.to) ?? []), e.from]);
  }

  const chain = new Set<string>([id]);
  for (const target of downstream(id, forward)) chain.add(target);
  for (const source of downstream(id, backward)) chain.add(source);
  return chain;
}

function adjacencyOf(nodes: GraphNode[], edges: GraphEdge[]): Map<string, string[]> {
  const map = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (!map.has(e.from)) continue;
    map.get(e.from)!.push(e.to);
  }
  return map;
}

function downstream(start: string, adjacency: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(adjacency.get(start) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(adjacency.get(id) ?? []));
  }
  return seen;
}
