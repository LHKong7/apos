import { useT } from '../../lib/i18n';
import { formatHours, type Analytics } from '@apos/domain';
import { bucketLabel } from '../../lib/format';
import { BarChart, NotWired, StatTile, TrendChart, type BarDatum } from '../../features/analytics/charts';
import { Card } from './Card';

/**
 * Flow 指标（页面文档 12 §5.2 / §5.3）。
 *
 * ★ 「流动效率」放在第一张卡不是排版顺序问题。传统工具能提高「任务完成数」，
 *   本产品的主张是让工作**流动**起来 —— 如果 Agent 干得飞快但一半时间在等人批准，
 *   产品价值就没兑现。这个数字直接衡量承诺有没有做到。
 */
export function FlowTab({
  data,
  onDrill,
}: {
  data: Analytics;
  onDrill: (kind: 'rework' | 'wip' | 'slow') => void;
}) {
  const t = useT();
  const { flow, deltas } = data;

  /**
   * ★ 分档名走词条而不是 domain 的 `BUCKET_LABELS` —— 那张表是中文，
   *   前端直接 import 它，等于把服务端的语言硬编进界面。
   */
  const breakdown: (BarDatum & { bucket: string })[] = flow.breakdown
    .filter((b) => b.hours > 0)
    .map((b) => ({
      bucket: b.bucket,
      label: bucketLabel(b.bucket),
      value: b.hours,
      display: `${formatHours(b.hours)} ${b.percent}%`,
      tone: b.kind === 'waiting' ? 'waiting' : 'primary',
    }));

  // 最大的等待项就是瓶颈。配图标 + 文字，颜色不是唯一线索
  const worstWait = flow.breakdown
    .filter((b) => b.kind === 'waiting')
    .sort((a, b) => b.hours - a.hours)[0];
  if (worstWait && worstWait.hours > 0) {
    /**
     * ★ 按 bucket 找，不按 label 找。
     *   原来是拿翻译后的字符串去比对 —— 一旦标签改一个字（或换个语言），
     *   这里就静默找不到，瓶颈标记消失而没有任何报错。
     */
    const row = breakdown.find((r) => r.bucket === worstWait.bucket);
    if (row) row.flag = { icon: '⛔', text: t('flow.biggestBottleneck'), tone: 'critical' };
  }

  const efficiency = flow.activeHours + flow.waitingHours;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <StatTile
          label={t('flow.efficiency')}
          value={flow.flowEfficiency === null ? '—' : `${Math.round(flow.flowEfficiency * 100)}%`}
          sub={
            efficiency > 0
              ? t('flow.activeWaiting', { active: formatHours(flow.activeHours), waiting: formatHours(flow.waitingHours) })
              : undefined
          }
          delta={deltas?.flowEfficiency}
          hint={t('flow.efficiencyHelp')}
        />
        <StatTile
          label={t('flow.leadTime')}
          value={flow.leadTime.count > 0 ? formatHours(flow.leadTime.median) : '—'}
          sub={
            flow.leadTime.count > 0
              ? t('flow.medianMean', { mean: formatHours(flow.leadTime.mean) })
              : t('flow.noCompleted')
          }
          delta={deltas?.leadTime}
          higherIsBetter={false}
          hint={t('flow.leadTimeHelp')}
          onClick={() => onDrill('slow')}
        />
        <StatTile
          label={t('flow.cycleTime')}
          value={flow.cycleTime.count > 0 ? formatHours(flow.cycleTime.median) : '—'}
          sub={t('flow.completedCount', { count: flow.completed })}
          delta={deltas?.cycleTime}
          higherIsBetter={false}
          hint={t('flow.cycleTimeHelp')}
        />
        <StatTile
          label={t('flow.throughput')}
          value={`${flow.throughputPerWeek}`}
          sub={t('flow.perWeek')}
          delta={deltas?.throughput}
          hint={t('flow.throughputHelp')}
        />
        <StatTile
          label={t('flow.wip')}
          value={`${flow.wipNow}`}
          sub={t('flow.wipHint')}
          hint={t('flow.wipHelp')}
          onClick={() => onDrill('wip')}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <StatTile
          label={t('flow.reworkRate')}
          value={flow.reworkRate === null ? '—' : `${Math.round(flow.reworkRate * 100)}%`}
          sub={t('flow.reworkedCount', { count: flow.reworkedItems })}
          higherIsBetter={false}
          hint={t('flow.reworkRateHelp')}
          onClick={() => onDrill('rework')}
        />
        <StatTile
          label={t('flow.blockedTime')}
          value={formatHours(flow.blockedHours)}
          hint={t('flow.blockedTimeHelp')}
        />
        <StatTile
          label={t('flow.awaitingDecision')}
          value={formatHours(flow.decisionWaitHours)}
          delta={deltas?.decisionWaitHours}
          higherIsBetter={false}
          hint={t('flow.awaitingDecisionHelp')}
        />
        {flow.onTimeRate === null ? (
          <NotWired label={t('flow.onTimeRate')} why={t('flow.noSchedule')} />
        ) : (
          <StatTile
            label={t('flow.onTimeRate')}
            value={`${Math.round(flow.onTimeRate * 100)}%`}
            hint={t('flow.onTimeRateHelp')}
          />
        )}
      </div>

      {/*
        ★ 本页最有行动价值的一张图（页面文档 §5.3）。
          底部那句「有效 44% / 等待 56%」比任何图表都有冲击力 ——
          它把「我们很忙」和「我们在等」这两件事分开了。
      */}
      <Card
        title={t('flow.cycleBreakdown')}
        subtitle={t('flow.cycleBreakdownHint')}
      >
        <BarChart
          data={breakdown}
          legend={[
            { label: t('flow.active'), tone: 'primary' },
            { label: t('flow.waiting'), tone: 'waiting' },
          ]}
        />
        {efficiency > 0 && (
          <p className="mt-2 border-t border-slate-100 pt-1.5 text-xs text-slate-700">
            {t('flow.activeTime')}{' '}
            <span className="font-semibold">{Math.round((flow.activeHours / efficiency) * 100)}%</span>
            {' · '}{t('flow.waitTime')}{' '}
            <span className="font-semibold text-orange-700">
              {Math.round((flow.waitingHours / efficiency) * 100)}%
            </span>
          </p>
        )}
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        <Card title={t('flow.wipTrend')} subtitle={t('flow.wipSubtitle')}>
          <TrendChart points={flow.wipTrend} format={(v) => t('flow.wipUnit', { count: v })} />
        </Card>
        <Card title={t('flow.blockedTrend')} subtitle={t('flow.blockedSubtitle')}>
          <TrendChart points={flow.blockedTrend} tone="waiting" format={formatHours} emptyHint={t('flow.noBlocked')} />
        </Card>
      </div>
    </div>
  );
}
