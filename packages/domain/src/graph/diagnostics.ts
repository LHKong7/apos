import {
  adjacency,
  computeCriticalPath,
  descendants,
  detectCycle,
  formatHours,
  formatHoursSpan,
  type CriticalPathResult,
} from './critical-path';
import type { Diagnostic, GraphEdge, GraphNode } from './types';

/** 判据阈值（页面文档 07 §5.8 的表格） */
export const THRESHOLDS = {
  /** 阻塞节点下游任务数 ≥ 此值算「影响放大」 */
  blockingDownstream: 3,
  /** 被多少个节点依赖算「单点」 */
  singlePointDependents: 5,
  /** 某 Agent 承担关键路径的比例 ≥ 此值算「过载」 */
  agentCriticalShare: 0.6,
  /** 关键路径上人类节点等待超过此小时数算「审批瓶颈」 */
  approvalWaitHours: 4,
} as const;

/**
 * 图诊断（页面文档 07 §5.8）。
 *
 * ★ MVP 硬编码这六条规则，不交给 Project Agent 生成（§12.3）。
 *   诊断的价值在于稳定可信 —— 同一张图今天说「审批是瓶颈」、
 *   明天说别的，负责人就不会再看它。规则明确了，才谈得上验证采纳率。
 *
 * ★ 每条诊断必须带可执行动作。只说「有问题」不说「怎么办」的提示，
 *   用户看两次就会忽略整个诊断区。
 */
