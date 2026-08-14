import { describe, expect, it } from 'vitest';
import {
  computeCriticalPath,
  computeMetrics,
  descendants,
  detectCycle,
  adjacency,
  topologicalOrder,
} from './critical-path';
import type { GraphEdge, GraphNode } from './types';

function node(id: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    ref: `T-${id}`,
    kind: 'agent_task',
    title: id,
    type: 'task',
    status: 'ready',
    stage: 'execution',
    riskLevel: 'low',
    priority: 2,
    executor: null,
    owner: null,
    durationHours: 1,
    durationEstimated: false,
    progressPct: null,
    tokens: 0,
    runId: null,
    humanGateRef: null,
    decisionDueInMinutes: null,
    blockedSince: null,
    blockedReason: null,
    blockedMinutes: null,
    parentId: null,
    ...overrides,
  };
}

function edge(from: string, to: string, overrides: Partial<GraphEdge> = {}): GraphEdge {
  return { from, to, type: 'finish_to_start', lagMinutes: 0, ...overrides };
}

describe('环检测', () => {
  it('无环图返回 false', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [edge('a', 'b'), edge('b', 'c')];
    expect(detectCycle(nodes, edges).hasCycle).toBe(false);
  });

  it('找出环上的节点', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')];

    const report = detectCycle(nodes, edges);
    expect(report.hasCycle).toBe(true);
    expect(report.nodes.sort()).toEqual(['a', 'b', 'c']);
  });

  it('自环也算环', () => {
    expect(detectCycle([node('a')], [edge('a', 'a')]).hasCycle).toBe(true);
  });

  /** 拓扑排序会静默漏掉环上的节点，算出来的工期看起来正常但是错的 */
  it('★ 有环时拓扑序返回 null，而不是给半个结果', () => {
    const nodes = [node('a'), node('b')];
    expect(topologicalOrder(nodes, [edge('a', 'b'), edge('b', 'a')])).toBeNull();
    expect(topologicalOrder(nodes, [edge('a', 'b')])).toEqual(['a', 'b']);
  });
});

describe('关键路径', () => {
  it('取最长路径而不是最短', () => {
    // a → b(5h) → d  与  a → c(1h) → d，关键路径必须走 b
    const nodes = [
      node('a', { durationHours: 1 }),
      node('b', { durationHours: 5 }),
      node('c', { durationHours: 1 }),
      node('d', { durationHours: 1 }),
    ];
    const edges = [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')];

    const cp = computeCriticalPath(nodes, edges);
    expect(cp.totalHours).toBe(7);
    expect(cp.paths[0]).toEqual(['a', 'b', 'd']);
  });

  /** 「前置完成后还要等 2 小时」是真实工期的一部分，忽略它会系统性偏乐观 */
  it('★ 边上的 lag 计入总工期', () => {
    const nodes = [node('a', { durationHours: 1 }), node('b', { durationHours: 1 })];
    const withLag = computeCriticalPath(nodes, [edge('a', 'b', { lagMinutes: 120 })]);
    const without = computeCriticalPath(nodes, [edge('a', 'b')]);

    expect(withLag.totalHours).toBe(4);
    expect(without.totalHours).toBe(2);
  });

  it('并列最长时返回多条路径（页面文档 07 §11）', () => {
    const nodes = [
      node('a', { durationHours: 1 }),
      node('b', { durationHours: 2 }),
      node('c', { durationHours: 2 }),
    ];
    const cp = computeCriticalPath(nodes, [edge('a', 'b'), edge('a', 'c')]);

    expect(cp.totalHours).toBe(3);
    expect(cp.paths).toHaveLength(2);
  });

  it('孤立节点各成一条路径', () => {
    const cp = computeCriticalPath([node('a', { durationHours: 3 }), node('b', { durationHours: 1 })], []);
    expect(cp.totalHours).toBe(3);
    expect(cp.paths).toEqual([['a']]);
  });

  it('空图不炸', () => {
    const cp = computeCriticalPath([], []);
    expect(cp.totalHours).toBe(0);
    expect(cp.paths).toEqual([]);
  });
});

describe('下游影响面', () => {
  it('传递闭包，不只是直接下游', () => {
    const nodes = [node('a'), node('b'), node('c'), node('d')];
    const out = adjacency(nodes, [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')]);

    expect([...descendants('a', out)].sort()).toEqual(['b', 'c', 'd']);
    expect([...descendants('c', out)].sort()).toEqual(['d']);
    expect([...descendants('d', out)]).toEqual([]);
  });

  it('菱形结构不重复计数', () => {
    const nodes = [node('a'), node('b'), node('c'), node('d')];
    const out = adjacency(nodes, [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')]);
    expect(descendants('a', out).size).toBe(3);
  });
});

describe('指标与归因', () => {
  it('剩余工期只算关键路径上未完成的部分', () => {
    const nodes = [
      node('a', { durationHours: 2, status: 'done' }),
      node('b', { durationHours: 3 }),
    ];
    const edges = [edge('a', 'b')];
    const m = computeMetrics(nodes, edges, computeCriticalPath(nodes, edges));

    expect(m.totalHours).toBe(5);
    expect(m.remainingHours).toBe(3);
  });

  /**
   * ★ 归因是这一页价值的浓缩：它直接告诉负责人该去解决什么。
   *   只给一个「延期风险 68%」的数字，人只会焦虑，不会行动。
   */
  it('挑贡献最大的那一项作为主因，并指名道姓', () => {
    const nodes = [
      node('a', { durationHours: 4, blockedMinutes: 492, blockedSince: 'x', title: '数据库索引变更' }),
      node('b', { durationHours: 4 }),
    ];
    const edges = [edge('a', 'b')];
    const m = computeMetrics(nodes, edges, computeCriticalPath(nodes, edges));

    expect(m.primaryCause).toContain('数据库索引变更');
    expect(m.primaryCause).toContain('阻塞');
  });

  it('决策超时比阻塞更久时，主因换成决策等待', () => {
    const nodes = [
      node('a', { durationHours: 4, blockedMinutes: 30, blockedSince: 'x' }),
      node('b', { durationHours: 4, decisionDueInMinutes: -600 }),
    ];
    const edges = [edge('a', 'b')];
    const m = computeMetrics(nodes, edges, computeCriticalPath(nodes, edges));

    expect(m.primaryCause).toContain('决策等待');
  });

  it('一切正常时没有主因', () => {
    const nodes = [node('a'), node('b')];
    const edges = [edge('a', 'b')];
    const m = computeMetrics(nodes, edges, computeCriticalPath(nodes, edges));

    expect(m.primaryCause).toBeNull();
    expect(m.delayRisk).toBe(0);
  });

  /** 报 100% 会让人觉得「已经没救了」从而放弃行动 */
  it('★ 延期风险封顶 0.95，不报必然延期', () => {
    const nodes = [node('a', { durationHours: 1, blockedMinutes: 10_000, blockedSince: 'x' })];
    const m = computeMetrics(nodes, [], computeCriticalPath(nodes, []));

    expect(m.delayRisk).toBe(0.95);
  });
});
