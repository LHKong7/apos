import { describe, expect, it } from 'vitest';
import { layoutGraph, NODE_W } from './layout';
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
    blockedDetail: null,
    blockedMinutes: null,
    parentId: null,
    ...overrides,
  };
}

function edge(from: string, to: string): GraphEdge {
  return { from, to, type: 'finish_to_start', lagMinutes: 0 };
}

function xOf(result: ReturnType<typeof layoutGraph>, id: string): number {
  return result.positions.find((p) => p.id === id)!.x;
}

describe('分层布局', () => {
  /** 用最短深度会出现「箭头往回指」，图立刻变得难读 */
  it('★ 列 = 最长前驱深度，所有前置都在自己左边', () => {
    // a → b → c，同时 a → c：c 必须排在 b 右边，而不是和 b 同列
    const nodes = [node('a'), node('b'), node('c')];
    const result = layoutGraph(nodes, [edge('a', 'b'), edge('b', 'c'), edge('a', 'c')], 'layered');

    expect(xOf(result, 'a')).toBe(0);
    expect(xOf(result, 'b')).toBeGreaterThan(xOf(result, 'a'));
    expect(xOf(result, 'c')).toBeGreaterThan(xOf(result, 'b'));
  });

  it('无依赖的节点全在第一列', () => {
    const result = layoutGraph([node('a'), node('b'), node('c')], [], 'layered');
    expect(result.positions.every((p) => p.x === 0)).toBe(true);
    // 纵向排开，不重叠
    expect(new Set(result.positions.map((p) => p.y)).size).toBe(3);
  });

  /**
   * ★ 布局稳定性优先于美观：节点位置在实时更新里跳动
   *   比布局丑糟糕得多（页面文档 07 §11）。
   */
  it('★ 同样的输入永远得到同样的输出', () => {
    const nodes = [node('c'), node('a'), node('b')];
    const edges = [edge('a', 'b'), edge('a', 'c')];

    const first = layoutGraph(nodes, edges, 'layered');
    // 输入顺序变化不应改变结果
    const second = layoutGraph([...nodes].reverse(), edges, 'layered');

    expect(second.positions.sort(byId)).toEqual(first.positions.sort(byId));
  });

  it('宽高覆盖所有节点', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const result = layoutGraph(nodes, [edge('a', 'b'), edge('b', 'c')], 'layered');

    expect(result.width).toBeGreaterThanOrEqual(NODE_W * 3);
    for (const p of result.positions) {
      expect(p.x).toBeLessThanOrEqual(result.width);
      expect(p.y).toBeLessThanOrEqual(result.height);
    }
  });

  it('空图返回空布局而不是崩溃', () => {
    expect(layoutGraph([], [], 'layered')).toEqual({
      positions: [],
      lanes: [],
      width: 0,
      height: 0,
    });
  });

  it('有环时仍然能画出来 —— 环由诊断阻断，不该连图都看不到', () => {
    const nodes = [node('a'), node('b')];
    const result = layoutGraph(nodes, [edge('a', 'b'), edge('b', 'a')], 'layered');
    expect(result.positions).toHaveLength(2);
  });
});

describe('泳道布局', () => {
  it('按阶段分道，顺序与看板一致', () => {
    const nodes = [
      node('r', { stage: 'review' }),
      node('e', { stage: 'execution' }),
      node('i', { stage: 'intake' }),
    ];
    const result = layoutGraph(nodes, [], 'stage');

    expect(result.lanes.map((l) => l.key)).toEqual(['intake', 'execution', 'review']);
    // 泳道不重叠
    for (let i = 1; i < result.lanes.length; i++) {
      expect(result.lanes[i]!.y).toBeGreaterThanOrEqual(
        result.lanes[i - 1]!.y + result.lanes[i - 1]!.height,
      );
    }
  });

  /**
   * ★ 泳道里仍保留横轴的依赖语义。
   *   只按分组堆叠的话，图就退化成分组列表，
   *   「谁依赖谁」这个执行图存在的理由就没了。
   */
  it('★ 泳道内部仍按依赖深度分列', () => {
    const nodes = [
      node('a', { executor: { type: 'agent', id: 'a1', name: 'code' } }),
      node('b', { executor: { type: 'agent', id: 'a1', name: 'code' } }),
    ];
    const result = layoutGraph(nodes, [edge('a', 'b')], 'executor');

    expect(xOf(result, 'b')).toBeGreaterThan(xOf(result, 'a'));
    expect(result.lanes).toHaveLength(1);
  });

  it('未分配排在最后 —— 它不是一个真正的执行者', () => {
    const nodes = [
      node('x'),
      node('y', { executor: { type: 'agent', id: 'a1', name: 'code' } }),
    ];
    const result = layoutGraph(nodes, [], 'executor');
    expect(result.lanes.at(-1)!.key).toBe('unassigned');
    expect(result.lanes.at(-1)!.label).toBe('未分配');
  });

  it('每个节点都带上自己的泳道键', () => {
    const nodes = [node('a', { stage: 'execution' }), node('b', { stage: 'review' })];
    const result = layoutGraph(nodes, [], 'stage');

    expect(result.positions.find((p) => p.id === 'a')!.lane).toBe('execution');
    expect(result.positions.find((p) => p.id === 'b')!.lane).toBe('review');
  });
});

function byId(a: { id: string }, b: { id: string }) {
  return a.id.localeCompare(b.id);
}