export function diagnose(
  nodes: GraphNode[],
  edges: GraphEdge[],
  cp: CriticalPathResult,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const forward = adjacency(nodes, edges);

  // ── 1. 依赖成环：阻断性问题，排在最前 ──────────────────────────────
  const cycle = detectCycle(nodes, edges);
  if (cycle.hasCycle) {
    out.push({
      type: 'cycle',
      severity: 'critical',
      message: `检测到依赖环：${cycle.nodes.map((id) => byId.get(id)?.title ?? id).join(' → ')} → …。环上的任务永远等不到前置完成，必须先断开。`,
      affectedNodes: cycle.nodes,
      actions: [
        { kind: 'adjust_dependency', label: '手动断开依赖', nodeId: cycle.nodes[0] },
      ],
    });
    // 有环时后面几条规则的结果不可信（拓扑序不成立），直接返回
    return out;
  }

  // ── 2. 阻塞影响放大 ────────────────────────────────────────────────
  for (const node of nodes) {
    if (node.blockedSince === null && node.decisionDueInMinutes === null) continue;

    const downstream = descendants(node.id, forward);
    if (downstream.size < THRESHOLDS.blockingDownstream) continue;

    const criticalShare = shareOfCriticalPath(node.id, cp);
    const waited = node.blockedMinutes ?? Math.abs(node.decisionDueInMinutes ?? 0);

    out.push({
      type: 'blocking_amplified',
      severity: downstream.size >= 5 ? 'critical' : 'warning',
      message:
        `「${node.title}」已阻塞 ${formatHours(waited / 60)}，下游 ${downstream.size} 个任务在等` +
        (criticalShare > 0 ? `，占关键路径 ${Math.round(criticalShare * 100)}%` : ''),
      affectedNodes: [node.id, ...downstream],
      actions: [
        ...(node.humanGateRef
          ? [{ kind: 'remind' as const, label: '催办', nodeId: node.id }]
          : []),
        { kind: 'reassign', label: '改派', nodeId: node.id },
        { kind: 'locate', label: '在看板中定位', nodeId: node.id },
      ],
    });
  }

  // ── 3. 伪串行：拆开这条边能真正缩短工期 ────────────────────────────
  out.push(...findPseudoSerial(nodes, edges, cp, byId));

  // ── 4. 审批瓶颈 ────────────────────────────────────────────────────
  const approvalsOnPath = nodes.filter(
    (n) => n.kind === 'approval' && onCriticalPath(n.id, cp),
  );
  const waitingLong = approvalsOnPath.filter(
    (n) => waitHoursOf(n) >= THRESHOLDS.approvalWaitHours,
  );
  if (waitingLong.length > 0) {
    const avg =
      waitingLong.reduce((s, n) => s + waitHoursOf(n), 0) / waitingLong.length;
    out.push({
      type: 'approval_bottleneck',
      severity: 'warning',
      message: `关键路径上有 ${waitingLong.length} 个人类审批节点，平均已等待 ${formatHours(avg)}`,
      affectedNodes: waitingLong.map((n) => n.id),
      actions: [
        { kind: 'adjust_policy', label: '调整 Policy' },
        { kind: 'reassign', label: '增加备用审批人', nodeId: waitingLong[0]!.id },
      ],
    });
  }

  // ── 5. 单点依赖 ────────────────────────────────────────────────────
  for (const node of nodes) {
    const dependents = descendants(node.id, forward);
    if (dependents.size < THRESHOLDS.singlePointDependents) continue;
    if (isFinished(node.status)) continue;

    out.push({
      type: 'single_point',
      severity: 'warning',
      message: `${dependents.size} 个任务依赖「${node.title}」。它一旦延期，整条链都会顺延`,
      affectedNodes: [node.id, ...dependents],
      actions: [
        { kind: 'split', label: '拆分为可先行部分', nodeId: node.id },
        { kind: 'locate', label: '在看板中定位', nodeId: node.id },
      ],
    });
  }

  // ── 6. Agent 过载 ──────────────────────────────────────────────────
  const criticalIds = new Set(cp.paths.flat());
  if (criticalIds.size > 0) {
    const byAgent = new Map<string, { name: string; count: number }>();
    for (const id of criticalIds) {
      const node = byId.get(id);
      if (node?.executor?.type !== 'agent') continue;
      const entry = byAgent.get(node.executor.id) ?? { name: node.executor.name, count: 0 };
      entry.count += 1;
      byAgent.set(node.executor.id, entry);
    }

    for (const [agentId, entry] of byAgent) {
      const share = entry.count / criticalIds.size;
      if (share < THRESHOLDS.agentCriticalShare) continue;

      out.push({
        type: 'agent_overload',
        severity: 'info',
        message: `关键路径上 ${Math.round(share * 100)}% 的任务由 ${entry.name} 承担，它是单点`,
        affectedNodes: [...criticalIds].filter(
          (id) => byId.get(id)?.executor?.id === agentId,
        ),
        actions: [{ kind: 'reassign', label: '分散到其他 Agent' }],
      });
    }
  }

  // 严重的排前面：诊断区通常只有三四行的视觉预算
  const rank = { critical: 0, warning: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** 只有顺序关系、不涉及产物或数据的依赖，才有并行化的可能 */
function isWeakDependency(edge: GraphEdge): boolean {
  return edge.type === 'finish_to_start' || edge.type === 'start_to_start';
}

/** 一条诊断至少要能省下这么多小时才值得占版面 */
const MIN_SAVING_HOURS = 1;
/** 最多报几条 —— 诊断区只有三四行的视觉预算 */
const MAX_PSEUDO_SERIAL = 2;

/**
 * 伪串行诊断。
 *
 * ★ 判据是「拆开这条边能省多少工期」，而不是「这条边是不是弱依赖」。
 *
 *   只看依赖类型的话，规划器生成的链上每一条 finish_to_start 都会被点名 ——
 *   一张六条边的图报出五条建议，这不是洞察，是背景噪声，
 *   用户看两次就会忽略整个诊断区。
 *
 *   改成实际重算：去掉这条边，关键路径缩短多少。省不下时间的边不报；
 *   报出来的每一条都自带「30h → 24h」这个数字，
 *   而这个数字正是用户判断值不值得改的唯一依据。
 */
function findPseudoSerial(
  nodes: GraphNode[],
  edges: GraphEdge[],
  cp: CriticalPathResult,
  byId: Map<string, GraphNode>,
): Diagnostic[] {
  const candidates: { edge: GraphEdge; saving: number; newTotal: number }[] = [];

  for (const edge of edges) {
    if (!isWeakDependency(edge)) continue;

    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;

    // 前置已完成的边改了也不会缩短工期
    if (isFinished(from.status)) continue;
    // 同一个执行主体做的两件事，并行不了 —— 拆开只是把等待换了个地方
    if (from.executor && to.executor && from.executor.id === to.executor.id) continue;

    const without = computeCriticalPath(
      nodes,
      edges.filter((e) => !(e.from === edge.from && e.to === edge.to)),
    );
    const saving = cp.totalHours - without.totalHours;
    if (saving < MIN_SAVING_HOURS) continue;

    candidates.push({ edge, saving, newTotal: without.totalHours });
  }

  return candidates
    .sort((a, b) => b.saving - a.saving)
    .slice(0, MAX_PSEUDO_SERIAL)
    .map(({ edge, saving, newTotal }) => {
      const [before, after] = formatHoursSpan(cp.totalHours, newTotal);
      return {
      type: 'pseudo_serial' as const,
      severity: 'info' as const,
      message:
        `「${byId.get(edge.to)!.title}」等「${byId.get(edge.from)!.title}」只是顺序安排，` +
        `两者执行主体不同。若可并行，工期 ${before} → ${after}（省 ${formatHours(saving)}）`,
      affectedNodes: [edge.from, edge.to],
      actions: [
        {
          kind: 'adjust_dependency' as const,
          label: '调整依赖',
          edge: { from: edge.from, to: edge.to },
        },
      ],
      };
    });
}

function isFinished(status: string): boolean {
  return ['done', 'released', 'acceptance', 'cancelled'].includes(status);
}

function onCriticalPath(id: string, cp: CriticalPathResult): boolean {
  return cp.paths.some((p) => p.includes(id));
}

function shareOfCriticalPath(id: string, cp: CriticalPathResult): number {
  const all = new Set(cp.paths.flat());
  if (all.size === 0 || !all.has(id)) return 0;
  return 1 / all.size;
}

function waitHoursOf(node: GraphNode): number {
  if (node.blockedMinutes !== null) return node.blockedMinutes / 60;
  if (node.decisionDueInMinutes !== null && node.decisionDueInMinutes < 0) {
    return Math.abs(node.decisionDueInMinutes) / 60;
  }
  return 0;
}
