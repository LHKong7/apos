import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { money } from '../../lib/format';
import { CardSkeleton, EmptyState, ErrorState } from '../../components/states';

/**
 * Agent 列表（页面文档 08 §4.1）。
 *
 * ★ 基调是「员工花名册」，不是「服务列表」。
 *   所以列的是负载、成功率、人工覆盖率、成本、负责人 ——
 *   跟看一个团队的工作情况一样，而不是看一堆进程的健康检查。
 */
export function AgentListPage() {
  const { projectId } = useParams<{ projectId: string }>();

  const list = useQuery({
    queryKey: qk.agentList(projectId),
    queryFn: () => api.agentList(projectId),
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-slate-900">Agent 团队</h1>
          {projectId && (
            <Link
              to={`/projects/${projectId}`}
              className="text-xs text-slate-500 hover:text-slate-700"
            >
              ← 项目总览
            </Link>
          )}
        </div>
        {list.data && list.data.agents.length > 0 && (
          <p className="mt-1 text-[11px] text-slate-500">
            近 30 天总成本 {money(String(list.data.totals.cost))} · 执行 {list.data.totals.runs} 次 ·
            平均成功率{' '}
            {list.data.totals.successRate === null
              ? '—'
              : `${Math.round(list.data.totals.successRate * 100)}%`}
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-3">
        <div className="mx-auto max-w-5xl">
          {list.isPending && <CardSkeleton />}
          {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
          {list.data && list.data.agents.length === 0 && (
            <EmptyState icon="🤖" message="还没有注册任何 Agent" />
          )}

          {list.data && list.data.agents.length > 0 && (
            <section className="overflow-x-auto rounded border border-slate-200 bg-white">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-[11px] text-slate-500">
                    <th className="px-3 py-1.5 font-medium">名称</th>
                    <th className="px-2 py-1.5 font-medium">类型</th>
                    <th className="px-2 py-1.5 font-medium">状态</th>
                    <th className="px-2 py-1.5 text-right font-medium">负载</th>
                    <th className="px-2 py-1.5 text-right font-medium">执行</th>
                    <th className="px-2 py-1.5 text-right font-medium">成功率</th>
                    <th className="px-2 py-1.5 text-right font-medium" title="只看第一次尝试">
                      首次成功
                    </th>
                    <th className="px-2 py-1.5 text-right font-medium" title="任务被人手动改过状态的比例">
                      人工覆盖
                    </th>
                    <th className="px-2 py-1.5 text-right font-medium">成本</th>
                    <th className="px-3 py-1.5 font-medium">负责人</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.agents.map((a) => (
                    <tr key={a.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-3 py-1.5">
                        <Link
                          to={
                            projectId
                              ? `/projects/${projectId}/agents/${a.id}`
                              : `/agents/${a.id}`
                          }
                          className="text-slate-800 underline-offset-2 hover:underline"
                        >
                          🤖 {a.name}
                        </Link>
                        {a.model && <span className="ml-1 text-[11px] text-slate-400">{a.model}</span>}
                      </td>
                      <td className="px-2 py-1.5 text-slate-500">{a.type}</td>
                      <td className="px-2 py-1.5">
                        <span
                          className={clsx(
                            a.status === 'paused' ? 'text-amber-700' : 'text-green-700',
                          )}
                          title={a.pausedReason ?? undefined}
                        >
                          ● {a.status === 'paused' ? '已暂停' : '正常'}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">
                        {a.load.running}/{a.load.max}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">{a.runs}</td>
                      <Cell value={a.successRate} warnBelow={0.8} />
                      <Cell value={a.firstTrySuccessRate} warnBelow={0.6} />
                      <Cell value={a.overrideRate} warnAbove={0.15} />
                      <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">
                        {money(String(a.cost))}
                      </td>
                      <td className="px-3 py-1.5 text-slate-500">{a.ownerName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function Cell({
  value,
  warnBelow,
  warnAbove,
}: {
  value: number | null;
  warnBelow?: number;
  warnAbove?: number;
}) {
  if (value === null) {
    return <td className="px-2 py-1.5 text-right text-slate-300">—</td>;
  }
  const warn =
    (warnBelow !== undefined && value < warnBelow) ||
    (warnAbove !== undefined && value > warnAbove);
  return (
    <td className={clsx('px-2 py-1.5 text-right tabular-nums', warn ? 'text-amber-700' : 'text-slate-600')}>
      {warn && <span aria-hidden>⚠ </span>}
      {Math.round(value * 100)}%
    </td>
  );
}
