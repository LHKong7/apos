import { useT } from '../../lib/i18n';
import clsx from 'clsx';
import type { Analytics, AgentPerf } from '@apos/domain';
import { BarChart, StatTile } from '../../features/analytics/charts';
import { tokens } from '../../lib/format';
import { Card } from './Card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * Agent 效能（页面文档 12 §5.4）。
 *
 * ★ 横向对比是这个 Tab 的全部价值。
 *   单个 Agent「成功率 92%」既不知道是好是坏，也不指向任何动作；
 *   两个摆在一起才会得到「调度权重该往哪边挪」这种能执行的结论。
 *   所以主体是一张表，不是一堆卡片。
 */
export function AgentTab({ data }: { data: Analytics }) {
  const t = useT();
  const { agent, deltas } = data;

  if (agent.agents.length === 0) {
    return (
      <p className="rounded border border-slate-200 bg-white px-3 py-6 text-center text-xs text-slate-400">
        {t('agentTab.noRuns')}
      </p>
    );
  }

  const best = pickBest(agent.agents);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <StatTile
          label={t('agentTab.avgSuccess')}
          value={`${Math.round(weighted(agent.agents, (a) => a.successRate) * 100)}%`}
          sub={t('agentTab.runsCount', { count: agent.agents.reduce((s, a) => s + a.runs, 0) })}
          delta={deltas?.agentSuccessRate}
          hint={t('agentTab.avgSuccessHelp')}
        />
        <StatTile
          label={t('agentTab.avgFirstTry')}
          value={`${Math.round(weighted(agent.agents, (a) => a.firstTrySuccessRate) * 100)}%`}
          sub={t('agentTab.firstTryHint')}
          hint={t('agentTab.avgFirstTryHelp')}
        />
        <StatTile
          label={t('agentTab.avgTokens')}
          value={tokens(weighted(agent.agents, (a) => a.avgTokens))}
          hint={t('agentTab.avgTokensHelp')}
        />
      </div>

      <Card title={t('agentTab.comparison')} subtitle={t('agentTab.comparisonHint')}>
        <div className="overflow-x-auto">
          <Table className="w-full text-xs">
            <TableHeader>
              <TableRow className="border-b border-slate-200 text-left text-[11px] text-slate-500">
                <TableHead className="py-1 pr-2 font-medium">Agent</TableHead>
                <TableHead className="py-1 px-2 text-right font-medium">{t('agentTab.runs')}</TableHead>
                <TableHead className="py-1 px-2 text-right font-medium">{t('agentTab.successRate')}</TableHead>
                <TableHead className="py-1 px-2 text-right font-medium" title={t('agentTab.firstTryOnly')}>
                  {t('agents.col.firstTry')}
                </TableHead>
                <TableHead className="py-1 px-2 text-right font-medium" title={t('agentTab.overrideHelp')}>
                  {t('agents.col.override')}
                </TableHead>
                <TableHead className="py-1 px-2 text-right font-medium">{t('agentTab.avgTokensShort')}</TableHead>
                <TableHead className="py-1 pl-2 text-right font-medium">{t('agentTab.avgDuration')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agent.agents.map((a) => (
                <TableRow key={a.agentId} className="border-b border-slate-100">
                  <TableCell className="py-1 pr-2">
                    <span className="text-slate-800">{a.name}</span>
                    {a.model && <span className="ml-1 text-[11px] text-slate-400">{a.model}</span>}
                  </TableCell>
                  <TableCell className="py-1 px-2 text-right tabular-nums text-slate-600">{a.runs}</TableCell>
                  <Cell value={`${Math.round(a.successRate * 100)}%`} best={best.successRate.has(a.agentId)} warn={a.successRate < 0.8} />
                  <Cell
                    value={`${Math.round(a.firstTrySuccessRate * 100)}%`}
                    best={best.firstTrySuccessRate.has(a.agentId)}
                    warn={a.firstTrySuccessRate < 0.6}
                  />
                  <Cell
                    value={`${Math.round(a.overrideRate * 100)}%`}
                    best={best.overrideRate.has(a.agentId)}
                    warn={a.overrideRate > 0.15}
                  />
                  <Cell value={tokens(a.avgTokens)} best={best.avgTokens.has(a.agentId)} />
                  <Cell
                    value={a.avgMinutes === null ? '—' : `${a.avgMinutes}m`}
                    best={best.avgMinutes.has(a.agentId)}
                  />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {agent.dominance && (
          <p className="mt-2 rounded bg-sky-50 px-2 py-1 text-[11px] text-sky-900">
            {t('agentTab.dominance', {
              better: agent.dominance.betterName,
              worse: agent.dominance.worseName,
            })}
          </p>
        )}
      </Card>

      <Card title={t('agentTab.failureReasons')} subtitle={t('agentTab.failureReasonsHint')}>
        <BarChart
          data={agent.failureReasons.map((r) => ({
            label: r.label,
            value: r.count,
            display: t('hitl.timesPercent', { count: r.count, percent: r.percent }),
            tone: 'waiting' as const,
          }))}
          emptyHint={t('agentTab.noFailures')}
        />
      </Card>
    </div>
  );
}

function Cell({ value, best, warn }: { value: string; best?: boolean; warn?: boolean }) {
  return (
    <TableCell
      className={clsx(
        'py-1 px-2 text-right tabular-nums',
        best ? 'font-semibold text-slate-900' : warn ? 'text-amber-700' : 'text-slate-600',
      )}
    >
      {warn && <span aria-hidden>⚠ </span>}
      {value}
    </TableCell>
  );
}

/**
 * 每列最优是谁。成本与耗时越低越好，其余越高越好。
 *
 * 并列时全部标出 —— 只加粗第一个，读者会以为它比另一个 0% 更好，
 * 而那只是数组顺序。
 */
function pickBest(agents: AgentPerf[]) {
  const by = (key: keyof AgentPerf, lower: boolean): Set<string> => {
    const values = agents
      .map((a) => a[key])
      .filter((v): v is number => typeof v === 'number');
    if (values.length === 0) return new Set();
    const target = lower ? Math.min(...values) : Math.max(...values);
    return new Set(agents.filter((a) => a[key] === target).map((a) => a.agentId));
  };

  return {
    successRate: by('successRate', false),
    firstTrySuccessRate: by('firstTrySuccessRate', false),
    overrideRate: by('overrideRate', true),
    avgTokens: by('avgTokens', true),
    avgMinutes: by('avgMinutes', true),
  };
}

function weighted(agents: AgentPerf[], pick: (a: AgentPerf) => number): number {
  const runs = agents.reduce((s, a) => s + a.runs, 0);
  if (runs === 0) return 0;
  return agents.reduce((s, a) => s + pick(a) * a.runs, 0) / runs;
}
