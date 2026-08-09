import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { relativeTime } from '../../lib/format';
import { Card } from './Card';
import { TrendChart } from '../../features/analytics/charts';
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
  const q = data.quality;
  const wired = q.metrics.filter((m) => m.wired);
  const notWired = q.metrics.filter((m) => !m.wired);

  return (
    <div className="space-y-3">
      {wired.length === 0 && (
        <div className="rounded border border-dashed border-slate-300 bg-white px-3 py-3">
          <p className="text-xs text-slate-700">质量指标一项都算不出来 —— 数据源还没接上</p>
          <p className="mt-1 text-[11px] text-slate-500">
            测试通过率与覆盖率来自 CI：在集成设置里连上代码仓库，
            并把任务和 PR 关联起来，check-run 的结果会自动回流。
            发布后事故来自 type=incident 的任务，本周期还没有完成的发布。
          </p>
          <Link
            to={`/projects/${projectId}/settings/integrations`}
            className="mt-1.5 inline-block text-[11px] text-slate-600 underline-offset-2 hover:underline"
          >
            去集成设置 →
          </Link>
        </div>
      )}

      {wired.length > 0 && (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {wired.map((m) => (
            <div key={m.key} className="rounded border border-slate-200 bg-white px-3 py-2">
              <p className="text-[11px] text-slate-500">{m.label}</p>
              <p className="mt-0.5 text-lg font-semibold text-slate-900">
                {format(m.value, m.unit)}
              </p>
              {/* ★ 样本量必须给：3 个样本算出的 100% 说明不了任何事 */}
              <p className="text-[11px] text-slate-400">
                样本 {m.sample}
                {m.sample < 5 && <span className="ml-1 text-amber-700">偏少，参考价值有限</span>}
              </p>
            </div>
          ))}
        </div>
      )}

      {q.coverageTrend.length > 1 && (
        <Card title="覆盖率趋势" subtitle="每天取当天最后一次 CI 的结果 —— 覆盖率是瞬时值，取平均会得到一个从未存在过的数">
          <TrendChart
            points={q.coverageTrend.map((c) => ({ day: c.day, value: c.coverage }))}
            format={(v) => `${Math.round(v)}%`}
          />
        </Card>
      )}

      {q.postReleaseIncidents.length > 0 && (
        <Card
          title={`发布后事故（${q.postReleaseIncidents.length}）`}
          subtitle="只算发布之后创建的，且归因到最近一次发布 —— 否则一周发三次版会让事故数凭空翻三倍"
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
                <span className="ml-2 text-amber-700">发布后 {i.daysAfterRelease} 天</span>
                <span className="ml-2 text-slate-400">{relativeTime(new Date(i.createdAt).toISOString())}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {q.ciCoverageOfItems !== null && q.ciCoverageOfItems < 0.8 && (
        <p className="rounded bg-amber-50 px-3 py-1.5 text-[11px] text-amber-900">
          只有 {Math.round(q.ciCoverageOfItems * 100)}% 的任务有 CI 结果 ——
          上面的通过率只代表这一部分，不是全部任务的质量
        </p>
      )}

      {/**
       * ★ 没接上的单独列，并说明缺什么。
       *   混进上面的卡片里显示 0 或 "—"，用户读到的是「这项很差」。
       */}
      {notWired.length > 0 && (
        <Card title="还没有数据源的指标">
          <ul className="space-y-1">
            {notWired.map((m) => (
              <li key={m.key} className="text-[11px]">
                <span className="text-slate-700">{m.label}</span>
                <span className="ml-2 rounded bg-slate-100 px-1 text-slate-500">未接入</span>
                <span className="mt-0.5 block text-slate-400">{m.hint}</span>
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
  if (unit === 'days') return `${value} 天`;
  return String(value);
}

export function QualityBadge({ wired, total }: { wired: number; total: number }) {
  return (
    <span className={clsx('text-[11px]', wired === 0 ? 'text-slate-400' : 'text-slate-600')}>
      {wired}/{total} 项已接入
    </span>
  );
}
