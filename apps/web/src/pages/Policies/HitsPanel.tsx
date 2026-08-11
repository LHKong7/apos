import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { duration, relativeTime, riskLabel } from '../../lib/format';
import { Modal } from '../../features/work-item/ManualMoveDialog';
import { CardSkeleton, ErrorState } from '../../components/states';
import { Button } from '@/components/ui/button';

const OPERATION_LABELS: Record<string, string> = {
  read: '读取',
  code_change: '改代码',
  db_ddl: '库结构变更',
  db_dml: '库数据变更',
  deploy: '部署发布',
  delete_resource: '删除资源',
  permission_change: '权限变更',
  access_sensitive_data: '访问敏感数据',
  send_external: '对外发送',
  payment: '付款',
  security_policy_change: '安全策略变更',
  high_cost_resource: '高成本资源',
};

const ENV_LABELS: Record<string, string> = {
  dev: '开发',
  test: '测试',
  staging: '预生产',
  production: '生产',
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
  const q = useQuery({
    queryKey: qk.policyHits(projectId, policyId),
    queryFn: () => api.policyHits(projectId, policyId),
  });

  return (
    <Modal onClose={onClose} title="策略命中明细">
      <div className="max-h-[80vh] w-[42rem] max-w-full overflow-y-auto">
        <h2 className="text-sm font-semibold text-slate-900">命中明细 · {policyName}</h2>

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
              <span>近 30 天命中 {q.data.stats.hits} 次</span>
              {q.data.stats.byAction.map((a) => (
                <span key={a.label}>
                  {a.label} {a.count}
                </span>
              ))}
              {q.data.stats.decisionsCreated > 0 && (
                <span>生成决策 {q.data.stats.decisionsCreated}</span>
              )}
              {q.data.stats.approvalRate !== null && (
                <span>批准率 {Math.round(q.data.stats.approvalRate * 100)}%</span>
              )}
              {q.data.stats.avgWaitMinutes !== null && (
                <span>平均等待 {duration(q.data.stats.avgWaitMinutes)}</span>
              )}
              {q.data.overriddenAfterPass > 0 && (
                <span className="text-amber-700">
                  放行后被人工纠正 {q.data.overriddenAfterPass}
                </span>
              )}
            </div>

            {q.data.hits.length === 0 ? (
              <p className="mt-2 rounded border border-dashed border-slate-300 px-3 py-4 text-center text-xs text-slate-500">
                近 30 天没有命中记录
              </p>
            ) : (
              <table className="mt-2 w-full text-[11px]">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="py-1 font-medium">时间</th>
                    <th className="py-1 font-medium">任务</th>
                    <th className="py-1 font-medium">触发上下文</th>
                    <th className="py-1 font-medium">判定</th>
                    {/* ★ 结局是主列，不是附注 —— 这一页的结论全靠它 */}
                    <th className="py-1 font-medium">结局</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.hits.map((h) => (
                    <tr key={h.eventId} className="border-b border-slate-100 last:border-0">
                      <td className="py-1 pr-2 text-slate-400" title={h.at}>
                        {relativeTime(h.at)}
                      </td>
                      <td className="py-1 pr-2">
                        <Link
                          to={`/projects/${projectId}/board?item=${h.workItemId}`}
                          className="text-slate-700 underline-offset-2 hover:underline"
                        >
                          {h.workItemTitle}
                        </Link>
                      </td>
                      <td className="py-1 pr-2 text-slate-500">
                        {h.context ? (
                          <>
                            {OPERATION_LABELS[h.context.operationType] ?? h.context.operationType}
                            {h.context.environment && (
                              <> · {ENV_LABELS[h.context.environment] ?? h.context.environment}</>
                            )}
                            {' · '}
                            {riskLabel(h.context.riskLevel)}
                          </>
                        ) : (
                          // 没有快照的历史事件，如实说而不是留空让人以为没触发条件
                          <span className="text-slate-400">未记录上下文</span>
                        )}
                      </td>
                      <td className="py-1 pr-2 text-slate-600">{h.actionLabel}</td>
                      <td className="py-1">
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
                                等 {duration(h.decision.waitMinutes)}
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {q.data.truncated && (
              <p className="mt-1 text-[11px] text-slate-400">
                只显示最近 100 条 —— 更早的命中在事件流里，没有丢
              </p>
            )}
          </>
        )}

        <div className="mt-2">
          <Button variant="outline" size="sm"
            onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </Modal>
  );
}
