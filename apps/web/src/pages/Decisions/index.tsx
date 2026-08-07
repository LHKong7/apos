import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { CardSkeleton, EmptyState, ErrorState } from '../../components/states';
import { useAuthStore } from '../../stores/auth';
import type { DecisionCard } from '../../lib/api/types';
import { DecisionCardView } from './Card';

/**
 * 决策中心（页面文档 10）。
 *
 * ★ 这是整个产品最核心承诺的兑现处：
 *   *你不需要盯着 Agent，需要你的时候我会来找你。*
 *   如果用户看完这一页仍然觉得「我不知道什么时候该介入」，这一页就失败了。
 *
 * ★ 目标是「5 分钟内清空当日队列」，所以这一页刻意不做的事比做的多：
 *   没有搜索、没有自定义排序、没有分组折叠。
 *   一个待办队列一旦需要用户先决定「先看哪条」，5 分钟就没了 ——
 *   顺序由系统给（超时 → 剩余时间 → 风险），用户只管从上往下拍。
 */
export function DecisionsPage() {
  const { projectId } = useParams<{ projectId?: string }>();
  const qc = useQueryClient();

  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  /**
   * ★ 身份没定下来之前不问。
   *   「待我处理」「能不能批」全靠 X-User-Id，匿名问一遍拿到的是
   *   一份谁都不能处理的队列 —— 而它会被缓存下来。
   */
  const userId = useAuthStore((s) => s.userId);
  const inbox = useQuery({
    queryKey: qk.decisionInbox(scope, projectId),
    queryFn: () => api.decisionInbox(scope, projectId),
    enabled: Boolean(userId),
  });

  const cards = inbox.data?.decisions ?? [];

  /**
   * ★ 批量批准只对「可逆且非高风险」的决策开放。
   *
   *   页面文档要 5 分钟清空队列，但队列里混着「合并 PR」和
   *   「删生产库数据」时，一个全选框就是事故本身 ——
   *   批量的价值在于省掉重复点击，不在于省掉阅读。
   *   所以：低风险可逆的批量过，其余逐条确认，且界面明说为什么。
   */
  const batchable = useMemo(() => cards.filter(isBatchable), [cards]);
  const batchableIds = useMemo(() => new Set(batchable.map((c) => c.id)), [batchable]);
  const mustReadOne = cards.filter((c) => c.canAct && !isBatchable(c)).length;

  const selected = [...picked].filter((id) => batchableIds.has(id));

  const batch = useMutation({
    mutationFn: (ids: string[]) => api.batchApproveDecisions(ids),
    onSuccess: () => {
      setPicked(new Set());
      void qc.invalidateQueries({ queryKey: qk.decisionInboxAll() });
      void qc.invalidateQueries({ queryKey: qk.decisionsAll() });
      void qc.invalidateQueries({ queryKey: ['board'] });
      if (projectId) void qc.invalidateQueries({ queryKey: qk.overview(projectId) });
    },
  });

  const toggle = (id: string, next: boolean) => {
    setPicked((prev) => {
      const s = new Set(prev);
      if (next) s.add(id);
      else s.delete(id);
      return s;
    });
  };

  const stats = inbox.data?.stats;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-slate-900">决策中心</h1>
          {projectId && (
            <Link
              to={`/projects/${projectId}`}
              className="text-xs text-slate-500 hover:text-slate-700"
            >
              ← 项目总览
            </Link>
          )}
          <div className="ml-auto flex gap-1">
            <Tab active={scope === 'mine'} onClick={() => setScope('mine')}>
              待我处理{stats ? ` ${stats.mine}` : ''}
            </Tab>
            <Tab active={scope === 'all'} onClick={() => setScope('all')}>
              全部{stats ? ` ${stats.total}` : ''}
            </Tab>
          </div>
        </div>

        {stats && (
          <p className="mt-1 text-[11px] text-slate-500">
            {stats.overdue > 0 && (
              <span className="font-medium text-red-700">超时 {stats.overdue} 条 · </span>
            )}
            {stats.dueSoon > 0 && <span className="text-amber-700">4 小时内到期 {stats.dueSoon} 条 · </span>}
            可处理 {stats.actionable} 条
            {mustReadOne > 0 && (
              <span className="text-slate-400"> · 其中 {mustReadOne} 条不可逆或高风险，需逐条确认</span>
            )}
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-3">
        <div className="mx-auto max-w-3xl space-y-2">
          {inbox.isPending && <CardSkeleton />}
          {inbox.isError && (
            <ErrorState error={inbox.error} onRetry={() => void inbox.refetch()} />
          )}

          {inbox.data && cards.length === 0 && (
            <EmptyState
              icon="✅"
              message={scope === 'mine' ? '没有等你拍板的决策' : '当前没有待处理决策'}
              hint="队列空了就说明系统在自己跑 —— 这是常态，不是异常"
            />
          )}

          {/**
           * ★ 重复决策提示（页面文档 10 §2 第 3 问）。
           *   同一类决策连着来 3 次以上，说明这不是判断，是规则 ——
           *   就地给出「去配成规则」的入口，而不是等用户哪天想起来去看 Analytics。
           */}
          {inbox.data && inbox.data.repeated.length > 0 && (
            <div className="rounded border border-slate-300 bg-white px-3 py-2">
              <p className="text-xs text-slate-700">
                这些决策在反复出现，也许该变成规则而不是每次都问你：
              </p>
              <ul className="mt-0.5 space-y-0.5">
                {inbox.data.repeated.map((r) => (
                  <li key={r.type} className="text-[11px] text-slate-600">
                    · {r.label} —— 当前队列里 {r.count} 条
                  </li>
                ))}
              </ul>
              {projectId && (
                <Link
                  to={`/projects/${projectId}/settings/policies`}
                  className="mt-1 inline-block text-[11px] text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline"
                >
                  去 Policy 配置 →
                </Link>
              )}
            </div>
          )}

          {selected.length > 0 && (
            <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded border border-slate-900 bg-slate-900 px-3 py-1.5 text-xs text-white">
              <span>已选 {selected.length} 条</span>
              <button
                type="button"
                disabled={batch.isPending}
                onClick={() => batch.mutate(selected)}
                className="rounded bg-emerald-600 px-2 py-0.5 hover:bg-emerald-700 disabled:opacity-40"
              >
                {batch.isPending ? '处理中…' : '批量批准'}
              </button>
              <button
                type="button"
                onClick={() => setPicked(new Set())}
                className="text-slate-300 hover:text-white"
              >
                取消选择
              </button>
              {/* ★ 没有「批量驳回」：驳回必须写原因，而每条的原因各不相同。
                  批量驳回要么逼用户写一句放之四海皆准的废话，要么干脆不写。 */}
              <span className="ml-auto text-[11px] text-slate-400">驳回需逐条写明原因</span>
            </div>
          )}

          {batch.isError && (
            <p className="rounded bg-red-50 px-2 py-1.5 text-xs text-red-700">
              {batch.error instanceof ApiError ? batch.error.message : '批量批准失败'}
            </p>
          )}
          {batch.data && batch.data.failed.length > 0 && (
            <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <p>
                批准 {batch.data.approved} 条，{batch.data.failed.length} 条失败：
              </p>
              <ul className="mt-0.5 space-y-0.5">
                {batch.data.failed.map((f) => (
                  <li key={f.id} className="text-[11px]">
                    · {f.error ?? '处理失败'}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {batchable.length > 1 && (
            <label className="flex items-center gap-1.5 px-1 text-[11px] text-slate-500">
              <input
                type="checkbox"
                checked={selected.length === batchable.length}
                onChange={(e) =>
                  setPicked(e.target.checked ? new Set(batchableIds) : new Set())
                }
                className="h-3.5 w-3.5"
              />
              全选可批量的 {batchable.length} 条（低风险且可逆）
            </label>
          )}

          {cards.length > 0 && (
            <ul className="space-y-2">
              {cards.map((c) => (
                <DecisionCardView
                  key={c.id}
                  card={c}
                  selected={picked.has(c.id)}
                  showSelectColumn={batchable.length > 0}
                  onSelect={isBatchable(c) ? (next) => toggle(c.id, next) : null}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/** 可批量 = 我有权处理 + 可逆 + 非高风险。三个条件缺一不可。 */
function isBatchable(c: DecisionCard): boolean {
  return c.canAct && c.reversible && c.riskLevel !== 'high' && c.riskLevel !== 'critical';
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'rounded px-2 py-0.5 text-xs',
        active ? 'bg-slate-900 text-white' : 'border border-slate-300 text-slate-600',
      )}
    >
      {children}
    </button>
  );
}
