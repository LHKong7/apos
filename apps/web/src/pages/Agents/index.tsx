import { useT } from '../../lib/i18n';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { tokens } from '../../lib/format';
import { CardSkeleton, EmptyState, ErrorState } from '../../components/states';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * Agent 列表（页面文档 08 §4.1）。
 *
 * ★ 基调是「员工花名册」，不是「服务列表」。
 *   所以列的是负载、成功率、人工覆盖率、成本、负责人 ——
 *   跟看一个团队的工作情况一样，而不是看一堆进程的健康检查。
 */
export function AgentListPage() {
  const t = useT();
  const { projectId } = useParams<{ projectId: string }>();

  const list = useQuery({
    queryKey: qk.agentList(projectId),
    queryFn: () => api.agentList(projectId),
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-slate-900">{t('agents.title')}</h1>
          {projectId && (
            <Link
              to={`/projects/${projectId}`}
              className="text-xs text-slate-500 hover:text-slate-700"
            >
              {t('agents.backToOverview')}
            </Link>
          )}
        </div>
        {list.data && list.data.agents.length > 0 && (
          <p className="mt-1 text-[11px] text-slate-500">
            {t('agents.totals30d', {
              tokens: tokens(list.data.totals.tokens),
              runs: list.data.totals.runs,
            })}{' '}
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
            <EmptyState icon="🤖" message={t('agents.empty')} />
          )}

          {list.data && list.data.agents.length > 0 && (
            <section className="overflow-x-auto rounded border border-slate-200 bg-white">
              <Table className="w-full text-xs">
                <TableHeader>
                  <TableRow className="border-b border-slate-200 text-left text-[11px] text-slate-500">
                    <TableHead className="px-3 py-1.5 font-medium">{t('agents.col.name')}</TableHead>
                    <TableHead className="px-2 py-1.5 font-medium">{t('agents.col.type')}</TableHead>
                    <TableHead className="px-2 py-1.5 font-medium">{t('agents.col.status')}</TableHead>
                    <TableHead className="px-2 py-1.5 text-right font-medium">{t('agents.col.load')}</TableHead>
                    <TableHead className="px-2 py-1.5 text-right font-medium">{t('agents.col.runs')}</TableHead>
                    <TableHead className="px-2 py-1.5 text-right font-medium">{t('agents.col.successRate')}</TableHead>
                    <TableHead className="px-2 py-1.5 text-right font-medium" title={t('agentTab.firstTryOnly')}>
                      {t('agents.col.firstTry')}
                    </TableHead>
                    <TableHead className="px-2 py-1.5 text-right font-medium" title={t('agentTab.overrideHelp')}>
                      {t('agents.col.override')}
                    </TableHead>
                    <TableHead className="px-2 py-1.5 text-right font-medium">{t('agents.col.tokens')}</TableHead>
                    <TableHead className="px-3 py-1.5 font-medium">{t('agents.col.owner')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.data.agents.map((a) => (
                    <TableRow key={a.id} className="border-b border-slate-100 last:border-0">
                      <TableCell className="px-3 py-1.5">
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
                      </TableCell>
                      <TableCell className="px-2 py-1.5 text-slate-500">{a.type}</TableCell>
                      <TableCell className="px-2 py-1.5">
                        <span
                          className={clsx(
                            a.status === 'paused' ? 'text-amber-700' : 'text-green-700',
                          )}
                          title={a.pausedReason ?? undefined}
                        >
                          ● {a.status === 'paused' ? t('agents.paused') : t('agents.normal')}
                        </span>
                      </TableCell>
                      <TableCell className="px-2 py-1.5 text-right tabular-nums text-slate-600">
                        {a.load.running}/{a.load.max}
                      </TableCell>
                      <TableCell className="px-2 py-1.5 text-right tabular-nums text-slate-600">{a.runs}</TableCell>
                      <Cell value={a.successRate} warnBelow={0.8} />
                      <Cell value={a.firstTrySuccessRate} warnBelow={0.6} />
                      <Cell value={a.overrideRate} warnAbove={0.15} />
                      <TableCell className="px-2 py-1.5 text-right tabular-nums text-slate-600">
                        {tokens(a.tokens)}
                      </TableCell>
                      <TableCell className="px-3 py-1.5 text-slate-500">{a.ownerName}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
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
    return <TableCell className="px-2 py-1.5 text-right text-slate-300">—</TableCell>;
  }
  const warn =
    (warnBelow !== undefined && value < warnBelow) ||
    (warnAbove !== undefined && value > warnAbove);
  return (
    <TableCell className={clsx('px-2 py-1.5 text-right tabular-nums', warn ? 'text-amber-700' : 'text-slate-600')}>
      {warn && <span aria-hidden>⚠ </span>}
      {Math.round(value * 100)}%
    </TableCell>
  );
}
