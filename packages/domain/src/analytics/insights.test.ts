import { describe, expect, it } from 'vitest';
import { computeAgents } from './agents';
import { computeCost } from './cost';
import { computeHitl } from './hitl';
import { findInsights } from './insights';
import { buildSegments } from './timeline';
import type {
  AgentMetrics,
  AnalyticsInput,
  CostMetrics,
  DecisionRow,
  FlowMetrics,
  HitlMetrics,
  RunRow,
} from './types';

const T0 = Date.UTC(2026, 0, 1);
const H = 3_600_000;
const D = 24 * H;
const NOW = T0 + 30 * D;

function input(o: Partial<AnalyticsInput> = {}): AnalyticsInput {
  return {
    window: { from: T0, to: NOW },
    items: [],
    changes: [],
    runs: [],
    decisions: [],
    agents: [],
    overrides: [],
    policyEvals: [],
    budget: null,
    costSpentTotal: 0,
    ...o,
  };
}

function decision(id: string, o: Partial<DecisionRow> = {}): DecisionRow {
  return {
    id,
    type: 'release_approval',
    title: id,
    status: 'approved',
    riskLevel: 'low',
    createdAt: T0 + D,
    resolvedAt: T0 + D + 2 * H,
    dueAt: null,
    workItemId: `item-${id}`,
    stage: 'release',
    ...o,
  };
}

function run(id: string, o: Partial<RunRow> = {}): RunRow {
  return {
    id,
    workItemId: `item-${id}`,
    agentId: 'agent-1',
    attempt: 1,
    status: 'completed',
    cost: 1,
    startedAt: T0 + D,
    endedAt: T0 + D + 10 * 60_000,
    createdAt: T0 + D,
    errorClass: null,
    model: 'claude-opus-5',
    tokensInput: 0,
    tokensOutput: 0,
    tokensCacheRead: 0,
    ...o,
  };
}

const segments = (i: AnalyticsInput) =>
  buildSegments(i.changes, new Map(i.items.map((x) => [x.id, x.createdAt])));

describe('重复决策与自动化潜力', () => {
  /**
   * ★ 这是 HITL Tab 的落点，也是唯一能真正减少人类工作量的产出。
   *   判据必须同时看次数和结果一致性 —— 只看次数会把充满争议的决策
   *   也推荐规则化，那种决策恰恰最需要人。
   */
  it('★ 次数多且结果一致 → 高潜力', () => {
    const decisions = Array.from({ length: 6 }, (_, i) =>
      decision(`d${i}`, { type: 'test_env_release' }),
    );
    const i = input({ decisions });
    const hitl = computeHitl(i, segments(i), NOW);

    expect(hitl.repeated[0]).toMatchObject({
      type: 'test_env_release',
      count: 6,
      consistency: 1,
      potential: 'high',
    });
  });

  it('★ 次数多但结果分歧 → 不推荐自动化', () => {
    const decisions = [
      ...Array.from({ length: 7 }, (_, i) => decision(`ok${i}`, { type: 'db_change' })),
      ...Array.from({ length: 5 }, (_, i) =>
        decision(`no${i}`, { type: 'db_change', status: 'rejected' }),
      ),
    ];
    const i = input({ decisions });
    const hitl = computeHitl(i, segments(i), NOW);

    expect(hitl.repeated[0]!.count).toBe(12);
    // 12 次里批了 7 驳了 5 —— 这种判断没法写成规则
    expect(hitl.repeated[0]!.potential).toBe('low');
  });

  it('出现次数太少不算「重复」', () => {
    const i = input({ decisions: [decision('a'), decision('b')] });
    expect(computeHitl(i, segments(i), NOW).repeated).toHaveLength(0);
  });
});

describe('人类介入总览', () => {
  it('自动化率 = 自动放行 / 全部策略评估', () => {
    const i = input({
      policyEvals: [
        { at: T0 + D, action: 'allow', itemId: 'a' },
        { at: T0 + D, action: 'allow_and_notify', itemId: 'b' },
        { at: T0 + D, action: 'require_human_review', itemId: 'c' },
        { at: T0 + D, action: 'ask', itemId: 'd' },
      ],
    });

    expect(computeHitl(i, segments(i), NOW).automationRate).toBe(0.5);
  });

  it('超时既算已过期未处理的，也算处理时已经晚了的', () => {
    const i = input({
      decisions: [
        decision('pending', { resolvedAt: null, dueAt: T0 + 2 * D }),
        decision('late', { dueAt: T0 + D, resolvedAt: T0 + 2 * D }),
        decision('ontime', { dueAt: T0 + 5 * D, resolvedAt: T0 + 2 * D }),
      ],
    });

    expect(computeHitl(i, segments(i), NOW).overdue).toBe(2);
  });

  it('最慢那一档只有一类决策时直接点名', () => {
    const i = input({
      decisions: [
        decision('slow1', { type: 'db_change', resolvedAt: T0 + D + 20 * H }),
        decision('slow2', { type: 'db_change', resolvedAt: T0 + D + 30 * H }),
        decision('fast', { type: 'release_approval', resolvedAt: T0 + D + 10 * 60_000 }),
      ],
    });
    const hitl = computeHitl(i, segments(i), NOW);

    expect(hitl.responseBuckets.at(-1)).toMatchObject({ count: 2, slowest: '数据库变更审批' });
  });
});

