import { HOUR, percent, ratio, round, stat } from './stats';
import {
  bucketOf,
  buildSegments,
  dayKey,
  daysIn,
  isActive,
  isTerminal,
  overlapMs,
  statusAt,
  type Segment,
} from './timeline';
import {
  TIME_BUCKETS,
  type AnalyticsInput,
  type BucketShare,
  type FlowMetrics,
  type Point,
  type TimeBucket,
  type Window,
} from './types';

/**
 * Flow 指标（页面文档 12 §5.2 / 产品文档 8.13.1）。
 *
 * 两类指标的窗口语义不同，别混：
 * - **完成类**（前置时间、周期时间、吞吐、按时交付）按 `actualEnd` 落在窗口内筛选，
 *   算的是「这段时间交付了什么」；
 * - **耗时类**（周期分解、阻塞、决策等待）把每段时间线裁剪到窗口内，
 *   算的是「这段时间花在了哪」。
 *
 * 混用会得到很奇怪的数字：一个跨了两个窗口的任务，
 * 要么两个窗口都把它的全部耗时算一遍，要么两边都不算。
 */
export function computeFlow(input: AnalyticsInput, now: number): FlowMetrics {
  const { window, items, changes } = input;
  const createdAt = new Map(items.map((i) => [i.id, i.createdAt]));
  const segments = buildSegments(changes, createdAt);

  // ── 完成类 ──
  const done = items.filter(
    (i) => i.actualEnd !== null && i.actualEnd >= window.from && i.actualEnd <= window.to,
  );

  const leadTime = stat(
    done.map((i) => ({ value: (i.actualEnd! - i.createdAt) / HOUR, itemId: i.id })),
  );
  const cycleTime = stat(
    done
      .filter((i) => i.actualStart !== null)
      .map((i) => ({ value: (i.actualEnd! - i.actualStart!) / HOUR, itemId: i.id })),
  );

  const windowDays = Math.max(1, (window.to - window.from) / 86_400_000);
  const throughputPerWeek = round((done.length / windowDays) * 7);

  // ── 耗时类 ──
  const hoursByBucket = new Map<TimeBucket, number>();
  let activeHours = 0;
  let waitingHours = 0;

  for (const list of segments.values()) {
    for (const s of list) {
      const ms = overlapMs(s, window, now);
      if (ms === 0) continue;
      const hours = ms / HOUR;

      const bucket = bucketOf(s.status);
      if (!bucket) continue;
      hoursByBucket.set(bucket, (hoursByBucket.get(bucket) ?? 0) + hours);
      if (isActive(s.status)) activeHours += hours;
      else waitingHours += hours;
    }
  }

  const blockedHours = blockedMs(items, segments, window, now) / HOUR;

  const totalTracked = activeHours + waitingHours;
  const breakdown: BucketShare[] = TIME_BUCKETS.map((bucket) => {
    const hours = round(hoursByBucket.get(bucket) ?? 0);
    return {
      bucket,
      hours,
      percent: percent(hours, totalTracked),
      // decision_wait 一定是等待；其余桶里既有活也有等，按桶的主体性质归类
      kind: bucket === 'decision_wait' ? 'waiting' : ('active' as const),
    };
  });
  // 分解图的两类着色只用于「哪些是纯等待」，execution 桶里的 ready/blocked
  // 已经计入 waitingHours，所以底部那句总结用的是 activeHours/waitingHours，
  // 而不是把 breakdown 按 kind 求和 —— 两者口径不同，不能互相替代。

  const decisionWaitHours = round(hoursByBucket.get('decision_wait') ?? 0);

  // ── 返工 ──
  // 进过 changes_requested 或 failed 就算返工过一次
  const reworked = new Set<string>();
  for (const c of changes) {
    if (c.at < window.from || c.at > window.to) continue;
    if (c.to === 'changes_requested' || c.to === 'failed') reworked.add(c.itemId);
  }
  const touched = new Set(
    changes.filter((c) => c.at >= window.from && c.at <= window.to).map((c) => c.itemId),
  );

  // ── 按时交付 ──
  // ★ 没有排期字段时返回 null，页面显示「未接入」。
  //   这里返回 0 会让人以为「一个都没按时」，是个会误导决策的谎。
  const withPlan = done.filter((i) => i.plannedEnd !== null);
  const onTimeRate =
    withPlan.length > 0
      ? ratio(withPlan.filter((i) => i.actualEnd! <= i.plannedEnd!).length, withPlan.length)
      : null;

  return {
    leadTime,
    cycleTime,
    throughputPerWeek,
    completed: done.length,
    wipNow: items.filter((i) => !isTerminal(i.status) && i.status !== 'draft').length,
    flowEfficiency: ratio(activeHours, totalTracked),
    activeHours: round(activeHours),
    waitingHours: round(waitingHours),
    blockedHours: round(blockedHours),
    decisionWaitHours,
    reworkRate: ratio(reworked.size, touched.size),
    reworkedItems: reworked.size,
    onTimeRate,
    breakdown,
    wipTrend: wipTrend(input, segments, now),
    blockedTrend: blockedTrend(input, segments, now),
  };
}

