import { describe, expect, it } from 'vitest';
import { computeHealth, predictDelay } from './health';
import type { FlowMetrics, HitlMetrics } from './types';

const zero = { median: 0, mean: 0, count: 0, maxValue: 0, maxItemId: null };

function flow(o: Partial<FlowMetrics> = {}): FlowMetrics {
  return {
    leadTime: zero,
    cycleTime: { ...zero, median: 8, count: 10 },
    throughputPerWeek: 5,
    completed: 10,
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

const hitl: HitlMetrics = {
  totalDecisions: 0,
  resolved: 0,
  resolutionTime: zero,
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

const healthy = {
  flow: flow(),
  hitl,
  agentSuccessRate: 0.95,
  totalTasks: 20,
  doneTasks: 10,
  blockedTasks: 0,
  overdueDecisions: 0,
  tokensSpent: 100,
  tokenBudget: 1000,
};

describe('健康度', () => {
  it('一切正常时接近满分', () => {
    const h = computeHealth(healthy);
    expect(h.score).toBeGreaterThanOrEqual(90);
    expect(h.level).toBe('good');
  });

  /**
   * ★ 用户看到「健康度 62」的第一反应是「凭什么」。
   *   答不上来他就不会据此做任何事，这张卡片也就只是装饰。
   *   所以扣的每一分都必须能追到具体一项。
   */
  it('★ 每一分扣在哪都说得出来，且加起来等于总分', () => {
    const h = computeHealth({
      ...healthy,
      blockedTasks: 2,
      overdueDecisions: 1,
      flow: flow({ flowEfficiency: 0.3, reworkRate: 0.3, reworkedItems: 6 }),
    });

    expect(h.contributions.length).toBeGreaterThan(0);
    for (const c of h.contributions) {
      expect(c.detail).toBeTruthy();
      expect(c.delta).toBeLessThan(0);
    }
    // 扣分之和 = 100 - 总分，用户能自己对上账
    const sum = h.contributions.reduce((s, c) => s + c.delta, 0);
    expect(h.score).toBe(100 + sum);
  });

  it('扣得最狠的排在最前面', () => {
    const h = computeHealth({ ...healthy, blockedTasks: 3, overdueDecisions: 2 });
    const deltas = h.contributions.map((c) => c.delta);
    expect(deltas).toEqual([...deltas].sort((a, b) => a - b));
  });

  /**
   * ★ 「token 用得多」本身不是问题，「用得比活干得快」才是。
   *   按绝对消耗扣分，会把一个进度也很快的项目判成不健康。
   */
  it('★ 预算按「消耗 vs 进度」判，不按绝对消耗', () => {
    const fast = computeHealth({ ...healthy, tokensSpent: 800, doneTasks: 18, totalTasks: 20 });
    expect(fast.contributions.some((c) => c.key === 'budget_pace')).toBe(false);

    const wasteful = computeHealth({ ...healthy, tokensSpent: 800, doneTasks: 2, totalTasks: 20 });
    expect(wasteful.contributions.some((c) => c.key === 'budget_pace')).toBe(true);
  });

  it('分数不会跌破 0', () => {
    const h = computeHealth({
      ...healthy,
      blockedTasks: 20,
      overdueDecisions: 20,
      agentSuccessRate: 0.1,
      tokensSpent: 1000,
      doneTasks: 0,
      flow: flow({ flowEfficiency: 0, reworkRate: 0.9, reworkedItems: 18 }),
    });
    expect(h.score).toBe(0);
  });
});

describe('延期预测', () => {
  const base = {
    flow: flow(),
    agentSuccessRate: 0.95,
    remainingTasks: 10,
    blockedTasks: 0,
    overdueDecisions: 0,
    plannedEnd: null,
    now: Date.UTC(2026, 0, 1),
  };

  /**
   * ★ 页面文档 §5.2：「用户必须能看懂预测是怎么来的，否则不会信任它」。
   *   一个说不清来源的预测比没有预测更糟 —— 它会被当成事实引用。
   */
  it('★ 每一项风险来源都写清楚它把概率推高了多少', () => {
    const r = predictDelay({ ...base, blockedTasks: 2, overdueDecisions: 1 });

    expect(r.contributions.length).toBeGreaterThan(0);
    for (const c of r.contributions) {
      expect(c.detail).toBeTruthy();
      expect(c.delta).toBeGreaterThanOrEqual(0);
    }
    expect(r.contributions.some((c) => c.key === 'blocked')).toBe(true);
    expect(r.contributions.some((c) => c.key === 'decisions')).toBe(true);
  });

  it('一切正常时风险低', () => {
    expect(predictDelay(base).level).toBe('low');
  });

  it('阻塞加超时决策把风险推到高', () => {
    const r = predictDelay({
      ...base,
      blockedTasks: 4,
      overdueDecisions: 3,
      flow: flow({ flowEfficiency: 0.2, reworkRate: 0.4, reworkedItems: 8 }),
    });
    expect(r.level).toBe('high');
    expect(r.probability).toBeLessThanOrEqual(0.95);
  });

  /**
   * ★ 没有吞吐数据时不能硬编一个速率去算天数 ——
   *   那个数字看起来同样精确，但它是凭空来的。
   */
  it('★ 算不出速率时如实说算不出，不给假的天数', () => {
    const r = predictDelay({
      ...base,
      remainingTasks: 10,
      flow: flow({ throughputPerWeek: 0, completed: 0 }),
      plannedEnd: base.now + 7 * 86_400_000,
    });

    expect(r.estimatedSlipDays).toBeNull();
    expect(r.contributions.find((c) => c.key === 'workload')?.detail).toContain('算不出速率');
  });

  it('有排期且做不完时给出预计晚几天', () => {
    const r = predictDelay({
      ...base,
      remainingTasks: 20,
      flow: flow({ throughputPerWeek: 5 }),
      // 只剩 7 天，但按 5 项/周做完 20 项要 4 周
      plannedEnd: base.now + 7 * 86_400_000,
    });

    expect(r.estimatedSlipDays).toBeGreaterThan(0);
    expect(r.contributions.some((c) => c.key === 'workload')).toBe(true);
  });

  it('没有排期时不给天数，但仍给风险等级', () => {
    const r = predictDelay({ ...base, blockedTasks: 3, plannedEnd: null });
    expect(r.estimatedSlipDays).toBeNull();
    expect(r.level).not.toBe('low');
  });
});