describe('Agent 对比', () => {
  /**
   * ★ 重试会把总成功率拉回去，掩盖「它第一次几乎从来做不对」这个真问题。
   *   首次成功率是唯一能看见它的指标。
   */
  it('★ 首次成功率只看 attempt = 1，不被重试掩盖', () => {
    const i = input({
      agents: [{ id: 'agent-1', name: 'code-agent', type: 'coder', model: null }],
      runs: [
        run('a', { attempt: 1, status: 'failed' }),
        run('a2', { attempt: 2, status: 'completed', workItemId: 'item-a' }),
        run('b', { attempt: 1, status: 'failed' }),
        run('b2', { attempt: 2, status: 'completed', workItemId: 'item-b' }),
      ],
    });

    const perf = computeAgents(i).agents[0]!;
    expect(perf.successRate).toBe(0.5);
    expect(perf.firstTrySuccessRate).toBe(0); // 一次都没一把过
  });

  /**
   * ★ 只赢一两项不给建议：便宜但成功率低的 Agent 未必更差，
   *   那是权衡不是结论，替用户下判断反而有害。
   */
  it('★ 三项全赢才给「全面优于」的调度建议', () => {
    const agents = [
      { id: 'a1', name: 'agent-1', type: 'coder', model: null },
      { id: 'a2', name: 'agent-2', type: 'coder', model: null },
    ];
    // a2 更便宜更快，但成功率更低 —— 这是权衡
    const runs = [
      ...Array.from({ length: 5 }, (_, n) =>
        run(`x${n}`, { agentId: 'a1', cost: 5, status: 'completed', endedAt: T0 + D + 20 * 60_000 }),
      ),
      ...Array.from({ length: 5 }, (_, n) =>
        run(`y${n}`, {
          agentId: 'a2',
          cost: 1,
          status: n === 0 ? 'completed' : 'failed',
          endedAt: T0 + D + 5 * 60_000,
        }),
      ),
    ];

    expect(computeAgents(input({ agents, runs })).dominance).toBeNull();
  });

  it('三项全赢时给出建议', () => {
    const agents = [
      { id: 'a1', name: 'agent-1', type: 'coder', model: null },
      { id: 'a2', name: 'agent-2', type: 'coder', model: null },
    ];
    const runs = [
      ...Array.from({ length: 5 }, (_, n) =>
        run(`x${n}`, {
          agentId: 'a1',
          cost: 5,
          status: n < 3 ? 'completed' : 'failed',
          endedAt: T0 + D + 20 * 60_000,
        }),
      ),
      ...Array.from({ length: 5 }, (_, n) =>
        run(`y${n}`, { agentId: 'a2', cost: 1, status: 'completed', endedAt: T0 + D + 5 * 60_000 }),
      ),
    ];

    expect(computeAgents(input({ agents, runs })).dominance).toMatchObject({
      betterName: 'agent-2',
      worseName: 'agent-1',
    });
  });
});

describe('成本异常', () => {
  /**
   * ★ 阈值必须跟着样本走。写死一个美元数，在便宜的项目里永远不触发、
   *   在昂贵的项目里天天报警 —— 两种情况下这个功能都等于不存在。
   */
  it('★ 阈值是中位数的倍数，不是写死的金额', () => {
    const runs = [
      ...Array.from({ length: 6 }, (_, n) => run(`n${n}`, { cost: 0.1 })),
      run('spike', { cost: 1.2 }),
    ];
    const i = input({
      runs,
      items: [
        {
          id: 'item-spike',
          title: '大改造',
          type: 'task',
          status: 'done',
          riskLevel: 'low',
          createdAt: T0,
          actualStart: null,
          actualEnd: null,
          plannedEnd: null,
          actualCost: 1.2,
          blockedSince: null,
          ownerId: null,
          executorType: null,
          executorId: null,
        },
      ],
      agents: [{ id: 'agent-1', name: 'code-agent', type: 'coder', model: null }],
    });

    const anomalies = computeCost(i, NOW).anomalies;
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ runId: 'spike', title: '大改造', times: 12 });
  });

  it('样本太少时不报异常 —— 中位数还不稳', () => {
    const runs = [run('a', { cost: 0.1 }), run('b', { cost: 5 })];
    expect(computeCost(input({ runs }), NOW).anomalies).toHaveLength(0);
  });

  it('没有完成项时不给单位交付成本，而不是除以零', () => {
    expect(computeCost(input({ runs: [run('a')] }), NOW).perDelivered).toBeNull();
  });
});

