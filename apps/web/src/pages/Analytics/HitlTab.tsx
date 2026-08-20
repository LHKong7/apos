import { useT, type MessageKey } from '../../lib/i18n';
import clsx from 'clsx';
import { formatHours, type Analytics, type RepeatedDecision } from '@apos/domain';
import { BarChart, StatTile } from '../../features/analytics/charts';
import { decisionTypeLabel, overrideReasonLabel, stageLabel } from '../../lib/format';
import { Card } from './Card';
import { Button } from '@/components/ui/button';

const POTENTIAL = {
  high: { icon: '🟢', labelKey: 'hitl.high', className: 'text-green-700' },
  medium: { icon: '🟡', labelKey: 'hitl.medium', className: 'text-amber-700' },
  low: { icon: '⚪', labelKey: 'hitl.low', className: 'text-slate-500' },
} as const satisfies Record<string, { icon: string; labelKey: MessageKey; className: string }>;

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
  const t = useT();
  const { hitl } = data;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <StatTile
          label={t('hitl.totalDecisions')}
          value={`${hitl.totalDecisions}`}
          sub={t('hitl.resolvedCount', { count: hitl.resolved })}
          hint={t('hitl.totalDecisionsHelp')}
        />
        <StatTile
          label={t('hitl.avgTime')}
          value={hitl.resolutionTime.count > 0 ? formatHours(hitl.resolutionTime.median) : '—'}
          sub={
            hitl.resolutionTime.count > 0
              ? t('hitl.medianMax', { time: formatHours(hitl.resolutionTime.maxValue) })
              : undefined
          }
          higherIsBetter={false}
          hint={t('hitl.avgTimeHelp')}
        />
        <StatTile
          label={t('hitl.overdue')}
          value={`${hitl.overdue}`}
          sub={t('hitl.items')}
          higherIsBetter={false}
          hint={t('hitl.overdueHelp')}
        />
        <StatTile
          label={t('hitl.automationRate')}
          value={hitl.automationRate === null ? '—' : `${Math.round(hitl.automationRate * 100)}%`}
          sub={t('hitl.autoPassed', { auto: hitl.autoPassed, total: hitl.policyEvaluations })}
          hint={t('hitl.automationRateHelp')}
        />
        <StatTile
          label={t('hitl.waitingOnHumans')}
          value={formatHours(hitl.blockedByHumanHours)}
          higherIsBetter={false}
          hint={t('hitl.waitingOnHumansHelp')}
        />
      </div>

      {/*
        ★ 整个 Tab 的落点。
          「可自动化潜力」直接回答「我可以少做哪些事」，
          而不是又给一个需要用户自己解读的百分比。
      */}
      <Card
        title={t('hitl.repeated')}
        subtitle={t('hitl.repeatedHint')}
      >
        {hitl.repeated.length === 0 ? (
          <p className="py-3 text-center text-xs text-slate-400">
            {t('hitl.noRepeated')}
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
                  <span className="min-w-0 flex-1 truncate text-slate-800">
                    {decisionTypeLabel(r.type)}
                  </span>
                  <span className="tabular-nums text-slate-600">{t('hitl.timesCount', { count: r.count })}</span>
                  <span className="tabular-nums text-slate-500">
                    {t('hitl.approvedConsistency', {
                      approved: r.approvedCount,
                      consistency: Math.round(r.consistency * 100),
                    })}
                  </span>
                  <span className="tabular-nums text-slate-500">
                    {t('hitl.avgWait', { time: formatHours(r.avgWaitHours) })}
                  </span>
                  <span className={clsx('w-20 shrink-0', meta.className)}>
                    {t('hitl.potential', { icon: meta.icon, level: t(meta.labelKey) })}
                  </span>
                  {r.potential === 'low' ? (
                    <span className="w-24 shrink-0 text-right text-[11px] text-slate-400">
                      {t('hitl.inconsistent')}
                    </span>
                  ) : (
                    <Button variant="outline" size="xs"
                      onClick={() => onCreatePolicy(r)}
                      className="w-24 shrink-0">
                      {t('hitl.createRule')}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        <Card
          title={t('hitl.stageInvolvement')}
          subtitle={t('hitl.stageInvolvementHint')}
        >
          <BarChart
            data={hitl.byStage.map((s) => ({
              label: stageLabel(s.stage),
              value: s.percent,
              display: `${s.percent}%`,
              tone: s.stage === 'execution' && s.percent > 30 ? 'waiting' : 'primary',
            }))}
            emptyHint={t('hitl.noStageData')}
          />
        </Card>

        <Card title={t('hitl.responseDistribution')} subtitle={t('hitl.responseDistributionHint')}>
          <BarChart
            // 空档也画出来 —— 分布图的形状本身就是信息，
            // 「> 8h 一个都没有」和「这一档不存在」不是一回事
            data={hitl.responseBuckets
              .map((b) => ({
                label: b.label,
                value: b.count,
                display: t('hitl.timesCount', { count: b.count }),
                tone: b.label === '> 8h' ? ('waiting' as const) : ('primary' as const),
                ...(b.slowest
                  ? {
                      flag: {
                        icon: '🔴',
                        text: t('hitl.allOfKind', {
                          kind: decisionTypeLabel(b.slowestType ?? ''),
                        }),
                        tone: 'critical' as const,
                      },
                    }
                  : {}),
              }))}
            emptyHint={t('hitl.noHandled')}
          />
        </Card>
      </div>

      <Card
        title={t('hitl.overrideReasons')}
        subtitle={t('hitl.overrideSubtitle')}
      >
        <BarChart
          data={hitl.overrideReasons.map((r) => ({
            /** ★ 覆盖原因是枚举，界面按码取词 */
            label: overrideReasonLabel(r.category),
            value: r.count,
            display: t('hitl.timesPercent', { count: r.count, percent: r.percent }),
            tone: 'waiting' as const,
          }))}
          emptyHint={t('hitl.noOverrides')}
        />
      </Card>

      <p className="text-[11px] text-slate-400">
        {t('hitl.privacyNote')}
      </p>
    </div>
  );
}
