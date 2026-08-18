import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { CardSkeleton, EmptyState, ErrorState } from '../../components/states';
import { GatedButton } from '../../components/Gated';
import { useT, type MessageKey } from '../../lib/i18n';
import { Modal } from '../../features/work-item/ManualMoveDialog';
import { absoluteTime, relativeTime } from '../../lib/format';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';

/**
 * 状态 → 词条键。
 *
 * ★ 存键不存译文：这张表是模块级常量，取不到 hook；而且切换语言时
 *   模块常量不会重算，译好的字符串会一直停在第一次渲染的那个语言。
 *   Status values map to message keys, not strings — a module-level constant
 *   cannot call hooks and would freeze at whatever locale loaded first.
 */
const STATUS_KEYS: Record<string, MessageKey> = {
  draft: 'requirement.status.draft',
  analyzing: 'requirement.status.analyzing',
  clarifying: 'requirement.status.clarifying',
  awaiting_approval: 'requirement.status.awaiting_approval',
  approved: 'requirement.status.approved',
  rejected: 'requirement.status.rejected',
  on_hold: 'requirement.status.on_hold',
};

/**
 * 每个状态的「下一步是什么」。
 *
 * ★★ 状态名说的是**系统在哪**，用户要问的是**我该干什么**。
 *   「待审批」这三个字里既看不出该谁批、也看不出要不要等 ——
 *   一个新人看到它，唯一能做的是猜（问题记录 #9）。
 *
 * ★ 「已批准」这一档也要有说法：批准之后系统会自己往下走，
 *   而「不用你做什么」同样是一条要说出来的信息 —— 不说的话，
 *   用户会一直守着它等一个不存在的下一步。
 *
 * A status names where the system is; the user is asking what they should do.
 * "Approved — nothing for you to do" is itself an answer worth printing.
 */
