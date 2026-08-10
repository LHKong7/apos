import { describe, expect, it } from 'vitest';
import { computeCriticalPath } from './critical-path';
import { diagnose } from './diagnostics';
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

function edge(from: string, to: string, overrides: Partial<GraphEdge> = {}): GraphEdge {
  return { from, to, type: 'finish_to_start', lagMinutes: 0, ...overrides };
}

function run(nodes: GraphNode[], edges: GraphEdge[]) {
  return diagnose(nodes, edges, computeCriticalPath(nodes, edges));
}

/**
 * ★ 每条诊断必须带可执行动作 —— 只说「有问题」不说「怎么办」的提示，
 *   用户看两次就会忽略整个诊断区（页面文档 07 §5.8）。
 */
describe('每条诊断都要给出路', () => {
  it('所有诊断都带至少一个动作', () => {
    const nodes = [
      node('blocked', { blockedSince: 'x', blockedMinutes: 500, title: '数据库索引变更' }),
      node('a'),
      node('b'),
      node('c'),
      node('d'),
    ];
    const edges = [
      edge('blocked', 'a'),
      edge('a', 'b'),
      edge('b', 'c'),
      edge('c', 'd'),
    ];

    const results = run(nodes, edges);
    expect(results.length).toBeGreaterThan(0);
    for (const d of results) {
      expect(d.actions.length).toBeGreaterThan(0);
      expect(d.message.length).toBeGreaterThan(0);
    }
  });
});

describe('依赖成环', () => {
  it('报为 critical 并列出环上的节点', () => {
    const nodes = [node('a'), node('b')];
    const results = run(nodes, [edge('a', 'b'), edge('b', 'a')]);

    expect(results[0]!.type).toBe('cycle');
    expect(results[0]!.severity).toBe('critical');
    expect(results[0]!.affectedNodes.sort()).toEqual(['a', 'b']);
  });

  /**
   * 有环时拓扑序不成立，其他规则算出来的关键路径、下游数都是错的。
   * 把错的诊断和对的混在一起，比不给诊断更糟。
   */
  it('★ 有环时只报环，不给出其他不可信的诊断', () => {
    const nodes = [
      node('a', { blockedSince: 'x', blockedMinutes: 600 }),
      node('b'),
      node('c'),
      node('d'),
      node('e'),
    ];
    const edges = [
      edge('a', 'b'),
      edge('b', 'c'),
      edge('c', 'a'),
      edge('a', 'd'),
      edge('a', 'e'),
    ];

    const results = run(nodes, edges);
    expect(results).toHaveLength(1);
    expect(results[0]!.type).toBe('cycle');
  });
});

describe('阻塞影响放大', () => {
  it('下游 ≥ 3 个任务时报警，并说明影响面', () => {
    const nodes = [
      node('blocked', { blockedSince: 'x', blockedMinutes: 492, title: '数据库索引变更' }),
      node('a'),
      node('b'),
      node('c'),
    ];
    const edges = [edge('blocked', 'a'), edge('a', 'b'), edge('b', 'c')];

    const d = run(nodes, edges).find((x) => x.type === 'blocking_amplified')!;
    expect(d.message).toContain('数据库索引变更');
    expect(d.message).toContain('3 个任务');
    expect(d.message).toContain('8.2h');
  });

  it('下游不足 3 个不报 —— 阈值以下的噪声不值得占版面', () => {
    const nodes = [node('blocked', { blockedSince: 'x', blockedMinutes: 500 }), node('a')];
    expect(run(nodes, [edge('blocked', 'a')]).some((d) => d.type === 'blocking_amplified')).toBe(
      false,
    );
  });

  it('有待办决策时才给「催办」按钮', () => {
    const withGate = [
      node('blocked', { blockedSince: 'x', blockedMinutes: 500, humanGateRef: 'd-1' }),
      node('a'),
      node('b'),
      node('c'),
    ];
    const edges = [edge('blocked', 'a'), edge('a', 'b'), edge('b', 'c')];

    const d = run(withGate, edges).find((x) => x.type === 'blocking_amplified')!;
    expect(d.actions.map((a) => a.kind)).toContain('remind');

    const noGate = withGate.map((n) => ({ ...n, humanGateRef: null }));
    const d2 = run(noGate, edges).find((x) => x.type === 'blocking_amplified')!;
    expect(d2.actions.map((a) => a.kind)).not.toContain('remind');
  });
});

