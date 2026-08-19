import { useT, type MessageKey } from '../../lib/i18n';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import {
  absoluteTime,
  money,
  relativeTime,
  riskLabel,
  tokens,
  typeIcon,
} from '../../lib/format';
import { CardSkeleton, ErrorState } from '../../components/states';
import { GatedButton } from '../../components/Gated';
import { Modal } from '../../features/work-item/ManualMoveDialog';
import { TaskAssignee } from './TaskAssignee';
import { VersionDiff } from './VersionDiff';
import type { PlanDetail } from '../../lib/api/types';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

/**
 * 项目计划确认（页面文档 04）。
 *
 * ★ 页面要在两分钟内让人判断一份计划能不能放行，并且清楚知道
 *   自己批准的是什么。最后一句是本页的灵魂：
 *   **批准计划 = 批准一批自动化行为**，用户必须看到自己让渡了什么。
 *   一个只列任务不说边界的计划页，等于让用户闭着眼睛签字。
 */
export function PlanPage() {
  const t = useT();
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

  /**
   * ★★ 「有人工任务没人认领」是一次**可确认**的拦截，不是失败。
   *
   *   服务端第一次会拒掉并列出是哪几项 —— 因为批下去它们会进 ready 然后
   *   停在那里：调度器不碰人工任务，而没有人被通知过它是自己的。
   *   用户看清楚之后可以回去指派，也可以确认让它们进待认领队列。
   */
  const [unassigned, setUnassigned] = useState<{ id: string; title: string }[] | null>(null);

  const approve = useMutation({
    mutationFn: (opts: { overrun: boolean; unassigned: boolean }) =>
      api.approvePlan(planId!, opts.overrun, opts.unassigned),
    onSuccess: () => navigate(`/projects/${projectId}/board`),
    onError: (e) => {
      setApproving(false);
      const detail =
        e instanceof ApiError && (e.details as { code?: string } | undefined)?.code === 'UNASSIGNED_HUMAN_TASKS'
          ? (e.details as { tasks: { id: string; title: string }[] }).tasks
          : null;
      if (detail) {
        setUnassigned(detail);
        setError(null);
        return;
      }
      setError(e instanceof ApiError ? e.message : t('plan.approveFailed'));
    },
  });

  const revise = useMutation({
    mutationFn: (feedback: string) => api.revisePlan(planId!, feedback),
    onSuccess: (next) => {
      setRevising(false);
      void qc.invalidateQueries({ queryKey: qk.plan(planId!) });
      navigate(`/projects/${projectId}/plans/${next.planId}`);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t('plan.replanFailed')),
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
          <h1 className="text-sm font-semibold text-slate-900">{t('plan.titleVersion', { version: d.plan.version })}</h1>
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
            {approved ? t('plan.status.approved') : superseded ? t('plan.status.superseded') : t('plan.status.pending')}
          </span>
          <Link
            to={`/projects/${projectId}/board`}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            {t('nav.backToBoard')}
          </Link>
          <span className="ml-auto text-[11px] text-slate-400">
            {t('plan.generatedBy', { model: d.plan.model ?? t('plan.unknownModel') })} ·{' '}
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
              <Button variant="ghost" className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent ml-2 underline" onClick={() => setError(null)}>
                {t('common.gotIt')}
              </Button>
            </p>
          )}

          {/* ★ revisionFeedback 是「这一版为什么被要求改」，不是「这一版是怎么来的」。
              「这一版是怎么来的」在下面的版本对比里，取自上一版的同一个字段。 */}
          {d.plan.revisionFeedback && (
            <p className="rounded border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs text-sky-900">
              {t('plan.revisionFeedback', { feedback: d.plan.revisionFeedback })}
            </p>
          )}

          {/* ★ 放在指标之前：用户点进 v2 的第一个问题是「和上次比改了什么」，
              不是「这版一共多少任务」 */}
          {planId && <VersionDiff planId={planId} />}

          {/* ── 五个概览指标（§5.2）── */}
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            <Metric
              label={t('plan.metric.tasks')}
              value={t('plan.countItems', { count: d.metrics.taskCount })}
              sub={`🤖 ${d.metrics.agentTasks}　👤 ${d.metrics.humanTasks}`}
            />
            <Metric label={t('plan.metric.duration')} value={`${d.metrics.estimatedHours} h`} sub={t('plan.metric.estimateTotal')} />
            <Metric
              label={t('plan.metric.tokens')}
              value={tokens(d.metrics.estimatedTokens)}
              sub={
                d.metrics.budget === null
                  ? t('plan.noBudget')
                  : t('plan.budgetOf', { amount: tokens(d.metrics.budget) })
              }
              tone={d.metrics.overBudget ? 'danger' : 'normal'}
            />
            <Metric
              label={t('plan.metric.humanInvolved')}
              value={t('plan.countItems', { count: d.metrics.humanGateCount })}
              sub={t('plan.humanInvolvedHint')}
            />
            <Metric
              label={t('plan.metric.highRisk')}
              value={t('plan.countItems', { count: d.metrics.highRiskTasks })}
              sub={d.metrics.highRiskTasks > 0 ? t('plan.markedBelow') : t('plan.noneShort')}
              tone={d.metrics.highRiskTasks > 0 ? 'warn' : 'normal'}
            />
          </div>

          {d.metrics.overBudget && (
            <p className="rounded border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-800">
              {t('plan.overBudget', {
                spent: tokens(d.metrics.spent),
                estimated: tokens(d.metrics.estimatedTokens),
                budget: tokens(d.metrics.budget ?? 0),
              })}
            </p>
          )}

          {/* ── ★ 批准后将自动发生 —— 本页核心 ── */}
          <AutoActions detail={d} />

          {/* ── 任务拆解 ── */}
          <section className="rounded border border-slate-200 bg-white">
            <h2 className="border-b border-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700">
              {t('plan.taskBreakdown', { count: d.tasks.length })}
            </h2>
            <ul>
              {d.tasks.map((task) => (
                <li
                  key={task.id}
                  className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-xs last:border-0"
                >
                  <span aria-hidden>{typeIcon(task.type)}</span>
                  <span className="min-w-0 flex-1 truncate text-slate-800">{task.title}</span>
                  {/*
                    ★★ 批准之前就能逐条排人。
                      在此之前这里只能显示「会不会来找人」—— 用户要么全交给
                      调度器自动挑，要么批准之后再一张张打开卡片改。
                      人工任务尤其不能等：批下去没人接就会停在那里不动。
                  */}
                  <TaskAssignee
                    workItemId={task.id}
                    planId={planId!}
                    disabled={d.plan.status !== 'awaiting_approval'}
                  />
                  <span className="w-12 text-right tabular-nums text-slate-500">
                    {task.estimatedHours ?? '—'}h
                  </span>
                  <span className="w-14 text-right tabular-nums text-slate-500">
                    {task.estimatedTokens === null ? '—' : tokens(task.estimatedTokens)}
                  </span>
                  {(task.riskLevel === 'high' || task.riskLevel === 'critical') && (
                    <span className="w-20 shrink-0 text-right text-[11px] text-red-700">
                      🔴 {riskLabel(task.riskLevel)}
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
                {t('plan.assumptions', { count: d.assumptions.length })}
              </h2>
              <ul className="mt-1 space-y-0.5">
                {d.assumptions.map((a) => (
                  <li key={a.id} className="text-xs text-slate-600">
                    · {a.answer ?? a.question}
                    {!a.confirmed && (
                      <span className="ml-1 text-[11px] text-amber-700">{t('plan.noSecondConfirm')}</span>
                    )}
                  </li>
                ))}
              </ul>
              {d.plan.requirementId && (
                <Link
                  to={`/projects/${projectId}/requirements/${d.plan.requirementId}`}
                  className="mt-1 inline-block text-[11px] text-slate-500 underline"
                >
                  {t('plan.wrongGoToRequirement')}
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
                {t('plan.requestChanges')}
              </GatedButton>
              {/* ★ 批准计划要 tech_lead（§2.3）—— {t('plan.requestChanges')}不用，那只是打回去重做 */}
              <GatedButton
                permission="plan.approve"
                projectId={d.plan.projectId}
                onClick={() => setApproving(true)}
                className="rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
              >
                {t('plan.approveAndStart')}
              </GatedButton>
            </div>
          )}

          {/*
            ★★ 批准之后这一页此前只剩一句「已批准，任务已进入看板」，
              而下方那块红字仍写着「批准后会自动发生…」—— 一个已完成的事实
              和一句将来时的警告同屏，用户读不出「现在到底跑到哪了」
              （问题记录 #15）。
            ★ 补上「谁批的、什么时候、批完之后发生了什么」：批准状态本身
              信息量太低，从一行「Plan approved · 24m ago」推不出任何东西
              （问题记录 #31）。
          */}
          {approved && <ApprovedSummary detail={d} projectId={projectId!} />}
        </div>
      </div>

      {approving && (
        <ApproveDialog
          detail={d}
          pending={approve.isPending}
          onCancel={() => setApproving(false)}
          onConfirm={() => approve.mutate({ overrun: d.metrics.overBudget, unassigned: false })}
        />
      )}

      {/*
        ★ 单独一个确认框，不和超支那个合并：两者要用户判断的事完全不同 ——
          一个是「愿不愿意为此花钱」，一个是「这几项先没人接，行不行」。
      */}
      {unassigned && (
        <Modal onClose={() => setUnassigned(null)} title={t('plan.unassignedTitle')}>
          <h2 className="text-sm font-semibold text-slate-900">{t('plan.unassignedTitle')}</h2>
          <p className="mt-1 text-xs text-slate-600">
            {t('plan.unassignedIntro', { count: unassigned.length })}
          </p>
          <ul className="mt-1.5 space-y-0.5">
            {unassigned.map((task) => (
              <li key={task.id} className="text-[11px] text-slate-700">
                · {task.title}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-amber-800">{t('plan.unassignedWhy')}</p>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost"
              onClick={() => setUnassigned(null)}
              className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent text-xs text-slate-500"
            >
              {t('plan.unassignedGoAssign')}
            </Button>
            <Button
              variant="neutral"
              size="sm"
              disabled={approve.isPending}
              onClick={() => {
                setUnassigned(null);
                setApproving(false);
                approve.mutate({ overrun: d.metrics.overBudget, unassigned: true });
              }}
            >
              {t('plan.unassignedConfirm')}
            </Button>
          </div>
        </Modal>
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
/**
 * 已批准之后这一页该说什么。
 *
 * ★★ 此前只有一行「已批准（超级管理员）；任务已进入看板并开始推进」——
 *   而同屏下方那块红字还写着「批准后会自动发生…」。一个已完成的事实
 *   和一句将来时的警告并排，用户读不出「现在到底跑到哪了」
 *   （问题记录 #15）。
 *
 * ★★ 「Plan approved · 24m ago」这一条信息量太低：推不出谁批的、
 *   离交付还有多远、有没有卡住的（问题记录 #31）。这里把这份计划
 *   生出来的任务按状态数一遍 —— 那才是「批准之后发生了什么」。
 *
 * ★ 不新加接口：任务状态本来就在 `detail.tasks` 里。为「进度」再要一个
 *   端点，代价是它和看板各算一套，而两套数迟早对不上。
 */
function ApprovedSummary({ detail: d, projectId }: { detail: PlanDetail; projectId: string }) {
  const t = useT();

  const done = d.tasks.filter((x) => DONE_STATUSES.has(x.status)).length;
  const running = d.tasks.filter((x) => RUNNING_STATUSES.has(x.status)).length;
  const stuck = d.tasks.filter((x) => STUCK_STATUSES.has(x.status)).length;
  const waiting = d.tasks.length - done - running - stuck;

  return (
    <section className="rounded border border-green-200 bg-green-50 px-3 py-2">
      <p className="text-xs text-green-900">
        {t('plan.approvedNotice', {
          by: d.plan.approvedBy.length > 0 ? `（${d.plan.approvedBy.join('、')}）` : '',
        })}
      </p>
      {d.plan.approvedAt && (
        <p className="mt-0.5 text-[11px] text-green-800" title={absoluteTime(d.plan.approvedAt)}>
          {t('plan.approvedAt', { time: relativeTime(d.plan.approvedAt) })}
        </p>
      )}

      {/* ── 批准之后跑到哪了 ── */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
        <span className="text-slate-700">
          {t('plan.progress', { done, total: d.tasks.length })}
        </span>
        {running > 0 && <span className="text-sky-700">{t('plan.progress.running', { count: running })}</span>}
        {waiting > 0 && <span className="text-slate-500">{t('plan.progress.waiting', { count: waiting })}</span>}
        {/* ★ 卡住的单独标红并且直接给入口 —— 它是这一行里唯一需要人动手的部分 */}
        {stuck > 0 && (
          <Link
            to={`/projects/${projectId}/board?blocked=1`}
            className="font-medium text-red-700 underline-offset-2 hover:underline"
          >
            {t('plan.progress.stuck', { count: stuck })}
          </Link>
        )}
      </div>

      {/*
        ★★ 「现在还能改什么」。
          已批准的计划**不能**重新规划（服务端明确拒绝：改一份已经在跑的
          计划等于让看板上的任务和它的来源对不上）。所以这里不摆一排
          点了会报错的按钮，而是说清真正可走的两条路（问题记录 #32）。
      */}
      <div className="mt-1.5 flex flex-wrap items-center gap-2 border-t border-green-200 pt-1.5 text-[11px]">
        <span className="text-green-900">{t('plan.whatNow')}</span>
        <Link
          to={`/projects/${projectId}/board`}
          className="text-slate-600 underline-offset-2 hover:underline"
        >
          {t('plan.whatNow.board')}
        </Link>
        {d.plan.requirementId && (
          <Link
            to={`/projects/${projectId}/requirements/${d.plan.requirementId}`}
            className="text-slate-600 underline-offset-2 hover:underline"
          >
            {t('plan.whatNow.requirement')}
          </Link>
        )}
      </div>
    </section>
  );
}

/** 任务状态归三档。与看板同一口径，改这里要跟着改 KanbanView */
const DONE_STATUSES = new Set(['done', 'released', 'acceptance', 'cancelled']);
const RUNNING_STATUSES = new Set(['executing', 'reviewing', 'releasing']);
const STUCK_STATUSES = new Set(['blocked', 'failed', 'changes_requested', 'awaiting_decision']);

/**
 * 后果说明成句 —— 有码走码，没码回落到服务端那句中文。
 *
 * ★★ 这一段是**人类闸门上最要紧的文案**：批准之后哪些事会不经二次确认
 *   自动发生（含「自动创建 Pull Request」这种对外可见、收不回的动作）。
 *   它此前直接渲染服务端拼好的 `description`，于是英文界面上整块是中文 ——
 *   看不懂它的人，点下 Approve 时并不知道自己授权了什么。
 *
 * ★ 认不出的码回落到 `description` 而不是空白：存量计划快照里没有 code，
 *   而空白会让人以为「这里没什么会自动发生」—— 恰好是相反的意思。
 *
 * Assemble the consequence copy from the server's code + params. Unknown
 * codes fall back to the stored sentence, never to blank: an empty line here
 * reads as "nothing happens automatically", which is the opposite of the truth.
 */
function useConsequenceText() {
  const t = useT();
  return {
    auto: (a: PlanDetail['autoActions'][number]): string => {
      if (!a.code) return a.description;
      const params = a.params ?? {};
      /** ★ 带不带预算占比是两句话，不是一句话里塞个可空占位符 —— */
      /*    占位符取不到值时会原样留下 `{percent}` 摆在用户眼前。 */
      const key =
        a.code === 'token_estimate' && params['percent'] === undefined
          ? 'plan.auto.token_estimate'
          : a.code === 'token_estimate'
            ? 'plan.auto.token_estimate.withBudget'
            : (`plan.auto.${a.code}` as MessageKey);
      return t(key as MessageKey, params);
    },
    gate: (g: PlanDetail['humanGates'][number]): string =>
      g.code ? t(`plan.gate.${g.code}` as MessageKey, g.params ?? {}) : g.reason,
    assignee: (g: PlanDetail['humanGates'][number]): string =>
      g.assigneeHintCode ? t(`plan.assignee.${g.assigneeHintCode}` as MessageKey) : g.assigneeHint,
  };
}

function AutoActions({ detail: d }: { detail: PlanDetail }) {
  const t = useT();
  const say = useConsequenceText();
  const [expanded, setExpanded] = useState(false);
  const stale = d.plan.status !== 'approved' && d.autoActions.length > 0;

  return (
    <section className="rounded border border-amber-200 bg-amber-50 px-3 py-2">
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-medium text-amber-900">
          {t('plan.autoAfterApproval')}
        </h2>
        <Button variant="ghost"
          onClick={() => setExpanded((v) => !v)}
          className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent ml-auto text-[11px] text-amber-800 underline"
        >
          {expanded ? t('plan.collapse') : t('plan.viewEach')}
        </Button>
      </div>

      <ul className="mt-1 space-y-0.5">
        {d.autoActions.length === 0 && (
          <li className="text-xs text-amber-900">
            {t('plan.noAutoActions')}
          </li>
        )}
        {/*
          ★★ 估算与动作分开画。
            两者此前混在一串项目符号里，于是「预计消耗 …」旁边挂着一个
            「不可逆」标记 —— 读起来像「这笔用量一批就没了、退不回来」。
            估算既不是动作也不会「逆」，它只是一个上界（问题记录 #13）。
          ★ 「不可逆」用红底徽标而不是一行小红字：它是这一段里最该被看见的
            东西，而一行和正文同粗的小字会被当成脚注扫过去。
        */}
        {d.autoActions.map((a, i) => (
          <li key={i} className="flex flex-wrap items-baseline gap-1 text-xs leading-5 text-amber-900">
            <span aria-hidden>{a.kind === 'estimate' ? '≈' : '·'}</span>
            <span className="min-w-0">{say.auto(a)}</span>
            {a.kind === 'estimate' && (
              <span
                className="rounded bg-white/70 px-1 text-[10px] text-amber-800"
                title={t('plan.estimateHint')}
              >
                {t('plan.estimate')}
              </span>
            )}
            {a.externalVisible && (
              <span className="rounded bg-amber-200/60 px-1 text-[10px] text-amber-900">
                {t('plan.externallyVisible')}
              </span>
            )}
            {!a.reversible && a.kind === 'action' && (
              <span
                className="rounded bg-red-600 px-1 text-[10px] font-medium text-white"
                title={t('plan.irreversibleHint')}
              >
                {t('plan.irreversible')}
              </span>
            )}
          </li>
        ))}
      </ul>

      {d.humanGates.length > 0 && (
        <div className="mt-1.5 border-t border-amber-200 pt-1.5">
          {/*
            ★★ 分开数「要人干」与「要人批」。
              合成一个数字的话，「仍需人确认的（5）」里可能一条审批都没有 ——
              全是「这几件事得人做」，而用户是照着这个数字判断
              「批准之后还有多少道闸」的。
          */}
          <p className="text-[11px] text-amber-900">
            {/*
              ★ 两个数字各自变位，再由一句带占位符的整句把它们拼起来。
                英文 count=1 时是 needs 而不是 need，中文不分单复数 ——
                所以不能在渲染处拼「{n} need …」，那句话只在中文里恒成立。
            */}
            {t('plan.gateBreakdown', {
              approval: t('plan.gateApproval', {
                count: d.humanGates.filter((g) => g.cause === 'approval').length,
              }),
              execution: t('plan.gateExecution', {
                count: d.humanGates.filter((g) => g.cause === 'execution').length,
              }),
            })}
            {!expanded && ' ' + d.humanGates.map((g) => g.taskTitle).join(' · ')}
          </p>
          {expanded && (
            <ul className="mt-0.5 space-y-0.5">
              {d.humanGates.map((g, i) => (
                <li key={i} className="text-[11px] text-amber-900">
                  ·{' '}
                  <span
                    className={clsx(
                      'mr-1 rounded px-1 text-[10px]',
                      g.cause === 'approval'
                        ? 'bg-amber-200 text-amber-900'
                        : 'bg-slate-200 text-slate-700',
                    )}
                  >
                    {g.cause === 'approval' ? t('plan.causeApproval') : t('plan.causeExecution')}
                  </span>
                  {/*
                    ★ 破折号与括号也走词条：中文用「——」「（）」，英文用「—」「()」。
                      写死在 JSX 里的全角标点在英文句子中间会很突兀，
                      而这正是「不许拼句子」要防的那类问题的小号版本。
                  */}
                  <span className="font-medium">{g.taskTitle}</span>
                  {t('plan.gateReasonSep')}
                  {say.gate(g)}
                  <span className="ml-1 text-amber-700">
                    {t('plan.gateHint', { hint: say.assignee(g) })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {expanded && stale && (
        <p className="mt-1.5 border-t border-amber-200 pt-1.5 text-[11px] text-amber-700">
          {t('plan.staleBoundary', {
            auto: d.currentBoundary.auto.length,
            human: d.currentBoundary.human.length,
          })}
        </p>
      )}

      <Link
        to={`/projects/${d.plan.projectId}/settings/policies`}
        className="mt-1 inline-block text-[11px] text-amber-800 underline"
      >
        {t('plan.adjustRules')}
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
  const t = useT();
  const [acknowledged, setAcknowledged] = useState(false);
  const needsAck = d.metrics.overBudget;

  return (
    <Modal onClose={onCancel} title={t('plan.approveTitle')}>
      <div className="w-[28rem] max-w-full">
        <h2 className="text-sm font-semibold text-slate-900">{t('plan.approveTitle')}</h2>
        <div className="mt-2 space-y-1 text-xs text-slate-700">
          <p>
            {t('plan.confirmAgentTasks', {
              count: d.metrics.agentTasks,
              cost: tokens(d.metrics.estimatedTokens),
            })}
          </p>
          <p>{t('plan.confirmHumanGates', { count: d.metrics.humanGateCount })}</p>
          <p>{t('plan.approveStep')}</p>
        </div>

        {needsAck && (
          <Label className="mt-2 flex cursor-pointer items-start gap-1.5 rounded bg-red-50 px-2 py-1.5 text-xs text-red-800">
            <Checkbox
              tone="destructive"
              checked={acknowledged}
              onCheckedChange={setAcknowledged}
              className="mt-0.5"
            />
            {t('plan.acknowledgeOverBudget')}
          </Label>
        )}

        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent text-xs text-slate-500">
            {t('common.back')}
          </Button>
          <Button variant="neutral" size="sm"
            onClick={onConfirm}
            disabled={pending || (needsAck && !acknowledged)}>
            {pending ? t('plan.approving') : t('plan.approveAndStart')}
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
  const t = useT();
  const [feedback, setFeedback] = useState('');
  return (
    <Modal onClose={onCancel} title={t('plan.requestChangesTitle')}>
      <h2 className="text-sm font-semibold text-slate-900">{t('plan.requestChanges')}</h2>
      <p className="mt-1 text-xs text-slate-500">
        {t('plan.requestChangesHint')}
      </p>
      <Textarea
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        rows={3}
        placeholder={t('plan.requestPlaceholder')}
        className="mt-2"
      />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent text-xs text-slate-500">
          {t('common.cancel')}
        </Button>
        <Button variant="neutral" size="sm"
          onClick={() => onConfirm(feedback.trim())}
          disabled={!feedback.trim() || pending}>
          {pending ? t('plan.replanning') : t('plan.replan')}
        </Button>
      </div>
    </Modal>
  );
}
