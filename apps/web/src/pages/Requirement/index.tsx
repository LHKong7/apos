import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { CardSkeleton, ErrorState } from '../../components/states';
import { Modal } from '../../features/work-item/ManualMoveDialog';
import { Completeness } from './Completeness';
import { Clarifications } from './Clarifications';

/**
 * 需求录入与 AI 澄清（页面文档 03）。
 *
 * ★ 这是整个产品的第一个 Human Gate，也是决定后续所有自动化质量的地方。
 *   宁可在这里多花两分钟，也不要让 Agent 基于错误理解跑三小时。
 *
 * ★ 原始输入永远保留在左边，与 AI 的结构化结果左右对照。
 *   用户必须能验证 AI 没有曲解自己的意思 —— 这是建立信任的地基，
 *   一旦原文被结构化结果覆盖掉，用户就再也没法自己核对了。
 */
export function RequirementPage() {
  const { projectId, reqId } = useParams<{ projectId: string; reqId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [answering, setAnswering] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: qk.requirement(reqId!),
    queryFn: () => api.requirement(reqId!),
    enabled: Boolean(reqId),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: qk.requirement(reqId!) });

  const analyze = useMutation({
    mutationFn: () => api.analyzeRequirement(reqId!),
    onSuccess: () => void refresh(),
    onError: (e) => setError(e instanceof ApiError ? e.message : '分析失败'),
  });

  const answer = useMutation({
    mutationFn: (v: { id: string; answer: string; usedSuggestion: boolean }) =>
      api.answerClarification(v.id, { answer: v.answer, usedSuggestion: v.usedSuggestion }),
    onMutate: (v) => setAnswering(v.id),
    onSettled: () => setAnswering(null),
    onSuccess: () => void refresh(),
    onError: (e) => setError(e instanceof ApiError ? e.message : '提交失败'),
  });

  /**
   * 确认 → 生成计划 → 直接进计划页。
   *
   * 中间不停留：用户刚做完一个判断，此刻最该看到的是这个判断导致了什么，
   * 而不是回到一个列表再自己找。
   */
  const approve = useMutation({
    mutationFn: async () => {
      await api.approveRequirement(reqId!);
      return api.generatePlan(reqId!);
    },
    onSuccess: (plan) => navigate(`/projects/${projectId}/plans/${plan.planId}`),
    onError: (e) => {
      setConfirming(false);
      if (e instanceof ApiError && e.code === 'UNANSWERED_MUST_CONFIRM') {
        setError(`${e.message} —— 下面标🔴的问题必须先回答`);
        return;
      }
      setError(e instanceof ApiError ? e.message : '确认失败');
    },
  });

  const reject = useMutation({
    mutationFn: (reason: string) => api.rejectRequirement(reqId!, reason),
    onSuccess: () => {
      setRejecting(false);
      void refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : '驳回失败'),
  });

  if (!projectId || !reqId) return null;
  if (detail.isPending) return <div className="p-4"><CardSkeleton /></div>;
  if (detail.isError) {
    return (
      <div className="p-4">
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const { requirement: r, clarifications } = detail.data!;
  const analyzed = r.title !== null;
  const readOnly = r.status === 'approved' || r.status === 'rejected';
  const mustConfirm = clarifications.filter((c) => c.level === 'must_confirm' && !c.answer);
  const assumptions = clarifications.filter((c) => c.level === 'assumption_ok');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-slate-900">
            {r.title ?? '新建需求'}
          </h1>
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
          <Link
            to={`/projects/${projectId}/requirements`}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            ← 需求列表
          </Link>
        </div>

        {analyzed && <div className="mt-1.5"><Completeness scores={r.completeness} /></div>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-3">
        <div className="mx-auto max-w-5xl space-y-3">
          {error && (
            <p className="rounded border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-800">
              {error}
              <button type="button" className="ml-2 underline" onClick={() => setError(null)}>
                知道了
              </button>
            </p>
          )}

          {r.status === 'rejected' && r.rejectReason && (
            <p className="rounded border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-800">
              已驳回：{r.rejectReason}
            </p>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            {/* ── 原始输入：永不覆盖 ── */}
            <section className="rounded border border-slate-200 bg-white px-3 py-2">
              <h2 className="text-xs font-medium text-slate-700">📄 原始输入</h2>
              <p className="mt-1 whitespace-pre-wrap text-xs leading-6 text-slate-700">
                {r.rawInput}
              </p>
              <p className="mt-2 border-t border-slate-100 pt-1.5 text-[11px] text-slate-400">
                原文永不被结构化结果覆盖 —— 你随时可以对照它检查 AI 有没有理解错
              </p>
            </section>

            {/* ── AI 结构化结果 ── */}
            <section className="rounded border border-slate-200 bg-white px-3 py-2">
              <h2 className="text-xs font-medium text-slate-700">🤖 AI 结构化结果</h2>

              {!analyzed ? (
                <div className="py-6 text-center">
                  <p className="text-xs text-slate-500">还没有分析过这条需求</p>
                  <button
                    type="button"
                    onClick={() => analyze.mutate()}
                    disabled={analyze.isPending}
                    className="mt-2 rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
                  >
                    {analyze.isPending ? '分析中…' : '开始 AI 分析'}
                  </button>
                </div>
              ) : (
                <dl className="mt-1 space-y-1.5 text-xs">
                  <Field label="业务背景" value={r.businessContext} />
                  <Field label="用户问题" value={r.userProblem} />
                  <Field label="业务目标" value={r.businessGoal} />
                  <div>
                    <dt className="text-[11px] text-slate-500">
                      功能范围
                      {(r.scope.inScope?.length ?? 0) === 0 && (
                        <span className="ml-1 text-amber-700">⚠ 未识别</span>
                      )}
                    </dt>
                    <dd className="text-slate-700">
                      {(r.scope.inScope ?? []).map((s) => (
                        <span key={s} className="mr-1.5">
                          · {s}
                        </span>
                      ))}
                    </dd>
                  </div>
                  <div>
                    {/*
                      ★ 验收标准必须是结构化清单，不是自由文本 ——
                        它后续会成为 Review 阶段的自动校验依据。
                    */}
                    <dt className="text-[11px] text-slate-500">
                      验收标准（{r.acceptanceCriteria.length}）
                      {r.acceptanceCriteria.length < 3 && (
                        <span className="ml-1 text-amber-700">⚠ 偏少，Review 阶段可校验的点不多</span>
                      )}
                    </dt>
                    <dd>
                      <ul className="space-y-0.5">
                        {r.acceptanceCriteria.map((a, i) => (
                          <li key={i} className="text-slate-700">
                            ☑ {a.text ?? a.description ?? JSON.stringify(a)}
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                  {analyzed && !readOnly && (
                    <button
                      type="button"
                      onClick={() => analyze.mutate()}
                      disabled={analyze.isPending}
                      className="text-[11px] text-slate-500 underline disabled:opacity-50"
                    >
                      {analyze.isPending ? '重新分析中…' : '重新分析'}
                    </button>
                  )}
                </dl>
              )}
            </section>
          </div>

          {analyzed && (
            <Clarifications
              clarifications={clarifications}
              pending={answering}
              readOnly={readOnly}
              onAnswer={(id, a, used) => answer.mutate({ id, answer: a, usedSuggestion: used })}
            />
          )}

          {assumptions.length > 0 && (
            <section className="rounded border border-slate-200 bg-white px-3 py-2">
              <h2 className="text-xs font-medium text-slate-700">
                📌 已记录假设（{assumptions.length}）
              </h2>
              <p className="text-[11px] text-slate-400">
                这些假设会传给 Project Agent 和后续所有执行 Agent。执行中被证伪时会回到这里生成一条决策
              </p>
              <ul className="mt-1 space-y-0.5">
                {assumptions.map((a) => (
                  <li key={a.id} className="text-xs text-slate-600">
                    · {a.answer ?? a.agentSuggestion ?? a.question}
                    {!a.answer && <span className="ml-1 text-[11px] text-slate-400">（未经确认）</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {analyzed && !readOnly && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setRejecting(true)}
                className="text-xs text-slate-500 hover:text-slate-800"
              >
                驳回
              </button>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
              >
                确认需求 →
              </button>
            </div>
          )}

          {r.status === 'approved' && (
            <p className="rounded border border-green-200 bg-green-50 px-3 py-1.5 text-xs text-green-900">
              需求已确认。Project Agent 会据此生成执行计划，计划仍需批准才会开始执行
            </p>
          )}
        </div>
      </div>

      {confirming && (
        <ConfirmDialog
          mustConfirmLeft={mustConfirm.length}
          completeness={r.completeness.total ?? 0}
          pending={approve.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => approve.mutate()}
        />
      )}

      {rejecting && (
        <RejectDialog
          pending={reject.isPending}
          onCancel={() => setRejecting(false)}
          onConfirm={(reason) => reject.mutate(reason)}
        />
      )}
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  analyzing: '分析中',
  clarifying: '待澄清',
  awaiting_approval: '待确认',
  approved: '已确认',
  rejected: '已驳回',
  on_hold: '暂缓',
};

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-[11px] text-slate-500">
        {label}
        {!value && <span className="ml-1 text-amber-700">⚠ 未识别</span>}
      </dt>
      <dd className="leading-5 text-slate-700">{value ?? '—'}</dd>
    </div>
  );
}

/**
 * 确认前说清楚接下来会发生什么（页面文档 03 §5.7）。
 *
 * ★ 这不是一个「确定吗」的弹窗。用户按下确认后会有一个 Agent 花几分钟、
 *   几毛钱去干活，他有权在按之前就知道这件事。
 */
function ConfirmDialog({
  mustConfirmLeft,
  completeness,
  pending,
  onCancel,
  onConfirm,
}: {
  mustConfirmLeft: number;
  completeness: number;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal onClose={onCancel}>
      <h2 className="text-sm font-semibold text-slate-900">确认这条需求</h2>
      <div className="mt-2 space-y-1 text-xs text-slate-700">
        <p>确认后，Project Agent 将：</p>
        <p>· 拆解任务并生成执行计划</p>
        <p>· 计划生成后仍需你或技术负责人批准，才会真正开始执行</p>
      </div>

      {mustConfirmLeft > 0 && (
        <p className="mt-2 rounded bg-red-50 px-2 py-1.5 text-xs text-red-800">
          还有 {mustConfirmLeft} 个必答问题没回答，确认会被拒绝。先回答它们
        </p>
      )}
      {mustConfirmLeft === 0 && completeness < 60 && (
        <p className="mt-2 rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
          完整度只有 {completeness} 分。可以确认，但 Agent 大概率会产生较多返工 ——
          现在花两分钟补一下，比之后花三小时返工划算
        </p>
      )}

      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="text-xs text-slate-500">
          返回修改
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className="rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {pending ? '生成计划中…' : '确认'}
        </button>
      </div>
    </Modal>
  );
}

function RejectDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <Modal onClose={onCancel}>
      <h2 className="text-sm font-semibold text-slate-900">驳回需求</h2>
      {/* ★ 必填原因：提出人要知道为什么，否则只会原样再提一遍 */}
      <p className="mt-1 text-xs text-slate-500">原因会通知提出人，请写清楚问题在哪</p>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        className="mt-2 w-full rounded border border-slate-300 px-2 py-1 text-xs"
      />
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="text-xs text-slate-500">
          取消
        </button>
        <button
          type="button"
          onClick={() => onConfirm(reason.trim())}
          disabled={!reason.trim() || pending}
          className="rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          确认驳回
        </button>
      </div>
    </Modal>
  );
}