// ── 系统发现 ──────────────────────────────────────────────────────────────

function flowStub(o: Partial<FlowMetrics> = {}): FlowMetrics {
  const zero = { median: 0, mean: 0, count: 0, maxValue: 0, maxItemId: null };
  return {
    leadTime: zero,
    cycleTime: zero,
    throughputPerWeek: 5,
    completed: 12,
    wipNow: 4,
    flowEfficiency: 0.6,
    activeHours: 60,
    waitingHours: 40,
    blockedHours: 0,
    decisionWaitHours: 10,
    reworkRate: 0.05,
    reworkedItems: 1,
    onTimeRate: null,
    breakdown: [],
    wipTrend: [],
    blockedTrend: [],
    ...o,
  };
}

const agentStub: AgentMetrics = { agents: [], failureReasons: [], dominance: null };
const hitlStub: HitlMetrics = {
  totalDecisions: 0,
  resolved: 0,
  resolutionTime: { median: 0, mean: 0, count: 0, maxValue: 0, maxItemId: null },
  overdue: 0,
  automationRate: null,
  autoPassed: 0,
  policyEvaluations: 0,
  overrides: 0,
  blockedByHumanHours: 0,
  byStage: [],
  responseBuckets: [],
  repeated: [],
  overrideReasons: [],
};
const costStub: CostMetrics = {
  total: 10,
  perDelivered: 1,
  delivered: 10,
  trend: [],
  byAgent: [],
  byType: [],
  anomalies: [],
  budget: null,
  budgetSpent: 0,
  budgetRunwayDays: null,
};

const base = { agent: agentStub, hitl: hitlStub, cost: costStub, previous: null, rangeLabel: '近 30 天' };

describe('系统发现', () => {
  /**
   * ★ 页面文档 §5.1：「只说有问题不说怎么办」的提示，用户看两次就会
   *   忽略整个区域，然后这一页就退化成一堆好看的图。
   */
  it('★ 每条问题类发现都带可执行动作', () => {
    const insights = findInsights({
      ...base,
      flow: flowStub({ activeHours: 30, waitingHours: 70, decisionWaitHours: 60, reworkRate: 0.4, reworkedItems: 8 }),
    });

    const problems = insights.filter((i) => i.severity !== 'good');
    expect(problems.length).toBeGreaterThan(0);
    for (const p of problems) expect(p.actions.length).toBeGreaterThan(0);
  });

  /**
   * ★ 只报坏消息的分析页会被用户回避 —— 一个没人看的分析页比没有更糟，
   *   因为它让人以为这件事已经有人在管了。
   */
  it('★ 一定给得出正面发现', () => {
    const insights = findInsights({ ...base, flow: flowStub() });
    expect(insights.some((i) => i.severity === 'good')).toBe(true);
  });

  it('判据本身写进 evidence，让用户能反驳而不是只能相信', () => {
    const insights = findInsights({
      ...base,
      flow: flowStub({ activeHours: 30, waitingHours: 70, decisionWaitHours: 60 }),
    });

    const bottleneck = insights.find((i) => i.type === 'decision_bottleneck')!;
    expect(bottleneck.evidence).toContain('判据');
  });

  it('决策等待超阈值时，优先给出「把这类决策规则化」的动作', () => {
    const insights = findInsights({
      ...base,
      flow: flowStub({ activeHours: 30, waitingHours: 70, decisionWaitHours: 60 }),
      hitl: {
        ...hitlStub,
        repeated: [
          {
            type: 'db_change',
            label: '数据库变更审批',
            count: 6,
            consistency: 1,
            approvedCount: 6,
            potential: 'high',
            avgWaitHours: 9,
          },
        ],
      },
    });

    const bottleneck = insights.find((i) => i.type === 'decision_bottleneck')!;
    expect(bottleneck.actions[0]).toMatchObject({ kind: 'create_policy' });
  });

  it('严重的排在前面', () => {
    const insights = findInsights({
      ...base,
      flow: flowStub({ activeHours: 10, waitingHours: 90, decisionWaitHours: 80, reworkRate: 0.3, reworkedItems: 5 }),
    });

    expect(insights[0]!.severity).toBe('critical');
    expect(insights.at(-1)!.severity).toBe('good');
  });

  it('WIP 判据是「进得比出得快」，稳定的高 WIP 不报', () => {
    const stable = findInsights({
      ...base,
      flow: flowStub({ wipTrend: [12, 12, 13, 12].map((v, n) => ({ day: `d${n}`, value: v })) }),
    });
    expect(stable.some((i) => i.type === 'wip_pileup')).toBe(false);

    const growing = findInsights({
      ...base,
      flow: flowStub({ wipTrend: [4, 6, 9, 12].map((v, n) => ({ day: `d${n}`, value: v })) }),
    });
    expect(growing.some((i) => i.type === 'wip_pileup')).toBe(true);
  });
});
