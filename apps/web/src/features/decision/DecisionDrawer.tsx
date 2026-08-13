import { useT } from '../../lib/i18n';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { deadline, riskLabel } from '../../lib/format';
import { QueryBoundary } from '../../components/states';
import { useAuthStore } from '../../stores/auth';
import { Drawer } from '../../components/Drawer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

interface Props {
  decisionId: string;
  onClose: () => void;
}

/**
 * 决策处理抽屉。
 *
 * 三件事必须在这里说清楚，否则人只能凭感觉拍板：
 * 1. 为什么需要人（whyHuman）—— 指明触发的 Policy
 * 2. 不处理会怎样（consequence）—— 把紧迫性变成具体后果
 * 3. Agent 给了哪些选项、倾向哪个、为什么
 */
export function DecisionDrawer({ decisionId, onClose }: Props) {
  const t = useT();
  const qc = useQueryClient();
  const currentUserId = useAuthStore((s) => s.userId);

  const query = useQuery({
    queryKey: qk.decision(decisionId),
    queryFn: () => api.decision(decisionId),
  });

  const [note, setNote] = useState('');
  const [constraint, setConstraint] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [mode, setMode] = useState<'approve' | 'reject'>('approve');

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: qk.decisionsAll() });
    void qc.invalidateQueries({ queryKey: ['board'] });
    void qc.invalidateQueries({ queryKey: qk.decision(decisionId) });
  };

  const approve = useMutation({
    mutationFn: () =>
      api.approveDecision(decisionId, {
        note: note || undefined,
        constraints: constraint.trim()
          ? [
              {
                type: 'freeform',
                value: null,
                description: constraint.trim(),
                // 自由文本约束只能靠 Agent 自觉遵守，如实标注
                enforcement: 'agent',
              },
            ]
          : [],
      }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  const reject = useMutation({
    mutationFn: () => api.rejectDecision(decisionId, rejectReason),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  const error = approve.error ?? reject.error;

  return (
    <Drawer title={t('decDrawer.title')} onClose={onClose}>
      <QueryBoundary query={query}>
        {({ decision, options, workItem }) => {
          const due = deadline(decision.dueInMinutes);
          // 决策责任不可代行（docs/tech/09-security.md §2.4）
          const notMine = Boolean(decision.assigneeId && decision.assigneeId !== currentUserId);
          const resolved = decision.status !== 'pending';

          return (
            <div className="space-y-4 text-sm">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold text-slate-900">{decision.title}</h3>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                    {riskLabel(decision.riskLevel)}
                  </span>
                  {due.text && (
                    <span
                      className={clsx(
                        'text-[11px]',
                        due.overdue ? 'font-medium text-red-700' : 'text-amber-700',
                      )}
                    >
                      ⏰ {due.text}
                    </span>
                  )}
                </div>
                {workItem && (
                  <p className="mt-1 text-xs text-slate-500">{t('decDrawer.linkedItem', { title: workItem.title })}</p>
                )}
              </div>

              <Section title={t('decDrawer.whyYou')}>
                <p>{decision.whyHuman}</p>
              </Section>

              {decision.consequence && (
                <Section title={t('decDrawer.ifIgnored')}>
                  <p className="text-amber-800">{decision.consequence}</p>
                </Section>
              )}

              {decision.background && (
                <Section title={t('decDrawer.background')}>
                  <p className="whitespace-pre-wrap text-slate-600">{decision.background}</p>
                </Section>
              )}

              {options.length > 0 && (
                <Section title={t('decDrawer.agentOptions')}>
                  <ul className="space-y-2">
                    {options.map((o) => (
                      <li
                        key={o.id}
                        className={clsx(
                          'rounded border p-2',
                          o.isRecommended
                            ? 'border-emerald-300 bg-emerald-50'
                            : 'border-slate-200',
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-slate-800">{o.name}</span>
                          {o.isRecommended && (
                            <span className="rounded bg-emerald-600 px-1 text-[10px] text-white">
                              Agent 倾向 {o.confidence ? `${Math.round(Number(o.confidence) * 100)}%` : ''}
                            </span>
                          )}
                        </div>
                        {o.description && (
                          <p className="mt-0.5 text-xs text-slate-600">{o.description}</p>
                        )}
                        {typeof o.attributes['consequence'] === 'string' && (
                          <p className="mt-0.5 text-xs text-slate-500">
                            后果：{o.attributes['consequence']}
                          </p>
                        )}
                        {o.rationale && (
                          <p className="mt-0.5 text-xs text-emerald-800">{t('decision.rationale', { rationale: o.rationale })}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {resolved ? (
                <p className="rounded bg-slate-100 px-3 py-2 text-xs text-slate-600">
                  该决策已被处理（{decision.status}）
                </p>
              ) : notMine ? (
                <p className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  该决策的责任人不是你。决策责任不可代行 —— 如需变更责任人，请使用改派。
                </p>
              ) : (
                <div className="space-y-3 border-t border-slate-200 pt-3">
                  <div className="flex gap-1">
                    <TabButton active={mode === 'approve'} onClick={() => setMode('approve')}>
                      批准
                    </TabButton>
                    <TabButton active={mode === 'reject'} onClick={() => setMode('reject')}>
                      驳回
                    </TabButton>
                  </div>

                  {mode === 'approve' ? (
                    <>
                      <Field label={t('decDrawer.note')}>
                        <Textarea
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          rows={2}
                        />
                      </Field>
                      <Field label={t('decDrawer.constraint')}>
                        <Input
                          type="text"
                          value={constraint}
                          onChange={(e) => setConstraint(e.target.value)}
                          placeholder={t('decDrawer.constraintPlaceholder')} />
                        <p className="mt-0.5 text-[11px] text-slate-400">
                          约束会写入任务并下发给 Agent，执行时必须遵守
                        </p>
                      </Field>
                      <button
                        type="button"
                        disabled={approve.isPending}
                        onClick={() => approve.mutate()}
                        className="w-full rounded bg-emerald-600 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
                      >
                        {approve.isPending ? t('decision.submitting') : t('decDrawer.approveAndContinue')}
                      </button>
                    </>
                  ) : (
                    <>
                      <Field label={t('decDrawer.rejectReason')}>
                        <Textarea
                          value={rejectReason}
                          onChange={(e) => setRejectReason(e.target.value)}
                          rows={2}
                        />
                      </Field>
                      <Button variant="destructive" size="sm"
                        disabled={!rejectReason.trim() || reject.isPending}
                        onClick={() => reject.mutate()}
                        className="w-full">
                        {reject.isPending ? t('decision.submitting') : t('decDrawer.reject')}
                      </Button>
                    </>
                  )}

                  {error && (
                    <p className="rounded bg-red-50 px-2 py-1.5 text-xs text-red-700">
                      {error instanceof ApiError ? error.message : t('decision.actionFailed')}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        }}
      </QueryBoundary>
    </Drawer>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
        {title}
      </h4>
      <div className="text-xs text-slate-700">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function TabButton({
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
