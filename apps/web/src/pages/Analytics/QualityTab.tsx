import { hasMessage, t, useT, type MessageKey } from '../../lib/i18n';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { relativeTime } from '../../lib/format';
import { Card } from './Card';
import { TrendChart } from '../../features/analytics/charts';
import type { QualityMetric } from '@apos/domain';
import type { AnalyticsResponse } from '../../lib/api/types';

/**
 * 质量 Tab（页面文档 12）。
 *
 * ★ 这一页曾经因为「CI 与事故系统都没接」整个不做。现在两样都有了 ——
 *   CI 从代码仓库回流，事故就是 type=incident 的任务。
 *
 * ★ 但每一项都自报数据源与接入状态。一个混着真数字和占位符、
 *   却不说明哪个是哪个的页面，比整个不做更糟：
 *   用户会把占位符当成真的，然后据此判断「质量在变好」。
 *   所以没接的显式说没接、给出怎么接，绝不给 0。
 */
export function QualityTab({
  data,
  projectId,
}: {
  data: AnalyticsResponse;
  projectId: string;
}) {
  const t = useT();
  /**
   * ★ 指标名与「怎么接上」的提示按 `key` 取词。服务端那两个字段是中文 ——
   *   画它们等于让英文界面上这一整块是中文。认不出 key 才回落。
   */
  const metricCopy = (m: QualityMetric, part: 'label' | 'hint') => {
    const key = `analytics.quality.${m.key}.${part}` as MessageKey;
    return hasMessage(key) ? t(key, m.params ?? {}) : part === 'label' ? m.label : m.hint;
  };
  const q = data.quality;
  const wired = q.metrics.filter((m) => m.wired);
  const notWired = q.metrics.filter((m) => !m.wired);

  return (
    <div className="space-y-3">
      {wired.length === 0 && (
        <div className="rounded border border-dashed border-slate-300 bg-white px-3 py-3">
          <p className="text-xs text-slate-700">{t('quality.noMetrics')}</p>
          <p className="mt-1 text-[11px] text-slate-500">
            {t('quality.noMetricsHint')}
          </p>
          <Link
            to={`/projects/${projectId}/settings/integrations`}
            className="mt-1.5 inline-block text-[11px] text-slate-600 underline-offset-2 hover:underline"
          >
            {t('quality.goToIntegrations')}
          </Link>
        </div>
      )}

      {wired.length > 0 && (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {wired.map((m) => (
            <div key={m.key} className="rounded border border-slate-200 bg-white px-3 py-2">
              <p className="text-[11px] text-slate-500">{metricCopy(m, 'label')}</p>
              <p className="mt-0.5 text-lg font-semibold text-slate-900">
                {format(m.value, m.unit)}
              </p>
              {/* ★ 样本量必须给：3 个样本算出的 100% 说明不了任何事 */}
              <p className="text-[11px] text-slate-400">
                {t('quality.sample', { count: m.sample })}
                {m.sample < 5 && <span className="ml-1 text-amber-700">{t('quality.thinSample')}</span>}
              </p>
            </div>
          ))}
        </div>
      )}

      {q.coverageTrend.length > 1 && (
        <Card title={t('quality.coverageTrend')} subtitle={t('quality.coverageSubtitle')}>
          <TrendChart
            points={q.coverageTrend.map((c) => ({ day: c.day, value: c.coverage }))}
            format={(v) => `${Math.round(v)}%`}
          />
        </Card>
      )}

      {q.postReleaseIncidents.length > 0 && (
        <Card
          title={t('quality.postRelease', { count: q.postReleaseIncidents.length })}
          subtitle={t('quality.incidentsSubtitle')}
        >
          <ul className="space-y-0.5">
            {q.postReleaseIncidents.map((i) => (
              <li key={i.id} className="text-[11px]">
                <Link
                  to={`/projects/${projectId}/board?item=${i.id}`}
                  className="text-slate-700 underline-offset-2 hover:underline"
                >
                  {i.title}
                </Link>
                <span className="ml-2 text-amber-700">{t('quality.daysAfterRelease', { days: i.daysAfterRelease })}</span>
                <span className="ml-2 text-slate-400">{relativeTime(new Date(i.createdAt).toISOString())}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {q.ciCoverageOfItems !== null && q.ciCoverageOfItems < 0.8 && (
        <p className="rounded bg-amber-50 px-3 py-1.5 text-[11px] text-amber-900">
          {t('quality.lowCiCoverage', { percent: Math.round(q.ciCoverageOfItems * 100) })}
        </p>
      )}

      {/**
       * ★ 没接上的单独列，并说明缺什么。
       *   混进上面的卡片里显示 0 或 "—"，用户读到的是「这项很差」。
       */}
      {notWired.length > 0 && (
        <Card title={t('quality.noSource')}>
          <ul className="space-y-1">
            {notWired.map((m) => (
              <li key={m.key} className="text-[11px]">
                <span className="text-slate-700">{metricCopy(m, 'label')}</span>
                <span className="ml-2 rounded bg-slate-100 px-1 text-slate-500">{t('quality.notConnected')}</span>
                <span className="mt-0.5 block text-slate-400">{metricCopy(m, 'hint')}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function format(value: number | null, unit: string): string {
  if (value === null) return '—';
  if (unit === 'percent') return `${Math.round(value * 100)}%`;
  if (unit === 'days') return t('quality.days', { value });
  return String(value);
}

export function QualityBadge({ wired, total }: { wired: number; total: number }) {
  const t = useT();
  return (
    <span className={clsx('text-[11px]', wired === 0 ? 'text-slate-400' : 'text-slate-600')}>
      {t('quality.wiredOf', { wired, total })}
    </span>
  );
}
