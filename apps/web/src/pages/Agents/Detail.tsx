import { useT } from '../../lib/i18n';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { duration, relativeTime, riskLabel, statusLabel, tokens } from '../../lib/format';
import { CardSkeleton, ErrorState } from '../../components/states';
import { Modal } from '../../features/work-item/ManualMoveDialog';
import { CapabilityPanel } from './CapabilityPanel';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

/** 队列里动不了的状态 —— 这几项要看得出来，否则「队列 5」读起来像在忙 */
const STALLED = new Set(['blocked', 'failed', 'awaiting_decision']);

const SEVERITY_TONE = {
  destructive: 'text-red-700',
  external: 'text-orange-700',
  write: 'text-amber-700',
  read: 'text-slate-500',
  none: 'text-slate-400',
} as const;

/**
 * Agent 工作区（页面文档 08）。
 *
 * ★ 「员工档案 + 工作台」，不是服务配置页。顺序也照这个来：
 *   它是谁 → 在做什么 → 做得怎么样 → 被允许做什么 → 出问题怎么干预。
 *   把权限表放在最上面，这一页就退化成一个 YAML 编辑器了。
 */
export function AgentDetailPage() {
  const t = useT();
  const { projectId, agentId } = useParams<{ projectId?: string; agentId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [pausing, setPausing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: qk.agentDetail(agentId!),
    queryFn: () => api.agentDetail(agentId!),
    enabled: Boolean(agentId),
  });

  const pause = useMutation({
    mutationFn: (v: { paused: boolean; reason?: string }) =>
      api.pauseAgent(agentId!, v.paused, v.reason),
    onSuccess: () => {
      setPausing(false);
      void qc.invalidateQueries({ queryKey: qk.agentDetail(agentId!) });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t('agentDetail.actionFailed')),
  });

  if (!agentId) return null;
  if (detail.isPending) return <div className="p-4"><CardSkeleton /></div>;
  if (detail.isError) {
    return (
      <div className="p-4">
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const d = detail.data!;
  const a = d.agent;
  const paused = a.status === 'paused';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-slate-900">🤖 {a.name}</h1>
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
            {a.type}
          </span>
          {a.model && <span className="text-[11px] text-slate-400">{a.model}</span>}
          <span className={clsx('text-[11px]', paused ? 'text-amber-700' : 'text-green-700')}>
            ● {paused ? t('agentDetail.paused') : t('agentDetail.normal')}
          </span>
          <Link
            to={projectId ? `/projects/${projectId}/agents` : '/agents'}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            {t('agentDetail.backToTeam')}
          </Link>
          <Button variant="outline" size="sm"
            onClick={() => (paused ? pause.mutate({ paused: false }) : setPausing(true))}
            className="ml-auto">
            {paused ? t('agentDetail.resume') : t('agentDetail.pause')}
          </Button>
        </div>
        {a.description && <p className="mt-0.5 text-xs text-slate-500">{a.description}</p>}
        {paused && a.pausedReason && (
          <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
            {t('agentDetail.pausedReason', { reason: a.pausedReason })}
          </p>
        )}
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

          {/* ── 干得怎么样 ── */}
          {d.performance && (
            <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
              <Stat label={t('agentDetail.runs')} value={String(d.performance.runs)} sub={t('agentDetail.last30d')} />
              <Stat
                label={t('agentDetail.successRate')}
                value={`${Math.round(d.performance.successRate * 100)}%`}
                tone={d.performance.successRate < 0.8 ? 'warn' : 'normal'}
              />
              <Stat
                label={t('agentDetail.firstTryRate')}
                value={`${Math.round(d.performance.firstTrySuccessRate * 100)}%`}
                sub={t('agentDetail.firstTryHint')}
                tone={d.performance.firstTrySuccessRate < 0.6 ? 'warn' : 'normal'}
              />
              <Stat
                label={t('agentDetail.avgTokens')}
                value={tokens(d.performance.avgTokens)}
                sub={t('agentDetail.totalTokens', { amount: tokens(d.performance.totalTokens) })}
              />
              <Stat
                label={t('agentDetail.avgDuration')}
                value={d.performance.avgMinutes === null ? '—' : `${d.performance.avgMinutes}m`}
              />
            </div>
          )}

          {/* ── 在做什么 ──
              ★ 只列没做完的。历史归属算进「队列」的话，一个干了半年的 Agent
                会显示「队列 200」，而它其实闲着。 */}
          <section className="rounded border border-slate-200 bg-white">
            <h2 className="flex flex-wrap items-baseline gap-2 border-b border-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700">
              {t('agentDetail.queue', { count: d.queue.length })}
              {d.queueDoneCount > 0 && (
                <span className="text-[11px] font-normal text-slate-400">
                  {t('agentDetail.queueDoneNote', { count: d.queueDoneCount })}
                </span>
              )}
            </h2>
            {d.queue.length === 0 ? (
              <p className="px-3 py-3 text-center text-xs text-slate-400">
                {t('agentDetail.queueEmpty')}
                {d.queueDoneCount > 0 && t('agentDetail.queueDone', { count: d.queueDoneCount })}
              </p>
            ) : (
              <ul>
                {d.queue.map((q) => (
                  <li
                    key={q.id}
                    className="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-xs last:border-0"
                  >
                    <span className="min-w-0 flex-1 truncate text-slate-800">{q.title}</span>
                    <span
                      className={clsx(
                        STALLED.has(q.status) ? 'text-amber-700' : 'text-slate-500',
                      )}
                    >
                      {statusLabel(q.status)}
                    </span>
                    <span className="text-slate-400">{riskLabel(q.riskLevel)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/*
            ★ 权限独立配置，绝不继承人类用户（产品文档 十）。
              黑名单单独列，并标注它压过白名单 —— 一个看不出边界的
              Agent 档案，等于没有边界。
          */}
          <section className="rounded border border-slate-200 bg-white px-3 py-2">
            <h2 className="text-xs font-medium text-slate-700">{t('agentDetail.permissions')}</h2>
            <p className="text-[11px] text-slate-400">
              {t('agentDetail.permissionsHint')}
            </p>

            <div className="mt-1.5 grid gap-2 md:grid-cols-2">
              <div>
                <p className="text-[11px] text-slate-500">{t('agentDetail.allowedTools', { count: d.permissions.allowedTools.length })}</p>
                <p className="text-xs text-slate-700">
                  {d.permissions.allowedTools.length === 0
                    ? t('agentDetail.none')
                    : d.permissions.allowedTools.join('、')}
                </p>
              </div>
              <div>
                <p className="text-[11px] text-slate-500">
                  {t('agentDetail.deniedTools', { count: d.permissions.deniedTools.length })}
                  <span className="ml-1 text-slate-400">{t('agentDetail.denyWins')}</span>
                </p>
                <p className="text-xs text-red-700">
                  {d.permissions.deniedTools.length === 0
                    ? t('agentDetail.none')
                    : d.permissions.deniedTools.join('、')}
                </p>
              </div>
            </div>

            {d.permissions.resourceScopes.length > 0 && (
              <div className="mt-1.5">
                <p className="text-[11px] text-slate-500">{t('agentDetail.resourceScopes')}</p>
                <ul className="space-y-0.5">
                  {d.permissions.resourceScopes.map((s, i) => (
                    <li key={i} className="text-xs text-slate-700">
                      · {s.kind} <span className="text-slate-500">{s.ref}</span>
                      <span
                        className={clsx(
                          'ml-1',
                          s.access === 'write' ? 'text-amber-700' : 'text-slate-500',
                        )}
                      >
                        {s.access === 'write' ? t('agentDetail.write') : s.access === 'read' ? t('agentDetail.read') : t('agentDetail.noAccess')}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-1.5 flex flex-wrap gap-3 border-t border-slate-100 pt-1.5 text-[11px] text-slate-500">
              <span>{t('agentDetail.maxConcurrency', { n: a.maxConcurrency })}</span>
              <span>{t('agentDetail.timeoutMinutes', { n: Math.round(a.timeoutSeconds / 60) })}</span>
              <span>
                {t('agentDetail.tokenLimitPerRun')}{' '}
                {a.tokenLimitPerRun === null ? t('agentDetail.unset') : tokens(a.tokenLimitPerRun)}
              </span>
              <span>{t('agentDetail.ownerName', { name: a.ownerName })}</span>
            </div>

            {d.permissionChanges.length > 0 && (
              <div className="mt-1.5 border-t border-slate-100 pt-1.5">
                <p className="text-[11px] text-slate-500">{t('agentDetail.permissionHistory')}</p>
                <ul className="space-y-0.5">
                  {d.permissionChanges.map((c, i) => (
                    <li key={i} className="text-[11px] text-slate-600">
                      · {relativeTime(c.createdAt)} {c.changedBy}
                      <span
                        className={clsx(
                          'ml-1',
                          c.direction === 'loosen' ? 'text-amber-700' : 'text-slate-500',
                        )}
                      >
                        {c.direction === 'loosen' ? t('agentDetail.loosened') : t('agentDetail.tightened')}
                      </span>
                      {c.reason && <span className="ml-1 text-slate-400">{c.reason}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* ── 运行时能做什么 ── */}
          {d.capability ? (
            <CapabilityPanel report={d.capability} runtimeName={a.runtime?.name ?? t('agentDetail.unknownRuntime')} />
          ) : (
            <section className="rounded border border-dashed border-slate-300 bg-white px-3 py-2">
              <h2 className="text-xs font-medium text-slate-700">{t('agentDetail.capabilities')}</h2>
              <p className="mt-0.5 text-[11px] text-slate-500">
                {t('agentDetail.adapterUnregistered')}
              </p>
            </section>
          )}

          {/* ── 最近执行 ── */}
          <section className="rounded border border-slate-200 bg-white">
            <h2 className="border-b border-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700">
              {t('agentDetail.recentRuns', { count: d.recentRuns.length })}
            </h2>
            {d.recentRuns.length === 0 ? (
              <p className="px-3 py-3 text-center text-xs text-slate-400">{t('agentDetail.noRuns')}</p>
            ) : (
              <ul>
                {d.recentRuns.map((r) => (
                  <li key={r.id} className="border-b border-slate-100 last:border-0">
                    <Button variant="ghost"
                      onClick={() => navigate(`/runs/${r.id}`)}
                      className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent justify-start flex w-full flex-wrap items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-slate-50"
                    >
                      <span
                        className={clsx(
                          'w-14',
                          r.status === 'completed'
                            ? 'text-green-700'
                            : r.status === 'failed'
                              ? 'text-red-700'
                              : 'text-slate-500',
                        )}
                      >
                        {r.status === 'completed' ? t('agentDetail.runOk') : r.status === 'failed' ? t('agentDetail.runFail') : r.status}
                      </span>
                      {/*
                        ★ 规划 Run 现在也出现在这张表里（它以前根本不落库）。
                          标出来是必要的：一条没有工作项的执行记录混在里面，
                          不加标签只会让人以为是数据错了。
                      */}
                      {r.kind === 'planning' && (
                        <span className="shrink-0 rounded bg-sky-100 px-1 text-[10px] text-sky-800">
                          {t('agentDetail.planningRun')}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-slate-800">
                        {r.workItemTitle}
                      </span>
                      {r.attempt > 1 && (
                        <span className="text-[11px] text-amber-700">{t('agentDetail.attemptN', { n: r.attempt })}</span>
                      )}
                      {r.errorClass && (
                        <span className="text-[11px] text-red-600">{r.errorClass}</span>
                      )}
                      <span className="tabular-nums text-slate-500">{tokens(r.tokens)}</span>
                      <span className="text-[11px] text-slate-400">
                        {r.startedAt ? relativeTime(r.startedAt) : '—'}
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="text-[11px] text-slate-400">
            {t('agentDetail.sideEffectNote')}
            <span className={SEVERITY_TONE.destructive}>{t('agentDetail.destructive')}</span>{' '}{t('agentDetail.andJoin')}{' '}
            <span className={SEVERITY_TONE.external}>{t('agentDetail.external')}</span>{t('agentDetail.effectNote')}
            {t('agentDetail.stillGated')}
          </p>
        </div>
      </div>

      {pausing && (
        <PauseDialog
          name={a.name}
          pending={pause.isPending}
          onCancel={() => setPausing(false)}
          onConfirm={(reason) => pause.mutate({ paused: true, reason })}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone = 'normal',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'normal' | 'warn';
}) {
  return (
    <div className="rounded border border-slate-200 bg-white px-3 py-2">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p
        className={clsx(
          'mt-0.5 text-lg font-semibold',
          tone === 'warn' ? 'text-amber-700' : 'text-slate-900',
        )}
      >
        {value}
      </p>
      {sub && <p className="truncate text-[11px] text-slate-400">{sub}</p>}
    </div>
  );
}

/** 暂停必须填原因 —— 一个停着的 Agent 会安静地让整个项目慢下来 */
function PauseDialog({
  name,
  pending,
  onCancel,
  onConfirm,
}: {
  name: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  return (
    <Modal onClose={onCancel} title={t('agentDetail.pauseTitle')}>
      <h2 className="text-sm font-semibold text-slate-900">{t('agentDetail.pauseTitleName', { name })}</h2>
      <p className="mt-1 text-xs text-slate-500">
        {t('agentDetail.pauseHint')}
      </p>
      <Textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        placeholder={t('agentDetail.pausePlaceholder')}
        className="mt-2"
      />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent text-xs text-slate-500">
          {t('common.cancel')}
        </Button>
        <Button variant="neutral" size="sm"
          onClick={() => onConfirm(reason.trim())}
          disabled={!reason.trim() || pending}>
          {t('agentDetail.confirmPause')}
        </Button>
      </div>
    </Modal>
  );
}

export { duration };
