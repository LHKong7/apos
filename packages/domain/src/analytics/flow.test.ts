import { describe, expect, it } from 'vitest';
import { computeFlow } from './flow';
import type { AnalyticsInput, ItemRow, StatusChange } from './types';

const T0 = Date.UTC(2026, 0, 1);
const H = 3_600_000;
const D = 24 * H;
const NOW = T0 + 30 * D;

function item(id: string, o: Partial<ItemRow> = {}): ItemRow {
  return {
    id,
    title: id,
    type: 'task',
    status: 'done',
    riskLevel: 'low',
    createdAt: T0,
    actualStart: null,
    actualEnd: null,
    plannedEnd: null,
    actualTokens: 0,
    blockedSince: null,
    ownerId: null,
    executorType: null,
    executorId: null,
    ...o,
  };
}

function change(itemId: string, to: string, at: number, from: string | null = null): StatusChange {
  return { itemId, from: from as never, to: to as never, at };
}

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
    tokenBudget: null,
    tokensSpentTotal: 0,
    ...o,
  };
}

describe('完成类指标', () => {
  it('前置时间从创建算到完成，周期时间从开始执行算起', () => {
    const flow = computeFlow(
      input({
        items: [item('a', { createdAt: T0, actualStart: T0 + 10 * H, actualEnd: T0 + 20 * H })],
      }),
      NOW,
    );

    expect(flow.leadTime.median).toBe(20);
    expect(flow.cycleTime.median).toBe(10);
  });

  /**
   * ★ 页面文档 §11：「单个异常值扭曲平均值 → 同时显示中位数」。
   *   四个 2 小时的任务加一个 100 小时的，均值 21.6h 会让人以为
   *   「我们平均要花一天」，而真实的常态是 2 小时。
   */
  it('★ 中位数与均值一起给，并指出那个异常值是谁', () => {
    const items = [1, 2, 3, 4].map((n) =>
      item(`fast-${n}`, { actualEnd: T0 + 2 * H, actualStart: T0 }),
    );
    items.push(item('slow', { actualEnd: T0 + 100 * H, actualStart: T0 }));

    const flow = computeFlow(input({ items }), NOW);

    expect(flow.leadTime.median).toBe(2);
    expect(flow.leadTime.mean).toBeGreaterThan(20);
    expect(flow.leadTime.maxItemId).toBe('slow');
  });

  it('只统计窗口内完成的任务', () => {
    const flow = computeFlow(
      input({
        window: { from: T0 + 10 * D, to: NOW },
        items: [
          item('old', { actualEnd: T0 + 2 * D, actualStart: T0 }),
          item('new', { actualEnd: T0 + 15 * D, actualStart: T0 + 14 * D }),
        ],
      }),
      NOW,
    );

    expect(flow.completed).toBe(1);
    expect(flow.leadTime.count).toBe(1);
  });
});

describe('流动效率', () => {
  /**
   * ★ 本产品最重要的指标（页面文档 §5.2）。
   *   Agent 干得再快，56% 的时间在等人批准，产品价值就没兑现。
   */
  it('★ 有效工作 / 总时长；排队与等批准都算等待', () => {
    const flow = computeFlow(
      input({
        items: [item('a', { createdAt: T0, status: 'done' })],
        changes: [
          change('a', 'executing', T0), // 有效 2h
          change('a', 'awaiting_decision', T0 + 2 * H), // 等待 6h
          change('a', 'executing', T0 + 8 * H), // 有效 2h
          change('a', 'done', T0 + 10 * H),
        ],
      }),
      NOW,
    );

    expect(flow.activeHours).toBe(4);
    expect(flow.waitingHours).toBe(6);
    expect(flow.flowEfficiency).toBe(0.4);
    expect(flow.decisionWaitHours).toBe(6);
  });

  it('等待决策在周期分解里是独立一条，且标记为等待', () => {
    const flow = computeFlow(
      input({
        items: [item('a')],
        changes: [
          change('a', 'reviewing', T0),
          change('a', 'awaiting_decision', T0 + H),
          change('a', 'done', T0 + 5 * H),
        ],
      }),
      NOW,
    );

    const wait = flow.breakdown.find((b) => b.bucket === 'decision_wait')!;
    expect(wait.hours).toBe(4);
    expect(wait.kind).toBe('waiting');
    // 没有被算进 review 桶
    expect(flow.breakdown.find((b) => b.bucket === 'review')!.hours).toBe(1);
  });

  it('没有任何时间线时不给效率数字，而不是给 0', () => {
    expect(computeFlow(input(), NOW).flowEfficiency).toBeNull();
  });
});

