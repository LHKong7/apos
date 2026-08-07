import { dayKey, isTerminal } from './timeline';
import type { AnalyticsInput, ItemRow } from './types';

/**
 * 质量 Tab（页面文档 12 §5.x）。
 *
 * ★ 这一页曾经因为「CI 与事故系统都没接」而整个不做。
 *   现在 CI 有了（GitHub check-runs → typeData.qualityGate），
 *   事故也有了（work_items.type === 'incident'），所以它可以真的算了。
 *
 * ★ 但**每一项都必须自报数据源与接入状态**。
 *   一个混着真数字和占位符、却不说明哪个是哪个的页面，
 *   比整个不做更糟：用户会把占位符当成真的，
 *   然后据此判断「质量在变好」。
 *   所以每个指标都带 `wired` 与 `source`，没接的显式说没接、不给 0。
 */

export type MetricSource = 'ci' | 'work_items' | 'events';

export interface QualityMetric {
  key: string;
  label: string;
  /** null = 这项没有数据源，页面必须显示「未接入」而不是 0 */
  value: number | null;
  unit: 'percent' | 'count' | 'days';
  source: MetricSource;
  /** 数据源接没接上。false 时 value 一定是 null */
  wired: boolean;
  /** 没接上时告诉用户缺什么、怎么接 */
  hint: string;
  /** 参与计算的样本量 —— 3 个样本算出的 100% 说明不了任何事 */
  sample: number;
}

export interface QualityMetrics {
  metrics: QualityMetric[];
  /** 覆盖率随时间的变化；没有 CI 时为空数组而不是编造的线 */
  coverageTrend: { day: string; coverage: number }[];
  /** 发布后短期内出现的事故，逐条列出 —— 只给一个数字没法追查 */
  postReleaseIncidents: {
    id: string;
    title: string;
    createdAt: number;
    daysAfterRelease: number;
    relatedReleaseId: string | null;
  }[];
  /** 有 CI 结果的任务占比 —— 低于这个数说明 CI 只接了一部分 */
  ciCoverageOfItems: number | null;
}

/** 发布后多少天内出现的事故算「发布引入的」 */
const INCIDENT_WINDOW_DAYS = 7;

export function computeQuality(input: AnalyticsInput): QualityMetrics {
  const { window, items } = input;
  const inWindow = items.filter((i) => i.createdAt <= window.to && (i.actualEnd ?? i.createdAt) >= window.from);

  const withCi = inWindow.filter((i) => ci(i) !== null);
  const ciWired = withCi.length > 0;

  const testsRun = withCi.filter((i) => ci(i)!.testsPassed !== undefined);
  const testsPassed = testsRun.filter((i) => ci(i)!.testsPassed === true).length;

  const withCoverage = withCi.filter((i) => typeof ci(i)!.coverage === 'number');
  const coverageTrend = buildCoverageTrend(withCoverage);

  const incidents = findPostReleaseIncidents(items, window.from, window.to);
  const releases = inWindow.filter((i) => i.type === 'release' && isTerminal(i.status));

  const scanRun = withCi.filter((i) => ci(i)!.securityScanPassed !== undefined);
  const scanPassed = scanRun.filter((i) => ci(i)!.securityScanPassed === true).length;

  const metrics: QualityMetric[] = [
    {
      key: 'auto_test_pass_rate',
      label: '自动测试通过率',
      value: testsRun.length === 0 ? null : round(testsPassed / testsRun.length),
      unit: 'percent',
      source: 'ci',
      wired: testsRun.length > 0,
      hint: '需要在集成设置里连上代码仓库，CI 的 check-run 结果会自动回流',
      sample: testsRun.length,
    },
    {
      key: 'coverage',
      label: '最新覆盖率',
      value: coverageTrend.length === 0 ? null : coverageTrend[coverageTrend.length - 1]!.coverage,
      unit: 'percent',
      source: 'ci',
      wired: coverageTrend.length > 0,
      hint: 'CI 需要在 check-run 的 output 里写出覆盖率百分比，否则抓不到',
      sample: withCoverage.length,
    },
    {
      key: 'security_scan_pass_rate',
      label: '安全扫描通过率',
      value: scanRun.length === 0 ? null : round(scanPassed / scanRun.length),
      unit: 'percent',
      source: 'ci',
      wired: scanRun.length > 0,
      hint: '需要 CI 里有安全扫描步骤并回流结果',
      sample: scanRun.length,
    },
    {
      key: 'post_release_incidents',
      label: `发布后 ${INCIDENT_WINDOW_DAYS} 天内事故`,
      /**
       * ★ 没有发布过就是 null，不是 0。
       *   「0 起事故」和「这个周期没发过版」是完全不同的两件事，
       *   显示成 0 会让人以为质量很好。
       */
      value: releases.length === 0 ? null : incidents.length,
      unit: 'count',
      source: 'work_items',
      wired: releases.length > 0,
      hint: '本周期还没有完成的发布，没有可统计的窗口',
      sample: releases.length,
    },
    {
      key: 'incident_rate_per_release',
      label: '每次发布的事故数',
      value: releases.length === 0 ? null : Math.round((incidents.length / releases.length) * 100) / 100,
      unit: 'count',
      source: 'work_items',
      wired: releases.length > 0,
      hint: '本周期还没有完成的发布',
      sample: releases.length,
    },
  ];

  return {
    metrics,
    coverageTrend,
    postReleaseIncidents: incidents,
    ciCoverageOfItems: ciWired && inWindow.length > 0 ? round(withCi.length / inWindow.length) : null,
  };
}

