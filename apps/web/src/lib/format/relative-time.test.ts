import { afterEach, describe, expect, it, vi } from 'vitest';
import { absoluteTime, relativeTime } from './index';
import { useLocaleStore } from '../i18n';

/**
 * 相对时间的分辨率。
 *
 * ★★ 总览页那条「最近活动」上曾经十二条全是「刚刚」—— 十二条事件显然不在
 *   同一秒发生，但界面上分不出先后，也看不出频次（问题记录 #1）。
 *   这一列的用途恰恰是「刚才发生了什么、按什么顺序」，分辨率一丢，
 *   它就只剩「有事发生过」这一点信息。
 */

const NOW = new Date('2026-08-18T12:00:00Z').getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

afterEach(() => {
  vi.useRealTimers();
  useLocaleStore.setState({ locale: 'en' });
});

function at(now: number) {
  vi.useFakeTimers();
  vi.setSystemTime(now);
}

describe('relativeTime', () => {
  it('★ 一分钟以内给秒级刻度，而不是一律「刚刚」', () => {
    at(NOW);
    expect(relativeTime(ago(12_000))).toBe('12s ago');
    expect(relativeTime(ago(45_000))).toBe('45s ago');
  });

  /**
   * ★ 门槛设在 5 秒：更细的刻度会让同一批事件在两次渲染之间跳动
   *   （「3 秒前」→「7 秒前」），而那种抖动本身就是噪声。
   */
  it('★ 5 秒以内才说「刚刚」', () => {
    at(NOW);
    expect(relativeTime(ago(1_000))).toBe('just now');
    expect(relativeTime(ago(4_999))).toBe('just now');
    expect(relativeTime(ago(5_000))).not.toBe('just now');
  });

  it('超过一分钟回到分钟／小时刻度', () => {
    at(NOW);
    expect(relativeTime(ago(90_000))).toBe('2m ago');
    expect(relativeTime(ago(3 * 3600_000))).toBe('3h ago');
  });

  /**
   * ★ 时钟偏移下服务端时间比浏览器快几秒是常态，而「-3 秒前」看起来像 bug。
   */
  it('★ 未来时间说「刚刚」，不印负数', () => {
    at(NOW);
    expect(relativeTime(new Date(NOW + 3_000).toISOString())).toBe('just now');
  });

  it('空值与坏值都给破折号，不抛也不印 Invalid Date', () => {
    at(NOW);
    expect(relativeTime(null)).toBe('—');
    expect(relativeTime(undefined)).toBe('—');
    expect(relativeTime('not a date')).toBe('—');
  });
});

describe('absoluteTime', () => {
  /** ★ 相对时间答「多久以前」，绝对时间答「几点」—— 排查问题时要的是后者 */
  it('给得出一个可读的时间戳', () => {
    expect(absoluteTime(ago(0))).not.toBe('');
    expect(absoluteTime(ago(0))).toContain('2026');
  });

  it('坏值给空串，让调用方的 title 直接不出现', () => {
    expect(absoluteTime(null)).toBe('');
    expect(absoluteTime('nope')).toBe('');
  });
});
