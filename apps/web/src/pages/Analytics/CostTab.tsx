import { useT } from '../../lib/i18n';
import type { Analytics } from '@apos/domain';
import { BarChart, NotWired, StatTile, TrendChart } from '../../features/analytics/charts';
import { money } from '../../lib/format';
import { Card } from './Card';
import { Button } from '@/components/ui/button';

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
  const t = useT();
  const { cost, deltas } = data;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <StatTile
          label={t('cost.totalInWindow')}
          value={money(String(cost.total))}
          hint={t('cost.totalHelp')}
        />
        <StatTile
          label={t('cost.perDelivery')}
          value={cost.perDelivered === null ? '—' : money(String(cost.perDelivered))}
          sub={t('cost.delivered', { count: cost.delivered })}
          delta={deltas?.costPerDelivered}
          higherIsBetter={false}
          hint={t('cost.perDeliveryHelp')}
        />
        {cost.budget === null ? (
          <NotWired label={t('cost.budgetUsed')} why={t('cost.noBudget')} />
        ) : (
          <StatTile
            label={t('cost.budgetUsed')}
            value={`${Math.round((cost.budgetSpent / cost.budget) * 100)}%`}
            sub={`${money(String(cost.budgetSpent))} / ${money(String(cost.budget))}`}
            higherIsBetter={false}
            hint={t('cost.budgetUsedHelp')}
          />
        )}
        {cost.budgetRunwayDays === null ? (
          <NotWired label={t('cost.runway')} why={cost.budget === null ? t('cost.noBudgetBaseline') : t('cost.noSpend')} />
        ) : (
          <StatTile
            label={t('cost.runway')}
            value={t('cost.runwayDays', { days: cost.budgetRunwayDays })}
            higherIsBetter={false}
            hint={t('cost.runwayHelp')}
          />
        )}
      </div>

      <Card title={t('cost.trend')} subtitle={t('cost.trendHint')}>
        <TrendChart points={cost.trend} format={(v) => money(String(v))} />
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        <Card title={t('cost.byAgent')} subtitle={t('cost.byAgentSubtitle')}>
          <BarChart
            data={cost.byAgent.map((a) => ({
              label: a.label,
              value: a.cost,
              display: `${money(String(a.cost))} ${a.percent}%`,
            }))}
          />
        </Card>
        <Card title={t('cost.byType')}>
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
        title={t('cost.anomalies')}
        subtitle={t('cost.anomalySubtitle')}
      >
        {cost.anomalies.length === 0 ? (
          <p className="py-3 text-center text-xs text-slate-400">{t('cost.noAnomalies')}</p>
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
                <Button variant="outline" size="xs"
                  onClick={() => onOpenRun(a.runId)}
                  className="shrink-0">
                  看执行记录 →
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
