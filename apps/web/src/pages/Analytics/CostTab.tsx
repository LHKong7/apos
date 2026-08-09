import type { Analytics } from '@apos/domain';
import { BarChart, NotWired, StatTile, TrendChart } from '../../features/analytics/charts';
import { money } from '../../lib/format';
import { Card } from './Card';

/**
 * 成本（页面文档 12 §5.6）。
 *
 * ★ 刻意没做「成本效益视角」（Agent 成本 vs 节省的人力工时）。
 *   它需要一个人力成本基准，而这个数字既没地方配置、又敏感
 *   （页面文档 §12.3 把它列为待确认）。硬编一个时薪算出来的
 *   「本月为你省了 $12,400」看起来最像成果，也最经不起追问 ——
 *   被问一次「这个数怎么来的」就再也没人信这一页了。
 */
export function CostTab({ data, onOpenRun }: { data: Analytics; onOpenRun: (runId: string) => void }) {
  const { cost, deltas } = data;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <StatTile
          label="窗口内总成本"
          value={money(String(cost.total))}
          hint="窗口内发起的全部 Agent Run 的成本合计。"
        />
        <StatTile
          label="单位交付成本"
          value={cost.perDelivered === null ? '—' : money(String(cost.perDelivered))}
          sub={`${cost.delivered} 项完成`}
          delta={deltas?.costPerDelivered}
          higherIsBetter={false}
          hint="窗口内总成本 ÷ 完成的任务数。跨周期比这个数，比比总额有意义得多。"
        />
        {cost.budget === null ? (
          <NotWired label="预算消耗" why="这个项目没有设置预算" />
        ) : (
          <StatTile
            label="预算消耗"
            value={`${Math.round((cost.budgetSpent / cost.budget) * 100)}%`}
            sub={`${money(String(cost.budgetSpent))} / ${money(String(cost.budget))}`}
            higherIsBetter={false}
            hint="项目累计成本占预算的比例（累计值，不受时间窗口影响）。"
          />
        )}
        {cost.budgetRunwayDays === null ? (
          <NotWired label="按当前速率可用" why={cost.budget === null ? '没有预算基准' : '窗口内没有支出'} />
        ) : (
          <StatTile
            label="按当前速率可用"
            value={`${cost.budgetRunwayDays} 天`}
            higherIsBetter={false}
            hint="剩余预算 ÷ 窗口内的日均消耗。速率变化时这个预测会跟着变，不是承诺。"
          />
        )}
      </div>

      <Card title="成本趋势" subtitle="按天。突起的那一天值得点开看看发生了什么">
        <TrendChart points={cost.trend} format={(v) => money(String(v))} />
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        <Card title="按 Agent 分解" subtitle="贵的那个未必该换 —— 先看它是不是也更快更准">
          <BarChart
            data={cost.byAgent.map((a) => ({
              label: a.label,
              value: a.cost,
              display: `${money(String(a.cost))} ${a.percent}%`,
            }))}
          />
        </Card>
        <Card title="按任务类型分解">
          <BarChart
            data={cost.byType.map((t) => ({
              label: t.label,
              value: t.cost,
              display: `${money(String(t.cost))} ${t.percent}%`,
            }))}
          />
        </Card>
      </div>

      <Card
        title="成本异常"
        subtitle="单次执行超过常态 3 倍。阈值跟着样本走，不是写死的金额 —— 写死的阈值在便宜的项目里永远不触发，在贵的项目里天天报警"
      >
        {cost.anomalies.length === 0 ? (
          <p className="py-3 text-center text-xs text-slate-400">没有异常开销的执行</p>
        ) : (
          <ul className="space-y-1">
            {cost.anomalies.map((a) => (
              <li key={a.runId} className="flex items-center gap-2 border-b border-slate-100 py-1 text-xs last:border-0">
                <span className="min-w-0 flex-1 truncate text-slate-800" title={a.title}>
                  {a.title}
                </span>
                <span className="shrink-0 text-slate-500">{a.agentName}</span>
                <span className="shrink-0 tabular-nums font-medium text-orange-700">
                  {money(String(a.cost))}（{a.times}×常态）
                </span>
                <button
                  type="button"
                  onClick={() => onOpenRun(a.runId)}
                  className="shrink-0 rounded border border-slate-300 px-1.5 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50"
                >
                  看执行记录 →
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
