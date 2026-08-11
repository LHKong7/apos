import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { CardSkeleton, EmptyState, ErrorState } from '../../components/states';
import { relativeTime } from '../../lib/format';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  analyzing: '分析中',
  clarifying: '待澄清',
  awaiting_approval: '待确认',
  approved: '已确认',
  rejected: '已驳回',
  on_hold: '暂缓',
};

/**
 * 需求列表 + 新建（页面文档 03 §4.1）。
 *
 * ★ MVP 只做「直接描述」一种录入方式。
 *   对话式录入需要多轮状态同步、上传文档需要解析、外部导入依赖集成配置 ——
 *   三样都不是小工程，而它们解决的是「录入更顺手」，
 *   不是「录入之后 AI 理解得对不对」。后者才是这条链路的价值所在。
 */
export function RequirementListPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: qk.requirements(projectId!),
    queryFn: () => api.requirements(projectId!),
    enabled: Boolean(projectId),
  });

  const create = useMutation({
    mutationFn: () => api.createRequirement(projectId!, { rawInput: draft.trim() }),
    onSuccess: (r) => navigate(`/projects/${projectId}/requirements/${r.requirement.id}`),
    onError: (e) => setError(e instanceof ApiError ? e.message : '创建失败'),
  });

  if (!projectId) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-slate-900">需求</h1>
          <Link
            to={`/projects/${projectId}/board`}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            ← 回到看板
          </Link>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-3">
        <div className="mx-auto max-w-3xl space-y-3">
          <section className="rounded border border-slate-200 bg-white px-3 py-2">
            <h2 className="text-xs font-medium text-slate-700">描述你想要什么，用自己的话就行</h2>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={5}
              placeholder="例如：现在用户查订单要等好几秒，客服天天投诉。想优化一下，最好能支持按手机号、订单号、时间段搜。"
              className="mt-1.5"
            />
            <div className="mt-1.5 flex items-center gap-2">
              <Button variant="neutral" size="sm"
                onClick={() => create.mutate()}
                disabled={draft.trim().length === 0 || create.isPending}>
                {create.isPending ? '创建中…' : '下一步：AI 分析 →'}
              </Button>
              {/* ★ 不阻止短输入，只如实说明后果 */}
              {draft.trim().length > 0 && draft.trim().length < 20 && (
                <span className="text-[11px] text-amber-700">
                  描述较少，AI 会问更多问题
                </span>
              )}
              <span className="ml-auto text-[11px] text-slate-400">
                MVP 只支持直接描述；对话式录入与文档上传尚未实现
              </span>
            </div>
            {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
          </section>

          {list.isPending && <CardSkeleton />}
          {list.isError && (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          )}

          {list.data && list.data.requirements.length === 0 && (
            <EmptyState icon="📝" message="这个项目还没有需求" hint="上面写一段就能开始" />
          )}

          {list.data && list.data.requirements.length > 0 && (
            <section className="rounded border border-slate-200 bg-white">
              <h2 className="border-b border-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700">
                已有需求（{list.data.requirements.length}）
              </h2>
              <ul>
                {list.data.requirements.map((r) => (
                  <li key={r.id} className="border-b border-slate-100 last:border-0">
                    <button
                      type="button"
                      onClick={() =>
                        // 已经生成过计划的，直接去计划页 —— 用户此刻要看的是计划
                        r.latestPlanId
                          ? navigate(`/projects/${projectId}/plans/${r.latestPlanId}`)
                          : navigate(`/projects/${projectId}/requirements/${r.id}`)
                      }
                      className="flex w-full flex-wrap items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-slate-50"
                    >
                      <span className="min-w-0 flex-1 truncate text-slate-800">{r.title}</span>
                      <span
                        className={clsx(
                          'rounded px-1.5 py-0.5 text-[11px]',
                          r.status === 'approved'
                            ? 'bg-green-100 text-green-800'
                            : r.status === 'rejected'
                              ? 'bg-red-100 text-red-800'
                              : 'bg-slate-100 text-slate-600',
                        )}
                      >
                        {STATUS_LABELS[r.status] ?? r.status}
                      </span>
                      {r.latestPlanId && (
                        <span className="text-[11px] text-slate-500">
                          计划 {r.latestPlanStatus === 'approved' ? '已批准' : '待批准'}
                        </span>
                      )}
                      <span className="text-[11px] text-slate-400">
                        {relativeTime(r.createdAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
