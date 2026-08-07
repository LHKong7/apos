import { describe, expect, it } from 'vitest';
import { computeQuality, findPostReleaseIncidents } from './quality';
import type { AnalyticsInput, ItemRow } from './types';

const DAY = 86_400_000;
const T0 = Date.parse('2026-08-01T00:00:00Z');

function item(over: Partial<ItemRow> = {}): ItemRow {
  return {
    id: `i-${Math.random().toString(36).slice(2, 8)}`,
    title: '任务',
    type: 'task',
    status: 'done',
    riskLevel: 'low',
    createdAt: T0,
    actualStart: T0,
    actualEnd: T0 + DAY,
    plannedEnd: null,
    actualCost: 0,
    blockedSince: null,
    ownerId: null,
    executorType: 'agent',
    executorId: 'a1',
    ...over,
  } as ItemRow;
}

function input(items: ItemRow[]): AnalyticsInput {
  return {
    window: { from: T0 - 30 * DAY, to: T0 + 30 * DAY },
    items,
    changes: [],
    runs: [],
    decisions: [],
    agents: [],
    overrides: [],
    policyEvals: [],
    budget: null,
    costSpentTotal: 0,
  } as unknown as AnalyticsInput;
}

const m = (q: ReturnType<typeof computeQuality>, key: string) => q.metrics.find((x) => x.key === key)!;

/**
 * 质量 Tab。
 *
 * 这一页曾经因为「CI 与事故系统都没接」整个不做。现在两样都有了，
 * 但每一项必须自报数据源与接入状态 —— 混着真数字和占位符却不说明
 * 哪个是哪个，比整个不做更糟。
 */
describe('没有数据源时如实说「未接入」', () => {
  /**
   * ★ 显示 0 会被读成「一个都没通过」或「质量完美」，
   *   而真相是「这个仓库根本没接 CI」。
   */
  it('★ 没有 CI 回流时值是 null 而不是 0', () => {
    const q = computeQuality(input([item(), item()]));
    expect(m(q, 'auto_test_pass_rate').value).toBeNull();
    expect(m(q, 'auto_test_pass_rate').wired).toBe(false);
    expect(m(q, 'auto_test_pass_rate').hint).toContain('连上代码仓库');
  });

  it('抓不到覆盖率时不画趋势线', () => {
    const q = computeQuality(input([item({ qualityGate: { testsPassed: true } })]));
    expect(q.coverageTrend).toEqual([]);
    expect(m(q, 'coverage').value).toBeNull();
  });

  /**
   * ★ 「0 起事故」和「这个周期没发过版」是完全不同的两件事。
   *   显示成 0 会让人以为质量很好。
   */
  it('★ 本周期没有发布时，事故数是 null 而不是 0', () => {
    const q = computeQuality(input([item(), item()]));
    expect(m(q, 'post_release_incidents').value).toBeNull();
    expect(m(q, 'post_release_incidents').hint).toContain('还没有完成的发布');
  });
});

describe('接上 CI 之后真的能算', () => {
  it('自动测试通过率按有结果的任务算', () => {
    const q = computeQuality(
      input([
        item({ qualityGate: { testsPassed: true } }),
        item({ qualityGate: { testsPassed: true } }),
        item({ qualityGate: { testsPassed: false } }),
        item(), // 没有 CI 结果的不参与
      ]),
    );
    const metric = m(q, 'auto_test_pass_rate');
    expect(metric.value).toBeCloseTo(0.667, 2);
    expect(metric.sample).toBe(3);
    expect(metric.wired).toBe(true);
  });

  it('CI 覆盖到多少任务也报出来 —— 只接了一部分要看得见', () => {
    const q = computeQuality(input([item({ qualityGate: { testsPassed: true } }), item(), item(), item()]));
    expect(q.ciCoverageOfItems).toBe(0.25);
  });

  /**
   * ★ 覆盖率是瞬时值。把一天里三次 CI 的覆盖率平均起来，
   *   得到的是一个从未真实存在过的数。
   */
  it('★ 同一天多次 CI 取最后一次，不取平均', () => {
    const q = computeQuality(
      input([
        item({ actualEnd: T0 + 3600_000, qualityGate: { coverage: 60 } }),
        item({ actualEnd: T0 + 7200_000, qualityGate: { coverage: 80 } }),
      ]),
    );
    expect(q.coverageTrend).toHaveLength(1);
    expect(q.coverageTrend[0]!.coverage).toBe(80);
  });

  it('覆盖率趋势按天升序', () => {
    const q = computeQuality(
      input([
        item({ actualEnd: T0 + 2 * DAY, qualityGate: { coverage: 75 } }),
        item({ actualEnd: T0, qualityGate: { coverage: 70 } }),
      ]),
    );
    expect(q.coverageTrend.map((x) => x.coverage)).toEqual([70, 75]);
  });
});

describe('发布后事故', () => {
  const release = (id: string, endAt: number) =>
    item({ id, type: 'release', status: 'done', actualEnd: endAt });
  const incident = (id: string, at: number) =>
    item({ id, type: 'incident', status: 'executing', createdAt: at, actualEnd: null });

  it('发布后 7 天内的事故被算进来，并记录隔了几天', () => {
    const found = findPostReleaseIncidents(
      [release('r1', T0), incident('inc1', T0 + 2 * DAY)],
      T0 - DAY,
      T0 + 10 * DAY,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: 'inc1', daysAfterRelease: 2, relatedReleaseId: 'r1' });
  });

  it('超过 7 天的不算发布引入', () => {
    const found = findPostReleaseIncidents(
      [release('r1', T0), incident('inc1', T0 + 9 * DAY)],
      T0 - DAY,
      T0 + 20 * DAY,
    );
    expect(found).toHaveLength(0);
  });

  /**
   * ★ 发布前就存在的问题不是这次发布引入的。
   *   算进去会让「刚上线就出事」这个信号彻底失真。
   */
  it('★ 发布之前创建的事故不算', () => {
    const found = findPostReleaseIncidents(
      [release('r1', T0 + 5 * DAY), incident('inc1', T0)],
      T0 - DAY,
      T0 + 20 * DAY,
    );
    expect(found).toHaveLength(0);
  });

  /**
   * ★ 归因到最近一次发布，不是全部。一周内发三次版、之后出一个事故，
   *   算成三次发布各有一个事故，会让「每次发布的事故数」凭空翻三倍。
   */
  it('★ 归因到最近一次发布', () => {
    const found = findPostReleaseIncidents(
      [
        release('r1', T0),
        release('r2', T0 + DAY),
        release('r3', T0 + 2 * DAY),
        incident('inc1', T0 + 3 * DAY),
      ],
      T0 - DAY,
      T0 + 20 * DAY,
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.relatedReleaseId).toBe('r3');
  });

  it('每次发布的事故数按发布次数摊', () => {
    const q = computeQuality(
      input([
        release('r1', T0),
        release('r2', T0 + 10 * DAY),
        incident('inc1', T0 + DAY),
      ]),
    );
    expect(m(q, 'incident_rate_per_release').value).toBe(0.5);
  });
});
