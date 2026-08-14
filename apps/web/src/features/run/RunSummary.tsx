import { useT, type MessageKey } from '../../lib/i18n';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { AssigneeChip } from '../../components/AssigneeChip';
import { duration, relativeTime, statusLabel, tokens } from '../../lib/format';
import { Section } from './tabs';
import type { RunDetail } from '../../lib/api/types';

/**
 * 右侧概要栏（页面文档 09 §5.8）。
 *
 * 执行流回答「做了什么」，这一栏回答「这次执行是什么」——
 * 元信息、成本、工具统计、人类干预、产物、关联对象。
 * 两者并排是因为排障时要来回对照：看到某个工具调了 12 次，
 * 眼睛不用离开时间线就能在右边确认它确实是调用最多的那个。
 */
export function RunSummary({ detail }: { detail: RunDetail }) {
  const t = useT();
  const { run, metrics, related } = detail;
  const spent = metrics.tokens.total;
  const limit = metrics.tokenLimit;
  const estimated = metrics.estimatedTokens;

  return (
    <aside className="w-64 shrink-0 space-y-4 overflow-y-auto border-l border-slate-200 p-3 text-xs">
      <Section title={t('runSum.summary')}>
        <dl className="grid grid-cols-[3.5rem_1fr] gap-y-1 text-slate-700">
          <dt className="text-slate-400">{t('runSum.status')}</dt>
          <dd>{statusLabel(run.status)}</dd>
          <dt className="text-slate-400">{t('runSum.attempt')}</dt>
          <dd>
            {t('runSum.attemptNo', { n: run.attempt })}
            {related.previousRun && (
              <span className="ml-1 text-slate-400">{t('runSum.previousStatus', { status: related.previousRun.status })}</span>
            )}
          </dd>
          <dt className="text-slate-400">{t('runSum.workItem')}</dt>
          <dd className="truncate">{detail.workItem?.title ?? '—'}</dd>
          <dt className="text-slate-400">{t('runSum.project')}</dt>
          <dd className="truncate">{detail.project?.name ?? '—'}</dd>
          <dt className="text-slate-400">{t('runSum.started')}</dt>
          <dd>{relativeTime(run.startedAt)}</dd>
          <dt className="text-slate-400">{t('runSum.elapsed')}</dt>
          <dd>
            {duration(metrics.durationMs / 60_000)}
            {run.timeoutAt && !run.endedAt && (
              <span className="text-slate-400">
                {' '}
                {t('runSum.timeoutAfter', {
                  duration: duration(
                    (new Date(run.timeoutAt).getTime() - new Date(run.startedAt).getTime()) / 60_000,
                  ),
                })}
              </span>
            )}
          </dd>
        </dl>
      </Section>

      <Section title={t('runSum.tokens')}>
        <dl className="grid grid-cols-[3.5rem_1fr] gap-y-1 tabular-nums text-slate-700">
          <dt className="text-slate-400">{t('runSum.current')}</dt>
          <dd>{tokens(spent)}</dd>
          {estimated !== null && (
            <>
              <dt className="text-slate-400">{t('runSum.estimated')}</dt>
              <dd className={spent > estimated ? 'text-amber-700' : undefined}>
                {tokens(estimated)}
                {spent > estimated && estimated > 0 && (
                  <span className="ml-1">
                    {t('runSum.overBy', {
                      percent: (((spent - estimated) / estimated) * 100).toFixed(0),
                    })}
                  </span>
                )}
              </dd>
            </>
          )}
          {limit !== null && (
            <>
              <dt className="text-slate-400">{t('runSum.cap')}</dt>
              <dd>
                <div className="flex items-center gap-1">
                  <span className="h-1 w-14 overflow-hidden rounded-full bg-slate-200">
                    <span
                      className={clsx(
                        'block h-full',
                        spent / limit > 0.8 ? 'bg-overdue' : 'bg-emerald-500',
                      )}
                      style={{ width: `${Math.min((spent / limit) * 100, 100)}%` }}
                    />
                  </span>
                  <span>{((spent / limit) * 100).toFixed(0)}%</span>
                </div>
              </dd>
            </>
          )}
        </dl>
      </Section>

      <Section title={t('runSum.toolCalls', { count: metrics.toolCalls.total })}>
        {metrics.toolCalls.total === 0 ? (
          <p className="text-slate-400">{t('runSum.noToolCalls')}</p>
        ) : (
          <ul className="space-y-0.5 tabular-nums text-slate-700">
            {Object.entries(metrics.toolCalls.byTool).map(([tool, n]) => (
              <li key={tool} className="flex justify-between gap-2">
                <span className="truncate font-mono text-[11px]">{tool}</span>
                <span className="text-slate-500">{n}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {detail.interventions.length > 0 && (
        <Section title={t('runSum.interventions', { count: detail.interventions.length })}>
          <ul className="space-y-1">
            {detail.interventions.map((e) => (
              <li key={e.id} className="text-slate-700">
                <AssigneeChip actor={{ type: 'human', id: e.actorId ?? '', name: e.actorName }} size="sm" />
                <span className="ml-1 text-[11px] text-slate-500">
                  {/* ★ 认不出的类型回落到原始值，而不是渲染词条键本身 */}
                  {INTERVENTION_KEYS[e.type] ? t(INTERVENTION_KEYS[e.type]!) : e.type}
                </span>
                {typeof e.payload['reason'] === 'string' && (
                  <p className="mt-0.5 text-[11px] text-slate-500">「{e.payload['reason']}」</p>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {related.attempts.length > 1 && (
        <Section title={t('runSum.attempts')}>
          <ul className="space-y-0.5">
            {related.attempts.map((a) => (
              <li key={a.id}>
                <Link
                  to={`/runs/${a.id}`}
                  className={clsx(
                    'flex justify-between gap-2 rounded px-1 py-0.5 hover:bg-slate-100',
                    a.id === run.id && 'bg-slate-100 font-medium',
                  )}
                >
                  <span>{t('runSum.attemptStatus', { n: a.attempt, status: statusLabel(a.status) })}</span>
                  <span className="tabular-nums text-slate-500">{tokens(a.tokens)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {related.policies.length > 0 && (
        <Section title={t('runSum.policyHits')}>
          <ul className="space-y-0.5 text-slate-700">
            {related.policies.map((p) => (
              <li key={p.eventId} className="truncate">
                ⚖ {p.policyName}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {related.decisions.length > 0 && (
        <Section title={t('runSum.decisions')}>
          <ul className="space-y-0.5 text-slate-700">
            {related.decisions.map((d) => (
              <li key={d.id} className="truncate">
                {d.status === 'pending' ? '⚡' : '✓'} {d.title}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </aside>
  );
}

/** 人工干预类型 → 词条键 / Intervention type → message key */
const INTERVENTION_KEYS: Record<string, MessageKey> = {
  'work_item.taken_over': 'runSum.tookOver',
  'work_item.force_passed': 'runSum.forcePassed',
  'work_item.status_changed': 'runSum.manualStatus',
  'agent_run.terminated': 'runSum.terminated',
  'agent_run.constraint_added': 'runSum.addedConstraint',
  'decision.approved': 'runSum.approvedDecision',
  'decision.rejected': 'runSum.rejectedDecision',
};