/**
 * 每天结束时的在制品数量。
 *
 * 口径：已离开 draft 且未终结。稳定优于高 —— 持续攀升说明进得比出得快，
 * 这是「某阶段堆积」发现的判据来源。
 */
function wipTrend(input: AnalyticsInput, segments: Map<string, Segment[]>, now: number): Point[] {
  const DAY = 86_400_000;
  return daysIn(input.window).map((day) => {
    const at = Math.min(Date.parse(`${day}T00:00:00Z`) + DAY - 1, now);
    let count = 0;
    for (const list of segments.values()) {
      const status = statusAt(list, at, now);
      if (status && status !== 'draft' && !isTerminal(status)) count++;
    }
    return { day, value: count };
  });
}

/**
 * 阻塞时长。
 *
 * ★ 「被阻塞」在这个产品里有两种表达，两种都得算：
 *   - `blocked` **状态**：状态机把它停在这儿了；
 *   - `blockedSince` **标记**：卡片还在 ready，但挂着「在等外部依赖」。
 *
 *   只认状态的话，Analytics 会说「阻塞 0h」而看板同时显示「⛔ 1 项阻塞」。
 *   同一个词在两个页面上指两件事，用户不知道该信哪个 —— 那比少一个指标糟得多。
 *   同一段时间被两边同时命中时只算一次。
 */
function blockedMs(
  items: AnalyticsInput['items'],
  segments: Map<string, Segment[]>,
  window: Window,
  now: number,
): number {
  const markers = new Map(
    items.filter((i) => i.blockedSince !== null).map((i) => [i.id, i.blockedSince!]),
  );

  let total = 0;
  for (const [itemId, list] of segments) {
    const marked = markers.get(itemId);
    const spans: { from: number; to: number }[] = [];

    for (const s of list) {
      if (s.status !== 'blocked') continue;
      const from = Math.max(s.from, window.from);
      const to = Math.min(s.to ?? now, window.to);
      if (to > from) spans.push({ from, to });
    }
    if (marked !== undefined) {
      const from = Math.max(marked, window.from);
      const to = Math.min(now, window.to);
      if (to > from) spans.push({ from, to });
    }

    total += mergedLength(spans);
  }

  // 没有任何状态变更、但挂着阻塞标记的任务也要算
  for (const [itemId, since] of markers) {
    if (segments.has(itemId)) continue;
    const from = Math.max(since, window.from);
    const to = Math.min(now, window.to);
    if (to > from) total += to - from;
  }

  return total;
}

/** 合并重叠区间后的总长度 —— 同一段时间不重复计费 */
function mergedLength(spans: { from: number; to: number }[]): number {
  if (spans.length === 0) return 0;
  const sorted = [...spans].sort((a, b) => a.from - b.from);
  let total = 0;
  let { from, to } = sorted[0]!;
  for (const s of sorted.slice(1)) {
    if (s.from <= to) to = Math.max(to, s.to);
    else {
      total += to - from;
      ({ from, to } = s);
    }
  }
  return total + (to - from);
}

/** 每天的阻塞小时数。峰值指向那一天发生了什么。 */
function blockedTrend(
  input: AnalyticsInput,
  segments: Map<string, Segment[]>,
  now: number,
): Point[] {
  const DAY = 86_400_000;
  return daysIn(input.window).map((day) => {
    const from = Date.parse(`${day}T00:00:00Z`);
    const to = Math.min(from + DAY, input.window.to);
    return { day, value: round(blockedMs(input.items, segments, { from, to }, now) / HOUR) };
  });
}

export { dayKey };
