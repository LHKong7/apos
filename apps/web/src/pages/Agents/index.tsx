import { useT } from '../../lib/i18n';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { tokens } from '../../lib/format';
import { CardSkeleton, EmptyState, ErrorState } from '../../components/states';
import { AgentLifecycleBadge, ProjectMembershipBadge } from '../../components/AgentStatus';
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
                    {/*
                      ★★ 十列压到七列。
                        「First-try success」「Human override」这种复合词在
                        表头里一定会被截断，而截断之后剩下的半个词
                        （「First-try」「Human」）读不出原意（问题记录 #48）。
                        三个质量指标合成一栏「质量」，用 `a/b/c` 的写法排在一起 ——
                        它们本来就是一起看的：成功率高但一次通过率低，
                        说的是「它总能做完，但总要返工」。
                      ★ 类型与型号并进名字那一栏（它们是这个 Agent 的属性，不是
                        可比较的指标），负责人也一样。
                      ★ 第一列 sticky：横向滚动时不能连「这是哪个 Agent」都看不见。
                    */}
                    <TableHead className="sticky left-0 z-10 bg-white px-3 py-1.5 font-medium">
                      {t('agents.col.name')}
                    </TableHead>
                    <TableHead className="px-2 py-1.5 font-medium">
                      {t('agents.col.lifecycle')}
                    </TableHead>
                    <TableHead className="px-2 py-1.5 font-medium">
                      {t('agents.col.membership')}
                    </TableHead>
                    <TableHead className="px-2 py-1.5 text-right font-medium">{t('agents.col.load')}</TableHead>
                    <TableHead className="px-2 py-1.5 text-right font-medium">{t('agents.col.runs')}</TableHead>
                    <TableHead
                      className="px-2 py-1.5 text-right font-medium"
                      title={t('agents.qualityHint')}
                    >
                      {t('agents.col.quality')}
                    </TableHead>
                    <TableHead className="px-2 py-1.5 text-right font-medium">{t('agents.col.tokens')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.data.agents.map((a) => (
                    <TableRow key={a.id} className="border-b border-slate-100 last:border-0">
                      <TableCell className="sticky left-0 z-10 bg-white px-3 py-1.5">
                        <Link
                          to={
                            projectId
                              ? `/projects/${projectId}/agents/${a.id}`
                              : `/agents/${a.id}`
                          }
                          className="text-slate-800 underline-offset-2 hover:underline"
                        >
                          <span aria-hidden>🤖</span> {a.name}
                        </Link>
                        <span className="block text-[11px] text-slate-400">
                          {[a.type, a.model, a.ownerName].filter(Boolean).join(' · ')}
                        </span>
                      </TableCell>
                      <TableCell className="px-2 py-1.5">
                        <AgentLifecycleBadge status={a.status} reason={a.pausedReason} />
                      </TableCell>
                      <TableCell className="px-2 py-1.5">
                        <ProjectMembershipBadge inProject={a.inProject} />
                      </TableCell>
                      <TableCell className="px-2 py-1.5 text-right tabular-nums text-slate-600">
                        {a.load.running}/{a.load.max}
                      </TableCell>
                      <TableCell className="px-2 py-1.5 text-right tabular-nums text-slate-600">{a.runs}</TableCell>
                      <TableCell
                        className="px-2 py-1.5 text-right"
                        title={t('agents.qualityHint')}
                      >
                        <span className="tabular-nums">
                          <Pct value={a.successRate} warnBelow={0.8} />
                          <span className="text-slate-300"> / </span>
                          <Pct value={a.firstTrySuccessRate} warnBelow={0.6} />
                          <span className="text-slate-300"> / </span>
                          <Pct value={a.overrideRate} warnAbove={0.15} />
                        </span>
                      </TableCell>
                      <TableCell className="px-2 py-1.5 text-right tabular-nums text-slate-600">
                        {tokens(a.tokens)}
                      </TableCell>
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

/**
 * 一个百分比。
 *
 * ★ 曾经是整个 `<TableCell>`，三个指标各占一列。合成一栏之后它只负责
 *   那一个数字与它的警戒色 —— 「几号算不好」这条判据没变，
 *   变的只是它们排在一起了。
 */
function Pct({
  value,
  warnBelow,
  warnAbove,
}: {
  value: number | null;
  warnBelow?: number;
  warnAbove?: number;
}) {
  if (value === null) return <span className="text-slate-300">—</span>;
  const warn =
    (warnBelow !== undefined && value < warnBelow) ||
    (warnAbove !== undefined && value > warnAbove);
  return (
    <span className={warn ? 'font-medium text-amber-700' : 'text-slate-600'}>
      {Math.round(value * 100)}%
    </span>
  );
}