/**
 * 发布后短期内出现的事故。
 *
 * ★ 归因到「最近一次发布」而不是全部发布：
 *   一周内发了三次版、之后出了一个事故，把它算成三次发布各有一个事故，
 *   会让「每次发布的事故数」凭空翻三倍。
 *
 * ★ 只统计发布**之后**创建的事故。发布前就存在的问题不是这次发布引入的，
 *   算进去会让「刚上线就出事」这个信号彻底失真。
 */
export function findPostReleaseIncidents(
  items: ItemRow[],
  from: number,
  to: number,
): QualityMetrics['postReleaseIncidents'] {
  const releases = items
    .filter((i) => i.type === 'release' && i.actualEnd !== null)
    .sort((a, b) => a.actualEnd! - b.actualEnd!);

  if (releases.length === 0) return [];

  const windowMs = INCIDENT_WINDOW_DAYS * 86_400_000;

  return items
    .filter((i) => i.type === 'incident' && i.createdAt >= from && i.createdAt <= to)
    .map((incident) => {
      // 找它之前最近的一次发布
      let latest: ItemRow | null = null;
      for (const r of releases) {
        if (r.actualEnd! <= incident.createdAt) latest = r;
        else break;
      }
      if (!latest || incident.createdAt - latest.actualEnd! > windowMs) return null;

      return {
        id: incident.id,
        title: incident.title,
        createdAt: incident.createdAt,
        daysAfterRelease: Math.round(((incident.createdAt - latest.actualEnd!) / 86_400_000) * 10) / 10,
        relatedReleaseId: latest.id,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

/**
 * 覆盖率趋势。
 *
 * ★ 同一天多条取**最后一条**，不取平均。覆盖率是一个瞬时值，
 *   把一天里三次 CI 的覆盖率平均起来，得到的是一个从未真实存在过的数。
 */
function buildCoverageTrend(items: ItemRow[]): { day: string; coverage: number }[] {
  const byDay = new Map<string, { at: number; coverage: number }>();

  for (const i of items) {
    const at = i.actualEnd ?? i.createdAt;
    const day = dayKey(at);
    const coverage = ci(i)!.coverage as number;
    const seen = byDay.get(day);
    if (!seen || at >= seen.at) byDay.set(day, { at, coverage });
  }

  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, v]) => ({ day, coverage: v.coverage }));
}

interface QualityGate {
  testsPassed?: boolean;
  securityScanPassed?: boolean;
  coverage?: number;
  criticalBugs?: number;
}

function ci(item: ItemRow): QualityGate | null {
  const gate = (item as ItemRow & { qualityGate?: QualityGate }).qualityGate;
  if (!gate || Object.keys(gate).length === 0) return null;
  return gate;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