const NEXT_STEP_KEYS: Record<string, MessageKey> = {
  draft: 'requirement.next.draft',
  analyzing: 'requirement.next.analyzing',
  clarifying: 'requirement.next.clarifying',
  awaiting_approval: 'requirement.next.awaiting_approval',
  approved: 'requirement.next.approved',
  rejected: 'requirement.next.rejected',
  on_hold: 'requirement.next.on_hold',
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
  const t = useT();
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
    onError: (e) => setError(e instanceof ApiError ? e.message : t('requirement.compose.createFailed')),
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
        targets.map((target) => api.deleteRequirement(target.id)),
      );
      return results.flatMap((res, i) =>
        res.status === 'fulfilled'
          ? []
          : [
              {
                id: targets[i]!.id,
                title: targets[i]!.title,
                reason:
                  res.reason instanceof ApiError
                    ? res.reason.message
                    : t('requirement.delete.failed'),
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

  /** 两个按钮为什么灰着 —— 只有这一个原因，所以直接命名它 */
  const empty = draft.trim().length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-slate-900">{t('requirement.title')}</h1>
          <Link
            to={`/projects/${projectId}/board`}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            {t('nav.backToBoard')}
          </Link>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-3">
        <div className="mx-auto max-w-3xl space-y-3">
          <section className="rounded border border-slate-200 bg-white px-3 py-2">
            <h2 className="text-xs font-medium text-slate-700">
              {t('requirement.compose.heading')}
            </h2>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={5}
              placeholder={t('requirement.compose.placeholder')}
              className="mt-1.5"
            />
            {/*
              ★★ 灰按钮必须说清为什么是灰的。
                这两个按钮在文本框空着时禁用，而禁用的按钮不响应 hover、
                原生 `title` 在 disabled 元素上大多数浏览器也不弹 ——
                于是用户面对两个没有任何解释的灰按钮（问题记录 #8）。
                做法是把说明放在**按钮外面**，跟着禁用条件一起出现：
                永远看得见，也不依赖 hover。
              ★ 同时给按钮加 aria-disabled 与 aria-describedby：读屏用户
                听到的是「不可用 —— 先写点什么」，而不是只有「不可用」。
            */}
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <Button variant="neutral" size="sm"
                onClick={() => create.mutate('ai')}
                aria-describedby={empty ? 'compose-disabled-why' : undefined}
                disabled={empty || create.isPending}>
                {create.isPending ? t('requirement.compose.creating') : t('requirement.compose.toAi')}
              </Button>
              <Button variant="outline" size="sm"
                onClick={() => create.mutate('manual')}
                aria-describedby={empty ? 'compose-disabled-why' : undefined}
                disabled={empty || create.isPending}>
                {t('requirement.compose.manual')}
              </Button>
              {empty && (
                <span id="compose-disabled-why" className="text-[11px] text-slate-500">
                  {t('requirement.compose.needText')}
                </span>
              )}
              {/* ★ 不阻止短输入，只如实说明后果 */}
              {draft.trim().length > 0 && draft.trim().length < 20 && (
                <span className="text-[11px] text-amber-700">
                  {t('requirement.compose.shortInput')}
                </span>
              )}
              <span className="ml-auto text-[11px] text-slate-400">
                {t('requirement.compose.mvpNote')}
              </span>
            </div>
            {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
          </section>

          {list.isPending && <CardSkeleton />}
          {list.isError && (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          )}

          {list.data && list.data.requirements.length === 0 && (
            <EmptyState
              icon="📝"
              message={t('requirement.list.empty')}
              hint={t('requirement.list.emptyHint')}
            />
          )}

          {blocked.length > 0 && (
            <section className="rounded border border-amber-200 bg-amber-50 px-3 py-2">
              <p className="text-xs font-medium text-amber-900">
                {t('requirement.delete.blockedHeading', { count: blocked.length })}
              </p>
              <ul className="mt-1 space-y-0.5">
                {blocked.map((b) => (
                  <li key={b.id} className="text-[11px] text-amber-800">
                    · <span className="font-medium">{b.title}</span> —— {b.reason}
                  </li>
                ))}
              </ul>
              <Button variant="ghost"
                className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent mt-1 text-[11px] text-amber-700 underline"
                onClick={() => setBlocked([])}
              >
                {t('common.gotIt')}
              </Button>
            </section>
          )}

          {rows.length > 0 && (
            <section className="rounded border border-slate-200 bg-white">
              <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5">
                <h2 className="text-xs font-medium text-slate-700">
                  {t('requirement.list.heading', { count: rows.length })}
                </h2>
                {/*
                  ★ 批量删除只在勾了东西之后出现 —— 常驻一个删除按钮会让
                    这个以「录入」为主的页面看起来像个管理后台。
                */}
                {selected.size > 0 && (
                  <>
                    <span className="text-[11px] text-slate-500">
                      {t('requirement.list.selected', { count: selected.size })}
                    </span>
                    <Button variant="ghost"
                      className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent text-[11px] text-slate-500 underline"
                      onClick={() => setSelected(new Set())}
                    >
                      {t('requirement.list.clearSelection')}
                    </Button>
                    <GatedButton
                      permission="requirement.delete"
                      onClick={() => setConfirmingDelete(true)}
                      className="ml-auto text-xs text-red-600 hover:text-red-800"
                    >
                      {t('requirement.list.deleteSelected')}
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
                    <Checkbox
                      tone="destructive"
                      checked={selected.has(r.id)}
                      onCheckedChange={() => toggle(r.id)}
                      aria-label={t('requirement.list.selectOne', { title: r.title })}
                    />
                    <Button variant="ghost"
                      onClick={() =>
                        // 已经生成过计划的，直接去计划页 —— 用户此刻要看的是计划
                        r.latestPlanId
                          ? navigate(`/projects/${projectId}/plans/${r.latestPlanId}`)
                          : navigate(`/projects/${projectId}/requirements/${r.id}`)
                      }
                      className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent justify-start flex min-w-0 flex-1 flex-wrap items-center gap-2 py-1.5 text-left text-xs hover:bg-slate-50"
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
                        {STATUS_KEYS[r.status] ? t(STATUS_KEYS[r.status]!) : r.status}
                      </span>
                      {/* ★ 下一步就写在状态旁边，不藏进 tooltip —— 它是新人
                          在这一页最需要的一句话，藏起来等于没写 */}
                      {NEXT_STEP_KEYS[r.status] && (
                        <span className="text-[11px] text-slate-500">
                          {t(NEXT_STEP_KEYS[r.status]!)}
                        </span>
                      )}
                      {r.latestPlanId && (
                        <span className="text-[11px] text-slate-500">
                          {r.latestPlanStatus === 'approved'
                            ? t('requirement.list.planApproved')
                            : t('requirement.list.planPending')}
                        </span>
                      )}
                      <span className="text-[11px] text-slate-400" title={absoluteTime(r.createdAt)}>
                        {relativeTime(r.createdAt)}
                      </span>
                    </Button>
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
  const t = useT();
  return (
    <Modal onClose={onCancel} title={t('requirement.delete.one.title')}>
      <h2 className="text-sm font-semibold text-slate-900">
        {t('requirement.delete.many.title', { count: targets.length })}
      </h2>
      <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto rounded border border-slate-200 bg-slate-50 px-2 py-1.5">
        {targets.map((t) => (
          <li key={t.id} className="truncate text-xs text-slate-700">
            · {t.title}
          </li>
        ))}
      </ul>
      {/*
        ★ 「无法恢复」单独成键并染红 —— 它是这一屏唯一不可逆的部分。
          把它揉进整段里，读的人会连着扫过去。
      */}
      <p className="mt-2 text-xs text-slate-500">
        {t('requirement.delete.warning')}{' '}
        <span className="text-red-600">{t('requirement.delete.irreversible')}</span>{' '}
        {t('requirement.delete.blockedHint')}
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent text-xs text-slate-500">
          {t('common.cancel')}
        </Button>
        <Button variant="destructive" size="sm" onClick={onConfirm} disabled={pending}>
          {pending
            ? t('common.deleting')
            : t('requirement.delete.confirmMany', { count: targets.length })}
        </Button>
      </div>
    </Modal>
  );
}
