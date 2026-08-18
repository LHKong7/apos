import { useT } from '../../lib/i18n';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { duration, riskLabel } from '../../lib/format';
import type { DecisionCard as Card } from '../../lib/api/types';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';

/**
 * 决策卡片 —— 就地拍板，不跳详情页。
 *
 * ★ 「5 分钟内清空当日队列」这个目标决定了这张卡片的形状：
 *   为什么需要你 / 不处理会怎样 / 有哪些选项，全部展开在列表里。
 *   每多一次「点进去看看」，清空队列就多花一分钟 ——
 *   而一个清不空的队列，就是产品那句「需要你的时候我会来找你」失效的开始。
 */
export function DecisionCardView({
  card,
  selected,
  onSelect,
  showSelectColumn,
}: {
  card: Card;
  selected: boolean;
  onSelect: ((next: boolean) => void) | null;
  /** 整个队列一条都不能批量时就不留这一列 —— 一排空占位比没有更碍眼 */
  showSelectColumn: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [mode, setMode] = useState<null | 'approve' | 'reject'>(null);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: qk.decisionInboxAll() });
    void qc.invalidateQueries({ queryKey: qk.decisionsAll() });
    void qc.invalidateQueries({ queryKey: ['board'] });
    void qc.invalidateQueries({ queryKey: qk.overview(card.projectId) });
  };

  const approve = useMutation({
    mutationFn: () => api.approveDecision(card.id, { note: note || undefined }),
    onSuccess: invalidate,
  });
  const reject = useMutation({
    mutationFn: () => api.rejectDecision(card.id, reason),
    onSuccess: invalidate,
  });
  const error = approve.error ?? reject.error;

  const overdue = card.overdueMinutes !== null;

  return (
    <li
      className={clsx(
        'rounded border bg-white',
        overdue ? 'border-red-200' : 'border-slate-200',
        selected && 'ring-1 ring-slate-900',
      )}
    >
      <div className="flex items-start gap-2 px-3 py-2">
        {/* ★ 只有可逆且非高风险的决策才给勾选框 —— 见 index.tsx 的批量说明 */}
        {showSelectColumn && (
          <div className="w-4 shrink-0 pt-0.5">
            {onSelect ? (
              <Checkbox
                checked={selected}
                onCheckedChange={onSelect}
                aria-label={t('decision.selectOne', { title: card.title })}
              />
            ) : (
              <span
                className="cursor-help text-[11px] text-slate-400"
                title={t('decision.gateHint')}
                aria-hidden
              >
                ·
              </span>
            )}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm text-slate-900">{card.title}</span>
            <span className="rounded bg-slate-100 px-1 text-[10px] text-slate-600">
              {card.typeLabel}
            </span>
            <span
              className={clsx(
                'text-[11px]',
                card.riskLevel === 'critical' || card.riskLevel === 'high'
                  ? 'text-amber-700'
                  : 'text-slate-500',
              )}
            >
              {riskLabel(card.riskLevel)}
            </span>
            {!card.reversible && <span className="text-[11px] text-red-700">{t('decision.irreversible')}</span>}
            {/* ★ 时限是这一页的主排序依据，所以它必须一眼可见 */}
            {overdue ? (
              <span className="text-[11px] font-medium text-red-700">
                {t('decision.overdueBy', { time: duration(card.overdueMinutes) })}
              </span>
            ) : card.dueInMinutes !== null ? (
              <span
                className={clsx(
                  'text-[11px]',
                  card.dueInMinutes <= 240 ? 'text-amber-700' : 'text-slate-500',
                )}
              >
                {t('decision.dueWithin', { time: duration(card.dueInMinutes) })}
              </span>
            ) : (
              <span className="text-[11px] text-slate-400">{t('decision.noDeadline')}</span>
            )}
            <span className="text-[11px] text-slate-400">
              {t('decision.waited', { time: duration(card.waitingMinutes) })}
            </span>
          </div>

          <p className="mt-0.5 text-[11px] text-slate-500">
            {card.projectName}
            {card.workItemId && (
              <>
                {' · '}
                <Link
                  to={`/projects/${card.projectId}/board?item=${card.workItemId}`}
                  className="underline-offset-2 hover:underline"
                >
                  {card.workItemTitle}
                </Link>
              </>
            )}
            {card.runId && (
              <>
                {' · '}
                <Link
                  to={`/runs/${card.runId}`}
                  className="underline-offset-2 hover:underline"
                >
                  {t('decision.runRecord')}
                </Link>
              </>
            )}
            {card.assigneeName && <>{t('decision.assignee', { name: card.assigneeName })}</>}
          </p>

          {/* 为什么需要人 —— 指明触发的规则，而不是「系统要求」 */}
          <p className="mt-1 text-xs text-slate-700">{card.whyHuman}</p>
          {card.consequence && (
            <p className="mt-0.5 text-xs text-amber-800">{t('decision.consequence', { consequence: card.consequence })}</p>
          )}
          {card.agentSelfReport && (
            <p className="mt-0.5 text-[11px] text-slate-500">
              {t('itemDrawer.agentSelfReport', { report: card.agentSelfReport })}
            </p>
          )}

          {card.options.length > 0 && (
            <ul className="mt-1 space-y-1">
              {card.options.map((o) => (
                <li
                  key={o.id}
                  className={clsx(
                    'rounded border px-2 py-1',
                    o.isRecommended ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200',
                  )}
                >
                  <p className="text-xs">
                    <span className="text-slate-800">{o.name}</span>
                    {o.isRecommended && (
                      <span className="ml-1 rounded bg-emerald-600 px-1 text-[10px] text-white">
                        {t('decision.agentPrefers')}
                      </span>
                    )}
                  </p>
                  {o.description && <p className="text-[11px] text-slate-600">{o.description}</p>}
                  {o.rationale && (
                    <p className="text-[11px] text-emerald-800">{t('decision.rationale', { rationale: o.rationale })}</p>
                  )}
                  {/* ★ 不确定性和理由一样重要：只给理由的建议看起来永远是对的 */}
                  {o.uncertainties.length > 0 && (
                    <p className="text-[11px] text-amber-700">
                      {t('decision.uncertainties', { list: o.uncertainties.join('；') })}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* ── 就地处理 ── */}
          {approve.isSuccess || reject.isSuccess ? (
            <p className="mt-1 text-xs text-slate-500">
              {approve.isSuccess ? t('decision.approved') : t('decision.rejected')}
            </p>
          ) : !card.canAct ? (
            <p className="mt-1 text-[11px] text-amber-800">
              {t('decision.cannotDelegate', { name: card.assigneeName ?? t('decision.others') })}
            </p>
          ) : mode === null ? (
            <div className="mt-1.5 flex gap-1.5">
              <Button variant="ghost"
                onClick={() => setMode('approve')}
                className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent rounded bg-emerald-600 px-2 py-0.5 text-xs text-white hover:bg-emerald-700"
              >
                {t('decDrawer.approve')}
              </Button>
              <Button variant="outline" size="sm"
                onClick={() => setMode('reject')}>
                {t('decDrawer.reject')}
              </Button>
            </div>
          ) : mode === 'approve' ? (
            <div className="mt-1.5 space-y-1">
              <Input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t('decision.noteOptional')} />
              <div className="flex gap-1.5">
                <Button variant="ghost"
                  disabled={approve.isPending}
                  onClick={() => approve.mutate()}
                  className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent rounded bg-emerald-600 px-2 py-0.5 text-xs text-white hover:bg-emerald-700 disabled:opacity-40"
                >
                  {approve.isPending ? t('decision.submitting') : t('decision.confirmApprove')}
                </Button>
                <Button variant="ghost"
                  onClick={() => setMode(null)}
                  className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent text-xs text-slate-500 hover:text-slate-700"
                >
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-1.5 space-y-1">
              {/* ★ 驳回必须写原因 —— 「每次覆盖都要留下为什么」是这个系统的底线，
                  也是 Analytics 里「重复决策能不能变成规则」的唯一数据来源 */}
              <Input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('decision.rejectReason')} />
              <div className="flex gap-1.5">
                <Button variant="destructive" size="sm"
                  disabled={!reason.trim() || reject.isPending}
                  onClick={() => reject.mutate()}>
                  {reject.isPending ? t('decision.submitting') : t('decision.confirmReject')}
                </Button>
                <Button variant="ghost"
                  onClick={() => setMode(null)}
                  className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent text-xs text-slate-500 hover:text-slate-700"
                >
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          )}

          {error && (
            <p className="mt-1 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
              {error instanceof ApiError ? error.message : t('decision.actionFailed')}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}
