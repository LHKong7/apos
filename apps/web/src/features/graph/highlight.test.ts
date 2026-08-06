import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode } from '@apos/domain';
import { computeHighlight, edgeKey, relatedChain } from './highlight';

function node(id: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
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
    cost: '0',
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

function edge(from: string, to: string): GraphEdge {
  return { from, to, type: 'finish_to_start', lagMinutes: 0 };
}

const BASE = {
  currentUserId: null,
  hovered: null,
  criticalPaths: [] as string[][],
};

describe('上下游追溯', () => {
  /**
   * ★ 这是理解依赖最有效的交互（页面文档 07 §5.6），
   *   也是唯一「有对错」的渲染逻辑 —— 算错一个节点，
   *   用户对影响面的判断就是错的，而肉眼看图完全发现不了。
   */
  it('包含全部上游与下游，不只是直接相邻', () => {
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')];
    expect([...relatedChain('b', edges)].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('不含旁支 —— 与我无关的分支不该被高亮', () => {
    // a → b → c，另有 x → y 独立分支
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('x', 'y')];
    const chain = relatedChain('b', edges);

    expect(chain.has('x')).toBe(false);
    expect(chain.has('y')).toBe(false);
  });

  it('孤立节点只有自己', () => {
    expect([...relatedChain('lonely', [edge('a', 'b')])]).toEqual(['lonely']);
  });
});

describe('高亮模式', () => {
  it('未开任何模式时不淡出，全图正常显示', () => {
    const result = computeHighlight({
      ...BASE,
      nodes: [node('a'), node('b')],
      edges: [],
      modes: [],
    });

    expect(result.dimOthers).toBe(false);
    expect(result.emphasized.size).toBe(0);
  });

  it('关键路径模式标出路径节点与路径上的边', () => {
    const result = computeHighlight({
      ...BASE,
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('a', 'b'), edge('b', 'c'), edge('a', 'c')],
      modes: ['critical'],
      criticalPaths: [['a', 'b', 'c']],
    });

    expect([...result.emphasized].sort()).toEqual(['a', 'b', 'c']);
    expect(result.criticalEdges.has(edgeKey('a', 'b'))).toBe(true);
    expect(result.criticalEdges.has(edgeKey('b', 'c'))).toBe(true);
    // a→c 是捷径，不在关键路径上
    expect(result.criticalEdges.has(edgeKey('a', 'c'))).toBe(false);
  });

  it('阻塞链把阻塞节点的全部下游标红', () => {
    const result = computeHighlight({
      ...BASE,
      nodes: [
        node('blocked', { blockedSince: 'x', blockedMinutes: 100 }),
        node('a'),
        node('b'),
        node('unrelated'),
      ],
      edges: [edge('blocked', 'a'), edge('a', 'b')],
      modes: ['blocked'],
    });

    expect([...result.blockedChain].sort()).toEqual(['a', 'b', 'blocked']);
    expect(result.blockedChain.has('unrelated')).toBe(false);
  });

  it('待决策超时的节点也算阻塞源', () => {
    const result = computeHighlight({
      ...BASE,
      nodes: [node('gate', { decisionDueInMinutes: -120 }), node('a')],
      edges: [edge('gate', 'a')],
      modes: ['blocked'],
    });

    expect(result.blockedChain.has('gate')).toBe(true);
    expect(result.blockedChain.has('a')).toBe(true);
  });

  it('「我的任务」按负责人与执行者两个维度匹配', () => {
    const result = computeHighlight({
      ...BASE,
      nodes: [
        node('owned', { owner: { id: 'u-1', name: '张伟' } }),
        node('executing', { executor: { type: 'human', id: 'u-1', name: '张伟' } }),
        node('other', { owner: { id: 'u-2', name: '李娜' } }),
      ],
      edges: [],
      modes: ['mine'],
      currentUserId: 'u-1',
    });

    expect([...result.emphasized].sort()).toEqual(['executing', 'owned']);
  });

  it('多个模式叠加取并集', () => {
    const result = computeHighlight({
      ...BASE,
      nodes: [node('critical'), node('risky', { riskLevel: 'high' })],
      edges: [],
      modes: ['critical', 'risk'],
      criticalPaths: [['critical']],
    });

    expect([...result.emphasized].sort()).toEqual(['critical', 'risky']);
  });
});

describe('悬停优先', () => {
  /**
   * ★ 悬停是一次即时、目标明确的追问：「这个东西牵扯到谁」。
   *   此刻用户不关心关键路径，叠加其他模式只会让答案糊掉。
   */
  it('★ 悬停时只显示该节点的链路，压过所有高亮模式', () => {
    const result = computeHighlight({
      ...BASE,
      nodes: [node('a'), node('b'), node('x', { riskLevel: 'critical' })],
      edges: [edge('a', 'b')],
      modes: ['risk', 'critical'],
      criticalPaths: [['x']],
      hovered: 'a',
    });

    expect([...result.emphasized].sort()).toEqual(['a', 'b']);
    // 高风险的 x 不在链路上，此刻不该抢注意力
    expect(result.emphasized.has('x')).toBe(false);
    expect(result.dimOthers).toBe(true);
  });

  it('悬停时保留关键路径的边样式，方便对照', () => {
    const result = computeHighlight({
      ...BASE,
      nodes: [node('a'), node('b')],
      edges: [edge('a', 'b')],
      modes: ['critical'],
      criticalPaths: [['a', 'b']],
      hovered: 'a',
    });

    expect(result.criticalEdges.has(edgeKey('a', 'b'))).toBe(true);
  });

  it('没开关键路径模式时，悬停也不凭空画出关键路径', () => {
    const result = computeHighlight({
      ...BASE,
      nodes: [node('a'), node('b')],
      edges: [edge('a', 'b')],
      modes: [],
      criticalPaths: [['a', 'b']],
      hovered: 'a',
    });

    expect(result.criticalEdges.size).toBe(0);
  });
});