describe('按时交付率', () => {
  /**
   * ★ 页面文档 §7：数据源不可用时显示「未接入」，不显示 0。
   *   0% 按时交付会让人立刻去追责，而真相只是「计划里根本没排期」。
   */
  it('★ 没有排期字段时返回 null（页面显示「未接入」），不是 0', () => {
    const flow = computeFlow(
      input({ items: [item('a', { actualEnd: T0 + D, plannedEnd: null })] }),
      NOW,
    );
    expect(flow.onTimeRate).toBeNull();
  });

  it('有排期时正常计算', () => {
    const flow = computeFlow(
      input({
        items: [
          item('early', { actualEnd: T0 + D, plannedEnd: T0 + 2 * D }),
          item('late', { actualEnd: T0 + 3 * D, plannedEnd: T0 + 2 * D }),
        ],
      }),
      NOW,
    );
    expect(flow.onTimeRate).toBe(0.5);
  });
});

describe('返工率', () => {
  it('进过 changes_requested 或 failed 就算返工过', () => {
    const flow = computeFlow(
      input({
        items: [item('a'), item('b'), item('c')],
        changes: [
          change('a', 'changes_requested', T0 + H),
          change('b', 'failed', T0 + H),
          change('c', 'done', T0 + H),
        ],
      }),
      NOW,
    );

    expect(flow.reworkedItems).toBe(2);
    expect(flow.reworkRate).toBeCloseTo(0.667, 2);
  });

  it('同一个任务返工两次只算一个', () => {
    const flow = computeFlow(
      input({
        items: [item('a')],
        changes: [
          change('a', 'changes_requested', T0 + H),
          change('a', 'reviewing', T0 + 2 * H),
          change('a', 'changes_requested', T0 + 3 * H),
        ],
      }),
      NOW,
    );
    expect(flow.reworkedItems).toBe(1);
  });
});

describe('趋势', () => {
  it('在制品趋势按天给出，草稿与终态不算在制', () => {
    const flow = computeFlow(
      input({
        window: { from: T0, to: T0 + 3 * D },
        items: [item('a', { createdAt: T0 })],
        changes: [
          change('a', 'ready', T0, 'draft'),
          change('a', 'done', T0 + 2 * D),
        ],
      }),
      T0 + 3 * D,
    );

    expect(flow.wipTrend).toHaveLength(4);
    expect(flow.wipTrend[0]!.value).toBe(1);
    expect(flow.wipTrend[3]!.value).toBe(0);
  });

  it('阻塞趋势把每天的阻塞小时数分开算', () => {
    const flow = computeFlow(
      input({
        window: { from: T0, to: T0 + 2 * D },
        items: [item('a')],
        // 从第 1 天 20:00 阻塞到第 2 天 04:00 —— 跨天，4h + 4h
        changes: [
          change('a', 'blocked', T0 + 20 * H),
          change('a', 'ready', T0 + 28 * H),
        ],
      }),
      T0 + 2 * D,
    );

    expect(flow.blockedHours).toBe(8);
    expect(flow.blockedTrend[0]!.value).toBe(4);
    expect(flow.blockedTrend[1]!.value).toBe(4);
  });
});

describe('阻塞时长的两个来源', () => {
  /**
   * ★ 「被阻塞」在这个产品里有两种表达：blocked 状态，和 blockedSince 标记
   *   （卡片还在 ready，但挂着「在等外部依赖」）。看板按标记显示「⛔ N 项阻塞」。
   *   只认状态的话，Analytics 说 0h、看板说 1 项 —— 同一个词在两页指两件事，
   *   用户不知道该信谁，这比少一个指标糟糕得多。
   */
  it('★ 只挂了阻塞标记、状态不是 blocked 的任务也要计入', () => {
    const flow = computeFlow(
      input({
        window: { from: T0, to: T0 + 10 * H },
        items: [item('a', { status: 'ready', blockedSince: T0 + 4 * H })],
        changes: [change('a', 'ready', T0)],
      }),
      T0 + 10 * H,
    );

    expect(flow.blockedHours).toBe(6);
  });

  it('两个来源重叠的时间只算一次', () => {
    const flow = computeFlow(
      input({
        window: { from: T0, to: T0 + 10 * H },
        // 状态 blocked 从 2h 起；标记也是 2h 起，都持续到现在
        items: [item('a', { status: 'blocked', blockedSince: T0 + 2 * H })],
        changes: [change('a', 'blocked', T0 + 2 * H)],
      }),
      T0 + 10 * H,
    );

    expect(flow.blockedHours).toBe(8);
  });
});