describe('伪串行', () => {
  it('只有顺序依赖时提示可并行', () => {
    const nodes = [node('a', { title: '实现多条件查询 API' }), node('b', { title: '查询结果缓存' })];
    const d = run(nodes, [edge('a', 'b')]).find((x) => x.type === 'pseudo_serial');

    expect(d).toBeDefined();
    expect(d!.message).toContain('查询结果缓存');
    expect(d!.actions[0]!.edge).toEqual({ from: 'a', to: 'b' });
  });

  /** 产物/数据依赖是真实约束，提示「可并行」会误导人做错决定 */
  it('★ 产物依赖与数据依赖不算伪串行', () => {
    const nodes = [node('a'), node('b')];
    expect(run(nodes, [edge('a', 'b', { type: 'artifact' })]).some((d) => d.type === 'pseudo_serial')).toBe(false);
    expect(run(nodes, [edge('a', 'b', { type: 'data' })]).some((d) => d.type === 'pseudo_serial')).toBe(false);
  });

  it('前置已完成时不提示 —— 现在改也省不了时间', () => {
    const nodes = [node('a', { status: 'done' }), node('b')];
    expect(run(nodes, [edge('a', 'b')]).some((d) => d.type === 'pseudo_serial')).toBe(false);
  });
});

describe('审批瓶颈', () => {
  it('关键路径上等待过久的审批节点被点名', () => {
    const nodes = [
      node('approval', { kind: 'approval', decisionDueInMinutes: -300, title: 'DBA 审批' }),
      node('next'),
    ];
    const d = run(nodes, [edge('approval', 'next')]).find((x) => x.type === 'approval_bottleneck');

    expect(d).toBeDefined();
    expect(d!.message).toContain('1 个人类审批节点');
    expect(d!.actions.map((a) => a.kind)).toContain('adjust_policy');
  });

  it('等待时间没到阈值不报', () => {
    const nodes = [node('approval', { kind: 'approval', decisionDueInMinutes: 60 }), node('next')];
    expect(
      run(nodes, [edge('approval', 'next')]).some((d) => d.type === 'approval_bottleneck'),
    ).toBe(false);
  });
});

describe('单点依赖与 Agent 过载', () => {
  it('被 5 个以上任务依赖时提示拆分', () => {
    const nodes = [node('hub', { title: '公共库改造' }), ...['a', 'b', 'c', 'd', 'e'].map((id) => node(id))];
    const edges = ['a', 'b', 'c', 'd', 'e'].map((id) => edge('hub', id));

    const d = run(nodes, edges).find((x) => x.type === 'single_point')!;
    expect(d.message).toContain('公共库改造');
    expect(d.actions.map((a) => a.kind)).toContain('split');
  });

  it('已完成的节点不算单点 —— 它不会再延期了', () => {
    const nodes = [
      node('hub', { status: 'done' }),
      ...['a', 'b', 'c', 'd', 'e'].map((id) => node(id)),
    ];
    const edges = ['a', 'b', 'c', 'd', 'e'].map((id) => edge('hub', id));
    expect(run(nodes, edges).some((d) => d.type === 'single_point')).toBe(false);
  });

  it('单个 Agent 承担关键路径 60% 以上时提示分散', () => {
    const agent = { type: 'agent', id: 'a-1', name: 'code-agent-1' };
    const nodes = [
      node('x', { executor: agent }),
      node('y', { executor: agent }),
      node('z', { executor: { type: 'agent', id: 'a-2', name: 'test-agent-1' } }),
    ];
    const edges = [edge('x', 'y'), edge('y', 'z')];

    const d = run(nodes, edges).find((x) => x.type === 'agent_overload')!;
    expect(d.message).toContain('code-agent-1');
    expect(d.message).toContain('67%');
  });
});

describe('排序', () => {
  it('严重的排前面 —— 诊断区只有三四行的视觉预算', () => {
    const nodes = [
      node('blocked', { blockedSince: 'x', blockedMinutes: 600 }),
      node('a'),
      node('b'),
      node('c'),
      node('d'),
      node('e'),
    ];
    const edges = [
      edge('blocked', 'a'),
      edge('a', 'b'),
      edge('b', 'c'),
      edge('c', 'd'),
      edge('d', 'e'),
    ];

    const results = run(nodes, edges);
    const severities = results.map((d) => d.severity);
    const rank = { critical: 0, warning: 1, info: 2 };
    for (let i = 1; i < severities.length; i++) {
      expect(rank[severities[i]!]).toBeGreaterThanOrEqual(rank[severities[i - 1]!]);
    }
  });
});
