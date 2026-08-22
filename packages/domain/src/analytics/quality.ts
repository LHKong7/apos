import { dayKey, isTerminal } from './timeline';
import type { AnalyticsInput, ItemRow } from './types';

/**
 * The Quality tab (page doc 12 §5.x).
 *
 * ★ This page was once skipped entirely because "neither CI nor an incident system is connected".
 *   CI now exists (GitHub check-runs → typeData.qualityGate) and so do incidents
 *   (work_items.type === 'incident'), so it can genuinely be computed.
 *
 * ★ But **every metric must declare its data source and whether it is wired up**. A page that
 *   mixes real numbers with placeholders without saying which is which is worse than no page at
 *   all: users take the placeholder as real and conclude "quality is improving". So each metric
 *   carries `wired` and `source`, and anything unconnected says so outright instead of showing 0.
 *
 *   每个指标都带 `wired` 与 `source`，没接的显式说没接、不给 0 —— 混着假数字的页面
 *   比整个不做更糟。
 */

export type MetricSource = 'ci' | 'work_items' | 'events';

export interface QualityMetric {
  /**
   * ★★ The UI resolves copy from this key (`analytics.quality.<key>.label` / `.hint`) rather than
   *   rendering the two Chinese fields below. This layer only guarantees one key, one sentence.
   */
  key: string;
  /** The Chinese wording — for logs and as a fallback. The UI reads codes, logs read sentences */
  label: string;
  /** Numbers appearing in `label` / `hint`, so each language can order them its own way */
  params?: Record<string, string | number>;
  /** null = no data source for this metric; the page must show "not wired up", never 0 */
  value: number | null;
  unit: 'percent' | 'count' | 'days';
  source: MetricSource;
  /** Whether the data source is connected. When false, value is always null */
  wired: boolean;
  /** When it is not connected: what is missing and how to connect it */
  hint: string;
  /** Sample size behind the number — 100% computed from 3 samples proves nothing */
  sample: number;
}

export interface QualityMetrics {
  metrics: QualityMetric[];
  /** Coverage over time; an empty array when there is no CI, never an invented line */
  coverageTrend: { day: string; coverage: number }[];
  /** Incidents shortly after a release, listed one by one — a bare count cannot be investigated */
  postReleaseIncidents: {
    id: string;
    title: string;
    createdAt: number;
    daysAfterRelease: number;
    relatedReleaseId: string | null;
  }[];
  /** Share of work items that carry a CI result — a low value means CI is only partly wired up */
  ciCoverageOfItems: number | null;
}

/** How many days after a release an incident still counts as introduced by that release */
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
      /** ★ This label carries a number, and the English sentence orders it differently */
      params: { days: INCIDENT_WINDOW_DAYS },
      /**
       * ★ With no releases at all the answer is null, not 0.
       *   "Zero incidents" and "nothing shipped this period" are completely different facts, and
       *   rendering the second as 0 leaves the reader believing quality is excellent.
       *
       *   没发过版就是 null，显示成 0 会让人以为质量很好。
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
 * Incidents appearing shortly after a release.
 *
 * ★ Attributed to the **most recent** release, not to all of them: three releases in one week
 *   followed by one incident, counted as one incident per release, would triple
 *   "incidents per release" out of thin air.
 *
 * ★ Only incidents created **after** the release count. A problem that already existed before the
 *   release was not introduced by it, and folding it in destroys the "it broke right after we
 *   shipped" signal entirely.
 *
 *   归因到最近一次发布，且只算发布之后创建的事故。
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
      // Find the most recent release before it
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
 * Coverage trend.
 *
 * ★ When a day has several readings, take the **last** one rather than the average. Coverage is
 *   an instantaneous value; averaging three CI runs from one day yields a number that never
 *   actually existed.
 *
 *   同一天多条取最后一条不取平均，平均出来的是一个从未真实存在过的数。
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
