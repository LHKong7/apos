import { useT } from '../../lib/i18n';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { money, relativeTime } from '../../lib/format';

/**
 * 这条需求的历次分析 / 规划执行。
 *
 * ★★ 「AI 分析过程看不到」曾经有两层原因，这一块解决的是第二层。
 *
 *   第一层是规划调用根本不落库 —— 它只活在内存里，事后什么都查不到。
 *   那一层已经修了（规划 Run 现在是真的 agent_runs 记录，事件也进 run_events）。
 *
 *   第二层是**没有入口**：记录躺在库里，而需求页上没有任何地方指向它们。
 *   只修第一层的话，可审计只做了一半 —— 数据在，但没人找得到。
 *
 * ★ 每一条都链到 Run 详情页：那里已经有完整的时间线、成本明细与错误自述，
 *   不需要在这里再造一套。这一块只负责「从需求走到那一页」。
 */
export function AnalysisRuns({ requirementId }: { requirementId: string }) {
  const t = useT();
  const q = useQuery({
    queryKey: qk.requirementRuns(requirementId),
    queryFn: () => api.requirementRuns(requirementId),
    /**
     * ★ 分析在跑的时候要能看到它在动。轮询而不是 SSE：规划 Run 不经过
     *   领域事件总线（它没有工作项，channelsFor 算不出频道），
     *   为一块辅助面板去新开一条频道不划算。
     */
    refetchInterval: (query) =>
      query.state.data?.runs.some((r) => r.status === 'running' || r.status === 'dispatching')
        ? 3000
        : false,
  });

  const runs = q.data?.runs ?? [];
  if (runs.length === 0) return null;

  return (
    <section className="rounded border border-slate-200 bg-white px-3 py-2">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
        {t('requirement.runs.title', { count: runs.length })}
      </h3>
      <ul className="mt-1 space-y-0.5">
        {runs.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 text-[11px]">
            <span
              className={clsx(
                'w-14 shrink-0',
                r.status === 'completed'
                  ? 'text-green-700'
                  : r.status === 'failed' || r.status === 'terminated'
                    ? 'text-red-700'
                    : 'text-slate-500',
              )}
            >
              {r.status}
            </span>
            <span className="min-w-0 flex-1 truncate text-slate-700">{r.goal}</span>
            {r.model && <span className="shrink-0 font-mono text-slate-400">{r.model}</span>}
            <span className="shrink-0 tabular-nums text-slate-500">{money(String(r.cost))}</span>
            <span className="shrink-0 text-slate-400">
              {r.startedAt ? relativeTime(r.startedAt) : '—'}
            </span>
            {/* ★ 失败原因就地显示一行 —— 点进去才知道为什么失败太晚了 */}
            {r.errorMessage && (
              <span className="w-full truncate text-red-600">{r.errorMessage}</span>
            )}
            <Link to={`/runs/${r.id}`} className="shrink-0 text-sky-700 underline">
              {t('requirement.runs.detail')}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
