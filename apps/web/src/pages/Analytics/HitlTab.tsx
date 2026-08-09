import clsx from 'clsx';
import { formatHours, type Analytics, type RepeatedDecision } from '@apos/domain';
import { BarChart, StatTile } from '../../features/analytics/charts';
import { stageLabel } from '../../lib/format';
import { Card } from './Card';

const POTENTIAL = {
  high: { icon: '🟢', label: '高', className: 'text-green-700' },
  medium: { icon: '🟡', label: '中', className: 'text-amber-700' },
  low: { icon: '⚪', label: '低', className: 'text-slate-500' },
} as const;

/**
 * Human-in-the-Loop（页面文档 12 §5.5）—— 本产品最独特的分析维度。
 *
 * ★ 落点是最后那张「重复决策」表。前面几块都在描述现状，
 *   只有它告诉用户「你可以少做哪些事」并给出一键入口。
 *   这是产品持续降低人类负担的飞轮，也是这个 Tab 存在的理由。
 */
export function HitlTab({
  data,
  onCreatePolicy,
}: {
  data: Analytics;
  onCreatePolicy: (type: RepeatedDecision) => void;
}) {
  const { hitl } = data;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <StatTile
          label="决策总数"
          value={`${hitl.totalDecisions}`}
          sub={`${hitl.resolved} 项已处理`}
          hint="窗口内创建的决策数。"
        />
        <StatTile
          label="平均决策时间"
          value={hitl.resolutionTime.count > 0 ? formatHours(hitl.resolutionTime.median) : '—'}
          sub={
            hitl.resolutionTime.count > 0
              ? `中位数 · 最长 ${formatHours(hitl.resolutionTime.maxValue)}`
              : undefined
          }
          higherIsBetter={false}
          hint="从决策创建到被处理的时长，取中位数。最长的那一次单独标出，通常它才是问题。"
        />
        <StatTile
          label="超时"
          value={`${hitl.overdue}`}
          sub="项"
          higherIsBetter={false}
          hint="已过截止时间仍未处理，或处理时已经超期。"
        />
        <StatTile
          label="自动化比例"
          value={hitl.automationRate === null ? '—' : `${Math.round(hitl.automationRate * 100)}%`}
          sub={`${hitl.autoPassed} / ${hitl.policyEvaluations} 次评估自动放行`}
          hint="策略判定为自动放行的流转 ÷ 全部策略评估。这个比例越高，被打扰的人越少。"
        />
        <StatTile
          label="等待人类耗时"
          value={formatHours(hitl.blockedByHumanHours)}
          higherIsBetter={false}
          hint="任务处于「等待人类决策」状态的累计时长。"
        />
      </div>

      {/*
        ★ 整个 Tab 的落点。
          「可自动化潜力」直接回答「我可以少做哪些事」，
          而不是又给一个需要用户自己解读的百分比。
      */}
      <Card
        title="重复决策与可自动化潜力"
        subtitle="次数多 + 结果一致 才推荐规则化。有分歧的决策恰恰最需要人，自动化了就是在制造事故"
      >
        {hitl.repeated.length === 0 ? (
          <p className="py-3 text-center text-xs text-slate-400">
            这段时间没有出现三次以上的同类决策
          </p>
        ) : (
          <ul className="space-y-1">
            {hitl.repeated.map((r) => {
              const meta = POTENTIAL[r.potential];
              return (
                <li
                  key={r.type}
                  className="flex flex-wrap items-center gap-2 border-b border-slate-100 py-1 text-xs last:border-0"
                >
                  <span className="min-w-0 flex-1 truncate text-slate-800">{r.label}</span>
                  <span className="tabular-nums text-slate-600">{r.count} 次</span>
                  <span className="tabular-nums text-slate-500">
                    {r.approvedCount} 批准 · 一致性 {Math.round(r.consistency * 100)}%
                  </span>
                  <span className="tabular-nums text-slate-500">
                    平均等 {formatHours(r.avgWaitHours)}
                  </span>
                  <span className={clsx('w-20 shrink-0', meta.className)}>
                    {meta.icon} 潜力{meta.label}
                  </span>
                  {r.potential === 'low' ? (
                    <span className="w-24 shrink-0 text-right text-[11px] text-slate-400">
                      结果有分歧
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onCreatePolicy(r)}
                      className="w-24 shrink-0 rounded border border-slate-300 px-1.5 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50"
                    >
                      创建规则 →
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        <Card
          title="各阶段人类介入比例"
          subtitle="Intake 接近 100% 是设计如此；Execution 越低越好"
        >
          <BarChart
            data={hitl.byStage.map((s) => ({
              label: stageLabel(s.stage),
              value: s.percent,
              display: `${s.percent}%`,
              tone: s.stage === 'execution' && s.percent > 30 ? 'waiting' : 'primary',
            }))}
            emptyHint="这段时间没有可统计的阶段流转"
          />
        </Card>

        <Card title="决策响应时间分布" subtitle="慢的那一档如果只有一类决策，问题就很明确了">
          <BarChart
            // 空档也画出来 —— 分布图的形状本身就是信息，
            // 「> 8h 一个都没有」和「这一档不存在」不是一回事
            data={hitl.responseBuckets
              .map((b) => ({
                label: b.label,
                value: b.count,
                display: `${b.count} 次`,
                tone: b.label === '> 8h' ? ('waiting' as const) : ('primary' as const),
                ...(b.slowest
                  ? { flag: { icon: '🔴', text: `全部为${b.slowest}`, tone: 'critical' as const } }
                  : {}),
              }))}
            emptyHint="这段时间没有已处理的决策"
          />
        </Card>
      </div>

      <Card
        title="人工覆盖原因分布"
        subtitle="人在看板上手动改状态的次数。这个数字应该随时间下降 —— 它衡量的是系统自动判断有多准"
      >
        <BarChart
          data={hitl.overrideReasons.map((r) => ({
            label: r.label,
            value: r.count,
            display: `${r.count} 次 ${r.percent}%`,
            tone: 'waiting' as const,
          }))}
          emptyHint="这段时间没有人工覆盖 —— 系统的自动判断都被接受了"
        />
      </Card>

      <p className="text-[11px] text-slate-400">
        决策响应时间等个人绩效相关数据默认聚合展示，本页不提供个人明细
        —— 避免这一页被当成监控工具用（页面文档 §8）。
      </p>
    </div>
  );
}
