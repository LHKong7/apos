import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { money, riskLabel, typeIcon } from '../../lib/format';
import { CardSkeleton, ErrorState } from '../../components/states';
import { GatedButton } from '../../components/Gated';
import { Modal } from '../../features/work-item/ManualMoveDialog';
import { VersionDiff } from './VersionDiff';
import type { PlanDetail } from '../../lib/api/types';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

/**
 * 项目计划确认（页面文档 04）。
 *
 * ★ 页面要在两分钟内让人判断一份计划能不能放行，并且清楚知道
 *   自己批准的是什么。最后一句是本页的灵魂：
 *   **批准计划 = 批准一批自动化行为**，用户必须看到自己让渡了什么。
 *   一个只列任务不说边界的计划页，等于让用户闭着眼睛签字。
 */
export function PlanPage() {
  const { projectId, planId } = useParams<{ projectId: string; planId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [approving, setApproving] = useState(false);
  const [revising, setRevising] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: qk.plan(planId!),
    queryFn: () => api.plan(planId!),
    enabled: Boolean(planId),
  });

  const approve = useMutation({
    mutationFn: (acknowledgedOverrun: boolean) => api.approvePlan(planId!, acknowledgedOverrun),
    onSuccess: () => navigate(`/projects/${projectId}/board`),
    onError: (e) => {
      setApproving(false);
      setError(e instanceof ApiError ? e.message : '批准失败');
    },
  });

  const revise = useMutation({
    mutationFn: (feedback: string) => api.revisePlan(planId!, feedback),
    onSuccess: (next) => {
      setRevising(false);
      void qc.invalidateQueries({ queryKey: qk.plan(planId!) });
      navigate(`/projects/${projectId}/plans/${next.planId}`);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : '重新规划失败'),
  });

  if (!projectId || !planId) return null;
  if (detail.isPending) return <div className="p-4"><CardSkeleton /></div>;
  if (detail.isError) {
    return (
      <div className="p-4">
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const d = detail.data!;
  const approved = d.plan.status === 'approved';
  const superseded = d.plan.status === 'superseded';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-slate-900">执行计划 v{d.plan.version}</h1>
          <span
            className={clsx(
              'rounded px-1.5 py-0.5 text-[11px]',
              approved
                ? 'bg-green-100 text-green-800'
                : superseded
                  ? 'bg-slate-100 text-slate-500'
                  : 'bg-amber-100 text-amber-800',
            )}
          >
            {approved ? '已批准' : superseded ? '已被新版本取代' : '待批准'}
          </span>
          <Link
            to={`/projects/${projectId}/board`}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            ← 回到看板
          </Link>
          <span className="ml-auto text-[11px] text-slate-400">
            由 Project Agent 生成 · {d.plan.model ?? '未知模型'} ·{' '}
            {d.plan.generationMs ? `${Math.round(d.plan.generationMs / 1000)}s` : '—'} ·{' '}
            {money(String(d.plan.generationCost))}
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-3">
        <div className="mx-auto max-w-4xl space-y-3">
          {error && (
            <p className="rounded border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-800">
              {error}
              <button type="button" className="ml-2 underline" onClick={() => setError(null)}>
                知道了
              </button>
            </p>
          )}

          {/* ★ revisionFeedback 是「这一版为什么被要求改」，不是「这一版是怎么来的」。
              「这一版是怎么来的」在下面的版本对比里，取自上一版的同一个字段。 */}
          {d.plan.revisionFeedback && (
            <p className="rounded border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs text-sky-900">
              💬 这一版被要求修改：{d.plan.revisionFeedback}
            </p>
          )}

          {/* ★ 放在指标之前：用户点进 v2 的第一个问题是「和上次比改了什么」，
              不是「这版一共多少任务」 */}
          {planId && <VersionDiff planId={planId} />}

          {/* ── 五个概览指标（§5.2）── */}
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            <Metric
              label="任务"
              value={`${d.metrics.taskCount} 个`}
              sub={`🤖 ${d.metrics.agentTasks}　👤 ${d.metrics.humanTasks}`}
            />
            <Metric label="工期" value={`${d.metrics.estimatedHours} h`} sub="预估合计" />
            <Metric
              label="成本预估"
              value={money(String(d.metrics.estimatedCost))}
              sub={
                d.metrics.budget === null
                  ? '未设预算'
                  : `预算 ${money(String(d.metrics.budget))}`
              }
              tone={d.metrics.overBudget ? 'danger' : 'normal'}
            />
            <Metric
              label="人类参与"
              value={`${d.metrics.humanGateCount} 个`}
              sub="需要你或同事确认的节点"
            />
            <Metric
              label="高风险任务"
              value={`${d.metrics.highRiskTasks} 个`}
              sub={d.metrics.highRiskTasks > 0 ? '下面已标出' : '无'}
              tone={d.metrics.highRiskTasks > 0 ? 'warn' : 'normal'}
            />
          </div>

          {d.metrics.overBudget && (
            <p className="rounded border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-800">
              ⚠ 预估成本加上已花费会超出项目预算（
              {money(String(d.metrics.spent))} + {money(String(d.metrics.estimatedCost))} &gt;{' '}
              {money(String(d.metrics.budget ?? 0))}）。批准时需要显式确认超支
            </p>
          )}

          {/* ── ★ 批准后将自动发生 —— 本页核心 ── */}
          <AutoActions detail={d} />

          {/* ── 任务拆解 ── */}
          <section className="rounded border border-slate-200 bg-white">
            <h2 className="border-b border-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700">
              任务拆解（{d.tasks.length}）
            </h2>
            <ul>
              {d.tasks.map((t) => (
                <li
                  key={t.id}
                  className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-xs last:border-0"
                >
                  <span aria-hidden>{typeIcon(t.type)}</span>
                  <span className="min-w-0 flex-1 truncate text-slate-800">{t.title}</span>
                  {/* 批准前执行主体还没绑定，只能说「会不会来找人」 */}
                  <span className="text-slate-500">
                    {t.requiresHuman ? '👤 需要人' : '🤖 Agent'}
                    {t.executorName && <span className="ml-1">{t.executorName}</span>}
                  </span>
                  <span className="w-12 text-right tabular-nums text-slate-500">
                    {t.estimatedHours ?? '—'}h
                  </span>
                  <span className="w-14 text-right tabular-nums text-slate-500">
                    {t.estimatedCost === null ? '—' : money(String(t.estimatedCost))}
                  </span>
                  {(t.riskLevel === 'high' || t.riskLevel === 'critical') && (
                    <span className="w-20 shrink-0 text-right text-[11px] text-red-700">
                      🔴 {riskLabel(t.riskLevel)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {/*
            ★ 计划是基于这些假设做的，而用户在需求页可能只是划过去了。
              这里必须再复述一遍（页面文档 04 §5，回应 03 §12.2）。
          */}
          {d.assumptions.length > 0 && (
            <section className="rounded border border-slate-200 bg-white px-3 py-2">
              <h2 className="text-xs font-medium text-slate-700">
                📌 本计划基于以下假设（{d.assumptions.length}）
              </h2>
              <ul className="mt-1 space-y-0.5">
                {d.assumptions.map((a) => (
                  <li key={a.id} className="text-xs text-slate-600">
                    · {a.answer ?? a.question}
                    {!a.confirmed && (
                      <span className="ml-1 text-[11px] text-amber-700">未经二次确认</span>
                    )}
                  </li>
                ))}
              </ul>
              {d.plan.requirementId && (
                <Link
                  to={`/projects/${projectId}/requirements/${d.plan.requirementId}`}
                  className="mt-1 inline-block text-[11px] text-slate-500 underline"
                >
                  有误？返回需求页
                </Link>
              )}
            </section>
          )}

          {!approved && !superseded && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <GatedButton
                permission="plan.generate"
                projectId={d.plan.projectId}
                onClick={() => setRevising(true)}
                className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
              >
                要求修改
              </GatedButton>
              {/* ★ 批准计划要 tech_lead（§2.3）—— 要求修改不用，那只是打回去重做 */}
              <GatedButton
                permission="plan.approve"
                projectId={d.plan.projectId}
                onClick={() => setApproving(true)}
                className="rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
              >
                批准并开始执行 →
              </GatedButton>
            </div>
          )}

          {approved && (
            <p className="rounded border border-green-200 bg-green-50 px-3 py-1.5 text-xs text-green-900">
              计划已批准{d.plan.approvedBy.length > 0 && `（${d.plan.approvedBy.join('、')}）`}，
              任务已进入看板开始流动
            </p>
          )}
        </div>
      </div>

      {approving && (
        <ApproveDialog
          detail={d}
          pending={approve.isPending}
          onCancel={() => setApproving(false)}
          onConfirm={() => approve.mutate(d.metrics.overBudget)}
        />
      )}

      {revising && (
        <ReviseDialog
          pending={revise.isPending}
          onCancel={() => setRevising(false)}
          onConfirm={(feedback) => revise.mutate(feedback)}
        />
      )}
    </div>
  );
}

/**
 * 「批准后将自动发生」（页面文档 04 §5.3）—— 本页核心。
 *
 * ★ 这是把 Policy Engine 的抽象规则翻译成人话的地方。
 *   列的是**计划生成时的快照**，不是展示时重算：用户批准的是当时那份清单，
 *   Policy 后来改了，追溯「他到底批准了什么」必须看快照。
 *   同时给出按当前规则重算的边界，两者不一致时明确提示 ——
 *   静默用新规则替换掉快照，等于事后修改了用户签过字的东西。
 */
function AutoActions({ detail: d }: { detail: PlanDetail }) {
  const [expanded, setExpanded] = useState(false);
  const stale = d.plan.status !== 'approved' && d.autoActions.length > 0;

  return (
    <section className="rounded border border-amber-200 bg-amber-50 px-3 py-2">
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-medium text-amber-900">
          ⚠ 批准后将自动发生（无需你再次确认）
        </h2>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="ml-auto text-[11px] text-amber-800 underline"
        >
          {expanded ? '收起' : '逐条查看'}
        </button>
      </div>

      <ul className="mt-1 space-y-0.5">
        {d.autoActions.length === 0 && (
          <li className="text-xs text-amber-900">
            当前规则下没有任何任务会自动执行 —— 每一步都会来找人
          </li>
        )}
        {d.autoActions.map((a, i) => (
          <li key={i} className="text-xs leading-5 text-amber-900">
            · {a.description}
            {a.externalVisible && (
              <span className="ml-1 text-[11px] text-amber-700">（对外可见）</span>
            )}
            {!a.reversible && <span className="ml-1 text-[11px] text-red-700">（不可逆）</span>}
          </li>
        ))}
      </ul>

      {d.humanGates.length > 0 && (
        <div className="mt-1.5 border-t border-amber-200 pt-1.5">
          <p className="text-[11px] text-amber-900">
            仍需人确认的（{d.humanGates.length}）：
            {!expanded && d.humanGates.map((g) => g.taskTitle).join(' · ')}
          </p>
          {expanded && (
            <ul className="mt-0.5 space-y-0.5">
              {d.humanGates.map((g, i) => (
                <li key={i} className="text-[11px] text-amber-900">
                  · <span className="font-medium">{g.taskTitle}</span> —— {g.reason}
                  <span className="ml-1 text-amber-700">（{g.assigneeHint}）</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {expanded && stale && (
        <p className="mt-1.5 border-t border-amber-200 pt-1.5 text-[11px] text-amber-700">
          以上是**计划生成时**按当时的 Policy 算出来的。按当前规则，
          {d.currentBoundary.auto.length} 类操作自动执行、{d.currentBoundary.human.length} 类需要人确认。
          批准时以实际生效的规则为准
        </p>
      )}

      <Link
        to={`/projects/${d.plan.projectId}/settings/policies`}
        className="mt-1 inline-block text-[11px] text-amber-800 underline"
      >
        调整这些规则 → Policy 配置
      </Link>
    </section>
  );
}

function Metric({
  label,
  value,
  sub,
  tone = 'normal',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'normal' | 'warn' | 'danger';
}) {
  return (
    <div className="rounded border border-slate-200 bg-white px-3 py-2">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p
        className={clsx(
          'mt-0.5 text-lg font-semibold',
          tone === 'danger' ? 'text-red-700' : tone === 'warn' ? 'text-amber-700' : 'text-slate-900',
        )}
      >
        {value}
      </p>
      {sub && <p className="text-[11px] text-slate-400">{sub}</p>}
    </div>
  );
}

/**
 * 批准前最后一次把边界摆出来。
 *
 * ★ 这不是「确定吗」。用户在这里让渡的是一批自动化行为的执行权，
 *   摘要必须再说一遍他放行了什么、还剩什么需要他。
 */
function ApproveDialog({
  detail: d,
  pending,
  onCancel,
  onConfirm,
}: {
  detail: PlanDetail;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const needsAck = d.metrics.overBudget;

  return (
    <Modal onClose={onCancel} title="批准这份计划">
      <div className="w-[28rem] max-w-full">
        <h2 className="text-sm font-semibold text-slate-900">批准这份计划</h2>
        <div className="mt-2 space-y-1 text-xs text-slate-700">
          <p>
            · {d.metrics.agentTasks} 个任务将由 Agent 自动执行，预计消耗{' '}
            {money(String(d.metrics.estimatedCost))}
          </p>
          <p>· {d.metrics.humanGateCount} 个节点仍会来找人确认</p>
          <p>· 批准后任务立即进入看板开始流动</p>
        </div>

        {needsAck && (
          <label className="mt-2 flex cursor-pointer items-start gap-1.5 rounded bg-red-50 px-2 py-1.5 text-xs text-red-800">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 accent-red-700"
            />
            我知道这份计划会让项目超出预算，仍然批准
          </label>
        )}

        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="text-xs text-slate-500">
            返回
          </button>
          <Button variant="neutral" size="sm"
            onClick={onConfirm}
            disabled={pending || (needsAck && !acknowledged)}>
            {pending ? '批准中…' : '批准并开始执行'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ReviseDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: boolean;
  onCancel: () => void;
  onConfirm: (feedback: string) => void;
}) {
  const [feedback, setFeedback] = useState('');
  return (
    <Modal onClose={onCancel} title="要求修改计划">
      <h2 className="text-sm font-semibold text-slate-900">要求修改</h2>
      <p className="mt-1 text-xs text-slate-500">
        说清楚要改什么，Agent 会据此重新规划成新的一版。旧版会保留，方便对照
      </p>
      <Textarea
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        rows={3}
        placeholder="例如：前端可以并行开工，不用等后端完成"
        className="mt-2"
      />
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="text-xs text-slate-500">
          取消
        </button>
        <Button variant="neutral" size="sm"
          onClick={() => onConfirm(feedback.trim())}
          disabled={!feedback.trim() || pending}>
          {pending ? '重新规划中…' : '重新规划'}
        </Button>
      </div>
    </Modal>
  );
}
