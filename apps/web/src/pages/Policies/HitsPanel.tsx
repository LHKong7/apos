import { useT, type MessageKey } from '../../lib/i18n';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { duration, relativeTime, riskLabel } from '../../lib/format';
import { Modal } from '../../features/work-item/ManualMoveDialog';
import { CardSkeleton, ErrorState } from '../../components/states';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/** 操作类型 / 环境 → 词条键。模块级常量存键不存译文 */
const OPERATION_KEYS: Record<string, MessageKey> = {
  read: 'opType.read',
  code_change: 'opType.code_change',
  db_ddl: 'opType.schema_change',
  db_dml: 'opType.data_change',
  deploy: 'opType.deploy',
  delete_resource: 'opType.delete_resource',
  permission_change: 'opType.permission_change',
  access_sensitive_data: 'opType.access_sensitive',
  send_external: 'opType.external_send',
  payment: 'opType.payment',
  security_policy_change: 'opType.security_policy_change',
  high_cost_resource: 'opType.high_cost',
};

const ENV_KEYS: Record<string, MessageKey> = {
  dev: 'env.dev',
  test: 'env.test',
  staging: 'env.staging',
  production: 'env.prod',
};

/**
 * 一条规则的命中明细（页面文档 13）。
 *
 * ★ 「近 30 天命中 47 次」是个死数字。看不到是哪 47 次的规则等于无法审计，
 *   而无法审计的规则没人敢改 —— 最后要么一直留着（哪怕它已经错了），
 *   要么被整条删掉。
 *
 * ★ 这一屏真正要回答的不是「命中了几次」，是**「这条规则做对了没有」**。
 *   所以结论放在最上面、结局是主列。
 *
 * ★ 拦人的规则和放行的规则要用完全不同的标准看：
 *   拦人的看批准率 —— 全批说明它在问一个答案已知的问题，常驳说明它拦对了；
 *   放行的根本不产生决策，只能看它放过去的事后来有没有被人纠正。
 *   用同一套话术评价两类规则，说出来的必然有一半是废话。
 */
export function HitsPanel({
  projectId,
  policyId,
  policyName,
  onClose,
}: {
  projectId: string;
  policyId: string;
  policyName: string;
  onClose: () => void;
}) {
  const t = useT();
  const q = useQuery({
    queryKey: qk.policyHits(projectId, policyId),
    queryFn: () => api.policyHits(projectId, policyId),
  });

  return (
    // 宽度与滚动都归 Modal 管：自己再套一层会长出第二根滚动条
    <Modal onClose={onClose} title={t('policy.hits.title')} width="lg">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">
          {t('policy.hits.heading', { name: policyName })}
        </h2>

        {q.isPending && <CardSkeleton />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}

        {q.data && (
          <>
            {/* ★ 结论在最上面。让用户从百分比自己推一遍是多余的一步 */}
            <p
              className={clsx(
                'mt-1.5 rounded px-2 py-1.5 text-xs',
                // 两类「该动手了」的信号：全批的门禁规则，和被事后纠正过的放行规则
                q.data.stats.approvalRate === 1 || q.data.overriddenAfterPass > 0
                  ? 'bg-amber-50 text-amber-900'
                  : 'bg-slate-50 text-slate-700',
              )}
            >
              {q.data.verdict}
            </p>

            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-slate-500">
              <span>{t('hits.last30d', { count: q.data.stats.hits })}</span>
              {q.data.stats.byAction.map((a) => (
                <span key={a.label}>
                  {a.label} {a.count}
                </span>
              ))}
              {q.data.stats.decisionsCreated > 0 && (
                <span>{t('hits.decisionsCreated', { count: q.data.stats.decisionsCreated })}</span>
              )}
              {q.data.stats.approvalRate !== null && (
                <span>{t('hits.approvalRate', { percent: Math.round(q.data.stats.approvalRate * 100) })}</span>
              )}
              {q.data.stats.avgWaitMinutes !== null && (
                <span>{t('hits.avgWait', { time: duration(q.data.stats.avgWaitMinutes) })}</span>
              )}
              {q.data.overriddenAfterPass > 0 && (
                <span className="text-amber-700">
                  {t('hits.overriddenAfterPass', { count: q.data.overriddenAfterPass })}
                </span>
              )}
            </div>

            {q.data.hits.length === 0 ? (
              <p className="mt-2 rounded border border-dashed border-slate-300 px-3 py-4 text-center text-xs text-slate-500">
                {t('hits.none30d')}
              </p>
            ) : (
              <Table className="mt-2 w-full text-[11px]">
                <TableHeader>
                  <TableRow className="border-b border-slate-200 text-left text-slate-500">
                    <TableHead className="py-1 font-medium">{t('policy.hits.time')}</TableHead>
                    <TableHead className="py-1 font-medium">{t('policy.hits.workItem')}</TableHead>
                    <TableHead className="py-1 font-medium">{t('policy.hits.context')}</TableHead>
                    <TableHead className="py-1 font-medium">{t('policy.hits.verdict')}</TableHead>
                    {/* ★ 结局是主列，不是附注 —— 这一页的结论全靠它 */}
                    <TableHead className="py-1 font-medium">{t('policy.hits.outcome')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {q.data.hits.map((h) => (
                    <TableRow key={h.eventId} className="border-b border-slate-100 last:border-0">
                      <TableCell className="py-1 pr-2 text-slate-400" title={h.at}>
                        {relativeTime(h.at)}
                      </TableCell>
                      <TableCell className="py-1 pr-2">
                        <Link
                          to={`/projects/${projectId}/board?item=${h.workItemId}`}
                          className="text-slate-700 underline-offset-2 hover:underline"
                        >
                          {h.workItemTitle}
                        </Link>
                      </TableCell>
                      <TableCell className="py-1 pr-2 text-slate-500">
                        {h.context ? (
                          <>
                            {OPERATION_KEYS[h.context.operationType]
                              ? t(OPERATION_KEYS[h.context.operationType]!)
                              : h.context.operationType}
                            {h.context.environment && (
                              <>
                                {' · '}
                                {ENV_KEYS[h.context.environment]
                                  ? t(ENV_KEYS[h.context.environment]!)
                                  : h.context.environment}
                              </>
                            )}
                            {' · '}
                            {riskLabel(h.context.riskLevel)}
                          </>
                        ) : (
                          // 没有快照的历史事件，如实说而不是留空让人以为没触发条件
                          <span className="text-slate-400">{t('policy.hits.noContext')}</span>
                        )}
                      </TableCell>
                      <TableCell className="py-1 pr-2 text-slate-600">{h.actionLabel}</TableCell>
                      <TableCell className="py-1">
                        {!h.decision ? (
                          <span className="text-slate-300">—</span>
                        ) : (
                          <span
                            className={clsx(
                              h.decision.status === 'rejected'
                                ? 'text-red-700'
                                : h.decision.status === 'pending'
                                  ? 'text-amber-700'
                                  : 'text-slate-600',
                            )}
                          >
                            {h.decision.statusLabel}
                            {h.decision.resolvedBy && (
                              <span className="ml-1 text-slate-400">{h.decision.resolvedBy}</span>
                            )}
                            {h.decision.waitMinutes !== null && (
                              <span className="ml-1 text-slate-400">
                                {t('hits.waited', { time: duration(h.decision.waitMinutes) })}
                              </span>
                            )}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            {q.data.truncated && (
              <p className="mt-1 text-[11px] text-slate-400">
                {t('hits.truncated')}
              </p>
            )}
          </>
        )}

        <div className="mt-2">
          <Button variant="outline" size="sm"
            onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
