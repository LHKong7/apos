import { describe, expect, it } from 'vitest';
import { bucketOf, buildSegments, isActive, overlapMs, statusAt } from './timeline';
import type { StatusChange } from './types';

const T0 = Date.UTC(2026, 0, 1);
const H = 3_600_000;

function change(itemId: string, from: string | null, to: string, hoursIn: number): StatusChange {
  return { itemId, from: from as never, to: to as never, at: T0 + hoursIn * H };
}

describe('时间去向分类', () => {
  /**
   * ★ 这是页面文档 12 §5.3 的关键设计，也是整个 Analytics 最容易被做错的地方。
   *   把「等待决策」并进它所处的阶段，用户看到的就是「评审阶段 1.6 天」——
   *   完全正确，也完全没用：他不知道这 1.6 天里有 1.1 天是在等自己批准。
   */
  it('★ 三种 awaiting_* 都归到独立的「等待决策」，不并入所处阶段', () => {
    expect(bucketOf('awaiting_requirement_approval')).toBe('decision_wait');
    expect(bucketOf('awaiting_plan_approval')).toBe('decision_wait');
    expect(bucketOf('awaiting_decision')).toBe('decision_wait');
  });

  it('其余状态按阶段归类', () => {
    expect(bucketOf('executing')).toBe('execution');
    expect(bucketOf('ready')).toBe('execution');
    expect(bucketOf('reviewing')).toBe('review');
    expect(bucketOf('releasing')).toBe('release');
  });

  it('终态不消耗时间', () => {
    expect(bucketOf('done')).toBeNull();
    expect(bucketOf('cancelled')).toBeNull();
  });

  it('acceptance 归在发布桶 —— 它是交付收尾，不是独立阶段', () => {
    expect(bucketOf('acceptance')).toBe('release');
  });

  /**
   * ★ 「有效工作」的口径决定了 Flow Efficiency 这个数字是否可信。
   *   判据只有一条：这一刻有没有人或 Agent 正在推进它。
   */
  it('★ 排队、阻塞、等批准都不算有效工作', () => {
    expect(isActive('executing')).toBe(true);
    expect(isActive('reviewing')).toBe(true);

    expect(isActive('ready')).toBe(false); // 排在队里，没人动它
    expect(isActive('blocked')).toBe(false);
    expect(isActive('failed')).toBe(false);
    expect(isActive('changes_requested')).toBe(false); // 等人捡起来返工
    expect(isActive('awaiting_decision')).toBe(false);
  });
});

describe('时间线重建', () => {
  it('补上创建到第一次变更之间的那一段', () => {
    const segs = buildSegments(
      [change('a', 'draft', 'ready', 5)],
      new Map([['a', T0]]),
    ).get('a')!;

    expect(segs[0]).toEqual({ itemId: 'a', status: 'draft', from: T0, to: T0 + 5 * H });
    expect(segs[1]).toEqual({ itemId: 'a', status: 'ready', from: T0 + 5 * H, to: null });
  });

  it('最后一段保持开放 —— 任务还在这个状态里继续累计', () => {
    const segs = buildSegments([change('a', null, 'executing', 0)], new Map()).get('a')!;
    expect(segs[segs.length - 1]!.to).toBeNull();
  });

  it('乱序事件也能重建出正确顺序', () => {
    const segs = buildSegments(
      [change('a', 'ready', 'executing', 3), change('a', 'draft', 'ready', 1)],
      new Map(),
    ).get('a')!;

    expect(segs.map((s) => s.status)).toEqual(['ready', 'executing']);
  });
});

describe('窗口裁剪', () => {
  /**
   * ★ 一个跨越窗口边界的段，只能算落在窗口内的那部分。
   *   算全部 → 两个相邻周期各把它算一遍，环比全是假的；
   *   算 0 → 一个连续阻塞两周的任务在任何周期都不出现。
   */
  it('★ 跨窗口的段只计入窗口内的那一部分', () => {
    const segment = { itemId: 'a', status: 'blocked' as const, from: T0, to: T0 + 10 * H };
    const window = { from: T0 + 4 * H, to: T0 + 6 * H };

    expect(overlapMs(segment, window, T0 + 100 * H)).toBe(2 * H);
  });

  it('开放段按当前时间截断', () => {
    const segment = { itemId: 'a', status: 'blocked' as const, from: T0, to: null };
    const now = T0 + 3 * H;

    expect(overlapMs(segment, { from: T0, to: T0 + 100 * H }, now)).toBe(3 * H);
  });

  it('完全在窗口外的段不计入', () => {
    const segment = { itemId: 'a', status: 'blocked' as const, from: T0, to: T0 + H };
    expect(overlapMs(segment, { from: T0 + 5 * H, to: T0 + 9 * H }, T0)).toBe(0);
  });
});

describe('瞬时状态', () => {
  it('给出某一刻任务处在哪个状态', () => {
    const segs = buildSegments(
      [change('a', 'draft', 'ready', 2), change('a', 'ready', 'executing', 5)],
      new Map([['a', T0]]),
    ).get('a')!;

    expect(statusAt(segs, T0 + H, T0 + 99 * H)).toBe('draft');
    expect(statusAt(segs, T0 + 3 * H, T0 + 99 * H)).toBe('ready');
    expect(statusAt(segs, T0 + 8 * H, T0 + 99 * H)).toBe('executing');
  });

  it('任务出生前不存在', () => {
    const segs = buildSegments([change('a', null, 'ready', 5)], new Map()).get('a')!;
    expect(statusAt(segs, T0, T0 + 99 * H)).toBeNull();
  });
});
