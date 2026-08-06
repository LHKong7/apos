import type { Stat } from './types';

const EMPTY: Stat = { median: 0, mean: 0, count: 0, maxValue: 0, maxItemId: null };

/**
 * 中位数 + 均值 + 最大值来源。
 *
 * ★ 三个一起给不是啰嗦。一个跑了三天的任务能把 12 个任务的平均前置时间
 *   抬高一倍，只报均值就是在误导；而只报中位数又会把那个真正出问题的
 *   任务藏起来。所以：中位数看常态，均值看有没有被拖尾，
 *   maxItemId 让用户能点进去看那个尾巴是谁（页面文档 §11）。
 */
export function stat(samples: { value: number; itemId: string }[]): Stat {
  if (samples.length === 0) return EMPTY;

  const values = samples.map((s) => s.value).sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  const median =
    values.length % 2 === 0 ? (values[mid - 1]! + values[mid]!) / 2 : values[mid]!;

  let max = samples[0]!;
  for (const s of samples) if (s.value > max.value) max = s;

  return {
    median: round(median),
    mean: round(values.reduce((a, b) => a + b, 0) / values.length),
    count: values.length,
    maxValue: round(max.value),
    maxItemId: max.itemId,
  };
}

export function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function ratio(part: number, whole: number): number | null {
  return whole > 0 ? round(part / whole, 3) : null;
}

export function percent(part: number, whole: number): number {
  return whole > 0 ? round((part / whole) * 100, 1) : 0;
}

export const HOUR = 3_600_000;
