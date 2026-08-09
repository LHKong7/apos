import clsx from 'clsx';
import type { Analytics, AgentPerf } from '@apos/domain';
import { BarChart, StatTile } from '../../features/analytics/charts';
import { money } from '../../lib/format';
import { Card } from './Card';

/**
 * Agent 效能（页面文档 12 §5.4）。
 *
 * ★ 横向对比是这个 Tab 的全部价值。
 *   单个 Agent「成功率 92%」既不知道是好是坏，也不指向任何动作；
 *   两个摆在一起才会得到「调度权重该往哪边挪」这种能执行的结论。
 *   所以主体是一张表，不是一堆卡片。
 */
export function AgentTab({ data }: { data: Analytics }) {
  const { agent, deltas } = data;

  if (agent.agents.length === 0) {
    return (
      <p className="rounded border border-slate-200 bg-white px-3 py-6 text-center text-xs text-slate-400">
        这段时间没有 Agent 执行记录
      </p>
    );
  }

  const best = pickBest(agent.agents);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <StatTile
          label="平均成功率"
          value={`${Math.round(weighted(agent.agents, (a) => a.successRate) * 100)}%`}
          sub={`${agent.agents.reduce((s, a) => s + a.runs, 0)} 次执行`}
          delta={deltas?.agentSuccessRate}
          hint="按执行次数加权，避免只跑了两次的 Agent 拉高整体。"
        />
        <StatTile
          label="平均首次成功率"
          value={`${Math.round(weighted(agent.agents, (a) => a.firstTrySuccessRate) * 100)}%`}
          sub="重试掩盖的问题看这个"
          hint="只统计 attempt = 1 的执行。总成功率会被重试拉回去，首次成功率才反映「一把做对」的能力。"
        />
        <StatTile
          label="平均单次成本"
          value={money(String(weighted(agent.agents, (a) => a.avgCost)))}
          hint="窗口内全部 Run 的成本 ÷ Run 数。"
        />
      </div>

      <Card title="Agent 效能对比" subtitle="每列最优的一项加粗，横着看差距">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-left text-[11px] text-slate-500">
                <th className="py-1 pr-2 font-medium">Agent</th>
                <th className="py-1 px-2 text-right font-medium">执行</th>
                <th className="py-1 px-2 text-right font-medium">成功率</th>
                <th className="py-1 px-2 text-right font-medium" title="只看第一次尝试">
                  首次成功
                </th>
                <th className="py-1 px-2 text-right font-medium" title="任务被人手动改过状态的比例">
                  人工覆盖
                </th>
                <th className="py-1 px-2 text-right font-medium">均成本</th>
                <th className="py-1 pl-2 text-right font-medium">均耗时</th>
              </tr>
            </thead>
            <tbody>
              {agent.agents.map((a) => (
                <tr key={a.agentId} className="border-b border-slate-100">
                  <td className="py-1 pr-2">
                    <span className="text-slate-800">{a.name}</span>
                    {a.model && <span className="ml-1 text-[11px] text-slate-400">{a.model}</span>}
                  </td>
                  <td className="py-1 px-2 text-right tabular-nums text-slate-600">{a.runs}</td>
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
                  <Cell value={money(String(a.avgCost))} best={best.avgCost.has(a.agentId)} />
                  <Cell
                    value={a.avgMinutes === null ? '—' : `${a.avgMinutes}m`}
                    best={best.avgMinutes.has(a.agentId)}
                  />
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {agent.dominance && (
          <p className="mt-2 rounded bg-sky-50 px-2 py-1 text-[11px] text-sky-900">
            💡 {agent.dominance.betterName} 在成功率、成本、耗时上全面优于{' '}
            {agent.dominance.worseName} —— 建议调整调度权重，或对比两者的配置差异。
            只赢一两项不会出现在这里，那属于权衡而非结论。
          </p>
        )}
      </Card>

      <Card title="失败原因分布" subtitle="来自 Agent 协议的错误分类，不是从日志里猜的">
        <BarChart
          data={agent.failureReasons.map((r) => ({
            label: r.label,
            value: r.count,
            display: `${r.count} 次 ${r.percent}%`,
            tone: 'waiting' as const,
          }))}
          emptyHint="这段时间没有失败的执行"
        />
      </Card>
    </div>
  );
}

function Cell({ value, best, warn }: { value: string; best?: boolean; warn?: boolean }) {
  return (
    <td
      className={clsx(
        'py-1 px-2 text-right tabular-nums',
        best ? 'font-semibold text-slate-900' : warn ? 'text-amber-700' : 'text-slate-600',
      )}
    >
      {warn && <span aria-hidden>⚠ </span>}
      {value}
    </td>
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
    avgCost: by('avgCost', true),
    avgMinutes: by('avgMinutes', true),
  };
}

function weighted(agents: AgentPerf[], pick: (a: AgentPerf) => number): number {
  const runs = agents.reduce((s, a) => s + a.runs, 0);
  if (runs === 0) return 0;
  return agents.reduce((s, a) => s + pick(a) * a.runs, 0) / runs;
}
