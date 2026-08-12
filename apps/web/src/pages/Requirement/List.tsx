import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { CardSkeleton, EmptyState, ErrorState } from '../../components/states';
import { GatedButton } from '../../components/Gated';
import { Modal } from '../../features/work-item/ManualMoveDialog';
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
 *   不是「录入之后理解得对不对」。后者才是这条链路的价值所在。
 *
 * ★★ 但「接下来谁来结构化」是两条路：AI 分析，或者自己填。
 *   两个按钮并排给、措辞不分主次 —— 把人工那条做成小字兜底的话，
 *   用户只会在 AI 失败之后才发现它，而那时他已经等过一轮了。
 */
export function RequirementListPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  /** 上一轮批量删除里被挡下的那些，连同原因 */
  const [blocked, setBlocked] = useState<{ id: string; title: string; reason: string }[]>([]);

  const list = useQuery({
    queryKey: qk.requirements(projectId!),
    queryFn: () => api.requirements(projectId!),
    enabled: Boolean(projectId),
  });

  /**
   * @param next 建完之后干什么：交给 AI 分析，还是直接进人工填写。
   *
   * ★ 两种都只是**落地页不同**，建出来的需求完全一样 ——
   *   人在详情页里随时能改主意，两条路互相接力。
   */
  const create = useMutation({
    mutationFn: (next: 'ai' | 'manual') =>
      api
        .createRequirement(projectId!, { rawInput: draft.trim() })
        .then((r) => ({ id: r.requirement.id, next })),
    onSuccess: ({ id, next }) =>
      navigate(`/projects/${projectId}/requirements/${id}${next === 'manual' ? '?edit=1' : ''}`),
    onError: (e) => setError(e instanceof ApiError ? e.message : '创建失败'),
  });

  const rows = list.data?.requirements ?? [];
  const chosen = rows.filter((r) => selected.has(r.id));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /**
   * 批量删除。
   *
   * ★★ 逐条发、用 allSettled 而不是 all —— 有派生物的需求会被服务端挡下，
   *   而 `all` 一遇到失败就整体 reject，已经删掉的那几条不会有任何反馈，
   *   用户看到的是「删除失败」但列表里少了三条。
   *
   * ★★ 被挡下的要**逐条列出来**，连原因一起。清一批试验数据时，
   *   混在里面的那条真需求正是最需要被看见的 —— 汇总成
   *   「部分失败」等于让用户自己去猜是哪一条、为什么。
   */
  const removeMany = useMutation({
    mutationFn: async (targets: { id: string; title: string }[]) => {
      const results = await Promise.allSettled(
        targets.map((t) => api.deleteRequirement(t.id)),
      );
      return results.flatMap((res, i) =>
        res.status === 'fulfilled'
          ? []
          : [
              {
                id: targets[i]!.id,
                title: targets[i]!.title,
                reason: res.reason instanceof ApiError ? res.reason.message : '删除失败',
              },
            ],
      );
    },
    onSuccess: (failures) => {
      setConfirmingDelete(false);
      setBlocked(failures);
      // 删成功的取消勾选，被挡下的**保持勾选** —— 它们还等着用户处理
      setSelected(new Set(failures.map((f) => f.id)));
      void qc.invalidateQueries({ queryKey: qk.requirements(projectId!) });
    },
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
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <Button variant="neutral" size="sm"
                onClick={() => create.mutate('ai')}
                disabled={draft.trim().length === 0 || create.isPending}>
                {create.isPending ? '创建中…' : '交给 AI 分析 →'}
              </Button>
              <Button variant="outline" size="sm"
                onClick={() => create.mutate('manual')}
                disabled={draft.trim().length === 0 || create.isPending}>
                自己填写 →
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

          {blocked.length > 0 && (
            <section className="rounded border border-amber-200 bg-amber-50 px-3 py-2">
              <p className="text-xs font-medium text-amber-900">
                有 {blocked.length} 条没能删除，仍然勾着：
              </p>
              <ul className="mt-1 space-y-0.5">
                {blocked.map((b) => (
                  <li key={b.id} className="text-[11px] text-amber-800">
                    · <span className="font-medium">{b.title}</span> —— {b.reason}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="mt-1 text-[11px] text-amber-700 underline"
                onClick={() => setBlocked([])}
              >
                知道了
              </button>
            </section>
          )}

          {rows.length > 0 && (
            <section className="rounded border border-slate-200 bg-white">
              <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5">
                <h2 className="text-xs font-medium text-slate-700">已有需求（{rows.length}）</h2>
                {/*
                  ★ 批量删除只在勾了东西之后出现 —— 常驻一个删除按钮会让
                    这个以「录入」为主的页面看起来像个管理后台。
                */}
                {selected.size > 0 && (
                  <>
                    <span className="text-[11px] text-slate-500">已选 {selected.size} 条</span>
                    <button
                      type="button"
                      className="text-[11px] text-slate-500 underline"
                      onClick={() => setSelected(new Set())}
                    >
                      取消选择
                    </button>
                    <GatedButton
                      permission="requirement.delete"
                      onClick={() => setConfirmingDelete(true)}
                      className="ml-auto text-xs text-red-600 hover:text-red-800"
                    >
                      删除选中
                    </GatedButton>
                  </>
                )}
              </div>
              <ul>
                {rows.map((r) => (
                  <li
                    key={r.id}
                    className={clsx(
                      'flex items-center gap-2 border-b border-slate-100 px-3 last:border-0',
                      selected.has(r.id) && 'bg-red-50/60',
                    )}
                  >
                    {/*
                      ★ 勾选框独立于整行按钮之外：按钮不能嵌套，而且勾选与
                        「进入这条需求」是两个意图，共用一次点击必然误触。
                    */}
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                      aria-label={`选择「${r.title}」`}
                      className="shrink-0 accent-red-600"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        // 已经生成过计划的，直接去计划页 —— 用户此刻要看的是计划
                        r.latestPlanId
                          ? navigate(`/projects/${projectId}/plans/${r.latestPlanId}`)
                          : navigate(`/projects/${projectId}/requirements/${r.id}`)
                      }
                      className="flex min-w-0 flex-1 flex-wrap items-center gap-2 py-1.5 text-left text-xs hover:bg-slate-50"
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

      {confirmingDelete && (
        <BulkDeleteDialog
          targets={chosen.map((r) => ({ id: r.id, title: r.title }))}
          pending={removeMany.isPending}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() =>
            removeMany.mutate(chosen.map((r) => ({ id: r.id, title: r.title })))
          }
        />
      )}
    </div>
  );
}

/**
 * 批量删除确认。
 *
 * ★ 逐条列出标题而不是只说「删除 5 条」—— 勾选是在列表上做的，
 *   到了这一屏用户已经看不见自己勾了什么。
 * ★ 同样要说清「这不是驳回」：清试验数据时手一滑把真需求勾进来，
 *   代价是不可逆的。
 */
function BulkDeleteDialog({
  targets,
  pending,
  onCancel,
  onConfirm,
}: {
  targets: { id: string; title: string }[];
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal onClose={onCancel} title="删除需求">
      <h2 className="text-sm font-semibold text-slate-900">删除 {targets.length} 条需求</h2>
      <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto rounded border border-slate-200 bg-slate-50 px-2 py-1.5">
        {targets.map((t) => (
          <li key={t.id} className="truncate text-xs text-slate-700">
            · {t.title}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-slate-500">
        记录连同各自的澄清项与假设一并删除，<span className="text-red-600">无法恢复</span>。
        已经生成过计划或工作项的会被挡下并逐条告诉你原因 —— 那些需要的是驳回，不是删除。
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="text-xs text-slate-500">
          取消
        </button>
        <Button variant="destructive" size="sm" onClick={onConfirm} disabled={pending}>
          {pending ? '删除中…' : `确认删除 ${targets.length} 条`}
        </Button>
      </div>
    </Modal>
  );
}
