import { BUCKET_LABELS, formatHours, type Analytics } from '@apos/domain';
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
  const { flow, deltas } = data;

  const breakdown: BarDatum[] = flow.breakdown
    .filter((b) => b.hours > 0)
    .map((b) => ({
      label: BUCKET_LABELS[b.bucket],
      value: b.hours,
      display: `${formatHours(b.hours)} ${b.percent}%`,
      tone: b.kind === 'waiting' ? 'waiting' : 'primary',
    }));

  // 最大的等待项就是瓶颈。配图标 + 文字，颜色不是唯一线索
  const worstWait = flow.breakdown
    .filter((b) => b.kind === 'waiting')
    .sort((a, b) => b.hours - a.hours)[0];
  if (worstWait && worstWait.hours > 0) {
    const row = breakdown.find((r) => r.label === BUCKET_LABELS[worstWait.bucket]);
    if (row) row.flag = { icon: '⛔', text: '最大瓶颈', tone: 'critical' };
  }

  const efficiency = flow.activeHours + flow.waitingHours;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <StatTile
          label="流动效率"
          value={flow.flowEfficiency === null ? '—' : `${Math.round(flow.flowEfficiency * 100)}%`}
          sub={
            efficiency > 0
              ? `有效 ${formatHours(flow.activeHours)} · 等待 ${formatHours(flow.waitingHours)}`
              : undefined
          }
          delta={deltas?.flowEfficiency}
          hint="有效工作时间 ÷ 总周期时间。有效 = 有人或 Agent 正在推进（执行/评审/计划/发布）；排队、阻塞、等批准都算等待。"
        />
        <StatTile
          label="前置时间"
          value={flow.leadTime.count > 0 ? formatHours(flow.leadTime.median) : '—'}
          sub={
            flow.leadTime.count > 0
              ? `中位数 · 均值 ${formatHours(flow.leadTime.mean)}`
              : '窗口内没有完成项'
          }
          delta={deltas?.leadTime}
          higherIsBetter={false}
          hint="任务创建 → 交付完成。展示中位数，因为个别超长任务会把均值抬高一倍；均值同时给出，两者差得远说明有拖尾。"
          onClick={() => onDrill('slow')}
        />
        <StatTile
          label="周期时间"
          value={flow.cycleTime.count > 0 ? formatHours(flow.cycleTime.median) : '—'}
          sub={`${flow.completed} 项完成`}
          delta={deltas?.cycleTime}
          higherIsBetter={false}
          hint="开始执行 → 完成。比前置时间少了「排在队里等」的那一段。"
        />
        <StatTile
          label="吞吐"
          value={`${flow.throughputPerWeek}`}
          sub="项 / 周"
          delta={deltas?.throughput}
          hint="窗口内完成数换算成周速率。"
        />
        <StatTile
          label="在制品"
          value={`${flow.wipNow}`}
          sub="稳定优于高"
          hint="当前非草稿、未终结的任务数。持续上升说明进得比出得快。"
          onClick={() => onDrill('wip')}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <StatTile
          label="返工率"
          value={flow.reworkRate === null ? '—' : `${Math.round(flow.reworkRate * 100)}%`}
          sub={`${flow.reworkedItems} 项被打回或失败过`}
          higherIsBetter={false}
          hint="窗口内进过「需修改」或「失败」的任务 ÷ 有过流转的任务。返工通常指向验收标准不清，而不是执行问题。"
          onClick={() => onDrill('rework')}
        />
        <StatTile
          label="阻塞时长"
          value={formatHours(flow.blockedHours)}
          hint="窗口内处于阻塞状态的累计时长，跨窗口的阻塞只算落在窗口内的部分。"
        />
        <StatTile
          label="等待决策"
          value={formatHours(flow.decisionWaitHours)}
          delta={deltas?.decisionWaitHours}
          higherIsBetter={false}
          hint="窗口内处于「等待人类决策」的累计时长。本产品特有的损耗，单独计量。"
        />
        {flow.onTimeRate === null ? (
          <NotWired label="按时交付率" why="计划里没有排期字段" />
        ) : (
          <StatTile
            label="按时交付率"
            value={`${Math.round(flow.onTimeRate * 100)}%`}
            hint="窗口内完成且有计划完成时间的任务中，未超期的比例。没有排期的任务不计入分母。"
          />
        )}
      </div>

      {/*
        ★ 本页最有行动价值的一张图（页面文档 §5.3）。
          底部那句「有效 44% / 等待 56%」比任何图表都有冲击力 ——
          它把「我们很忙」和「我们在等」这两件事分开了。
      */}
      <Card
        title="周期时间分解"
        subtitle="时间到底花在哪。等待决策单独成条，不并入所处阶段"
      >
        <BarChart
          data={breakdown}
          legend={[
            { label: '有人/Agent 在推进', tone: 'primary' },
            { label: '在等待', tone: 'waiting' },
          ]}
        />
        {efficiency > 0 && (
          <p className="mt-2 border-t border-slate-100 pt-1.5 text-xs text-slate-700">
            有效工作时间{' '}
            <span className="font-semibold">{Math.round((flow.activeHours / efficiency) * 100)}%</span>
            {' · '}等待时间{' '}
            <span className="font-semibold text-orange-700">
              {Math.round((flow.waitingHours / efficiency) * 100)}%
            </span>
          </p>
        )}
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        <Card title="在制品趋势" subtitle="稳定优于高。持续上升 = 进得比出得快">
          <TrendChart points={flow.wipTrend} format={(v) => `${v} 项`} />
        </Card>
        <Card title="阻塞时长趋势" subtitle="峰值那天发生了什么，通常就是问题所在">
          <TrendChart points={flow.blockedTrend} tone="waiting" format={formatHours} emptyHint="这段时间没有任务被阻塞" />
        </Card>
      </div>
    </div>
  );
}
