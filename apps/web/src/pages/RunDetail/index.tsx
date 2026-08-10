import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { duration, money, statusLabel } from '../../lib/format';
import { AssigneeChip, actorStateFrom } from '../../components/AssigneeChip';
import { QueryBoundary } from '../../components/states';
import { EventTimeline } from '../../features/run/EventTimeline';
import { RunControlDialog } from '../../features/run/RunControlDialog';
import { RunSummary } from '../../features/run/RunSummary';
import { useRunEvents } from '../../features/run/useRunEvents';
import { ArtifactsTab, CostTab, ErrorTab, InputTab } from '../../features/run/tabs';
import type { RunDetail } from '../../lib/api/types';

const ACTIVE = ['queued', 'dispatching', 'running', 'paused'];

type Tab = 'timeline' | 'input' | 'artifacts' | 'cost' | 'error';

export function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const query = useQuery({
    queryKey: qk.run(runId!),
    queryFn: () => api.run(runId!),
    enabled: Boolean(runId),
    // 执行中的 Run，头部的成本与进度也要跟着动
    refetchInterval: (q) => (isLive(q.state.data) ? 3000 : false),
  });

  if (!runId) return null;

  return (
    <QueryBoundary query={query}>
      {(detail) => <RunDetailView detail={detail} />}
    </QueryBoundary>
  );
}

function isLive(detail: RunDetail | undefined): boolean {
  return detail ? ACTIVE.includes(detail.run.status) : false;
}

function RunDetailView({ detail }: { detail: RunDetail }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const live = isLive(detail);

  const [detailed, setDetailed] = useState(false);
  const [tab, setTab] = useState<Tab>('timeline');
  const [dialog, setDialog] = useState<'terminate' | 'add_constraint' | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // ★ 失败的 Run 默认打开错误 Tab —— 不让用户自己去找（页面文档 09 §7）
  useEffect(() => {
    if (detail.error && detail.run.status !== 'completed') setTab('error');
  }, [detail.error, detail.run.status]);

  const { events, loading } = useRunEvents(detail.run.id, detailed ? 'detailed' : 'brief', live);

  const control = useMutation({
    mutationFn: (input: { action: 'terminate' | 'add_constraint'; reason?: string; constraint?: string }) =>
      api.controlRun(detail.run.id, {
        action: input.action,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.constraint ? { constraint: { description: input.constraint } } : {}),
      }),
    onSuccess: (_r, input) => {
      setDialog(null);
      setToast(input.action === 'terminate' ? '已终止' : '约束已下发，Agent 会在当前步骤后应用');
      void qc.invalidateQueries({ queryKey: qk.run(detail.run.id) });
    },
  });

  const retry = useMutation({
    mutationFn: () => api.retry(detail.workItem!.id),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.run(detail.run.id) });
      navigate(`/runs/${r.runId}`);
    },
    onError: (e) => setToast(e instanceof ApiError ? e.message : '重试失败'),
  });

  const takeover = useMutation({
    mutationFn: () => api.takeover(detail.workItem!.id, '从 Run 详情接管'),
    onSuccess: () => setToast('已接管，执行主体切换为你'),
    onError: (e) => setToast(e instanceof ApiError ? e.message : '接管失败'),
  });

  const controlError = control.error instanceof ApiError ? control.error : null;
  const progressPct = useMemo(() => {
    const { stepCurrent, stepTotal } = detail.run;
    if (!stepCurrent || !stepTotal) return null;
    return Math.min(Math.round((stepCurrent / stepTotal) * 100), 100);
  }, [detail.run]);

  const TABS: { key: Tab; label: string; hidden?: boolean }[] = [
    { key: 'timeline', label: `执行流${events.length ? ` (${events.length})` : ''}` },
    { key: 'input', label: '输入' },
    { key: 'artifacts', label: `产物 (${detail.artifacts.length})` },
    { key: 'cost', label: '成本' },
    // 错误 Tab 只在真的失败时出现，不给一个永远空着的入口
    { key: 'error', label: '错误', hidden: !detail.error },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ── 头部 ── */}
      <header className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          {detail.workItem && (
            <Link
              to={`/projects/${detail.project?.id}/board`}
              className="text-xs text-slate-500 hover:text-slate-700"
            >
              ← {detail.workItem.title}
            </Link>
          )}
          <h1 className="text-sm font-semibold text-slate-900">
            Run · 第 {detail.run.attempt} 次
          </h1>
          <StatusPill status={detail.run.status} />

          <div className="ml-auto flex items-center gap-2">
            {/* ★ 本页最重要的开关：两类用户，两种深度（页面文档 09 §2） */}
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={detailed}
                onChange={(e) => setDetailed(e.target.checked)}
                className="h-3.5 w-3.5 accent-slate-900"
              />
              详细模式
            </label>
          </div>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-600">
          {detail.agent && (
            <AssigneeChip
              actor={{ type: 'agent', id: detail.agent.id, name: detail.agent.name }}
              state={actorStateFrom(detail.run.status, detail.run.status)}
              size="sm"
            />
          )}
          <span className="font-mono text-[11px]">{detail.agent?.model ?? '—'}</span>
          <span className="tabular-nums">{duration(detail.metrics.durationMs / 60_000)}</span>
          <span className="tabular-nums">{money(detail.metrics.cost)}</span>
          <span className="tabular-nums text-slate-500">
            {(detail.metrics.tokens.total / 1000).toFixed(1)}k tok
            {detail.metrics.tokens.cacheHitRate > 0 && (
              <> · 缓存命中 {(detail.metrics.tokens.cacheHitRate * 100).toFixed(0)}%</>
            )}
          </span>

          <div className="ml-auto flex gap-1">
            {live && (
              <>
                <HeaderButton onClick={() => setDialog('add_constraint')}>增加约束</HeaderButton>
                <HeaderButton onClick={() => setDialog('terminate')} tone="danger">
                  终止
                </HeaderButton>
              </>
            )}
            {detail.workItem && (
              <>
                <HeaderButton onClick={() => takeover.mutate()}>接管</HeaderButton>
                <HeaderButton onClick={() => retry.mutate()}>重试</HeaderButton>
              </>
            )}
          </div>
        </div>

        {progressPct !== null && (
          <div className="mt-2 flex items-center gap-2">
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
              <span
                className="block h-full bg-agent transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-slate-500">
              步骤 {detail.run.stepCurrent}/{detail.run.stepTotal}
              {detail.run.stepDescription && ` · ${detail.run.stepDescription}`}
            </span>
          </div>
        )}

        {/* 事件流中断的提示（页面文档 09 §11） */}
        {live && isStale(detail) && (
          <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
            事件流已 {duration(staleMinutes(detail))} 没有更新，运行时可能已经断开
          </p>
        )}
      </header>

      {/* ── 主体 ── */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col px-4 py-2">
          <nav className="flex shrink-0 gap-1 border-b border-slate-200">
            {TABS.filter((t) => !t.hidden).map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={clsx(
                  'px-2 py-1 text-xs',
                  tab === t.key
                    ? 'border-b-2 border-brand font-medium text-slate-900'
                    : 'text-slate-500 hover:text-slate-700',
                  t.key === 'error' && tab !== 'error' && 'text-red-600',
                )}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto pt-2">
            {tab === 'timeline' &&
              (loading ? (
                <p className="py-6 text-center text-xs text-slate-400">加载事件…</p>
              ) : (
                <EventTimeline
                  events={events}
                  detailed={detailed}
                  live={live}
                  onJumpToFailure={() =>
                    document
                      .getElementById('run-failure-point')
                      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                  }
                />
              ))}
            {tab === 'input' && <InputTab detail={detail} />}
            {tab === 'artifacts' && <ArtifactsTab detail={detail} />}
            {tab === 'cost' && <CostTab detail={detail} />}
            {tab === 'error' && (
              <ErrorTab
                detail={detail}
                onRetry={() => retry.mutate()}
                onTakeover={() => takeover.mutate()}
              />
            )}
          </div>
        </div>

        <RunSummary detail={detail} />
      </div>

      {dialog && (
        <RunControlDialog
          action={dialog}
          runtimeName={detail.agent?.name ?? 'Agent'}
          pending={control.isPending}
          error={controlError?.message ?? null}
          fallback={
            controlError?.code === 'UNSUPPORTED_FEATURE'
              ? ((controlError.details as { fallback?: string } | null)?.fallback ?? null)
              : null
          }
          onCancel={() => {
            control.reset();
            setDialog(null);
          }}
          onConfirm={({ reason, constraint }) =>
            control.mutate({ action: dialog, ...(reason ? { reason } : {}), ...(constraint ? { constraint } : {}) })
          }
        />
      )}

      {toast && (
        <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2 animate-fade-in-up rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-800 shadow-lg glass-strong">
          {toast}
          <button
            type="button"
            className="pointer-events-auto ml-2 underline"
            onClick={() => setToast(null)}
          >
            知道了
          </button>
        </div>
      )}
    </div>
  );
}

const STATUS_TONES: Record<string, string> = {
  running: 'bg-emerald-100 text-emerald-700',
  queued: 'bg-slate-100 text-slate-600',
  dispatching: 'bg-slate-100 text-slate-600',
  paused: 'bg-amber-100 text-amber-700',
  completed: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-700',
  timeout: 'bg-red-100 text-red-700',
  terminated: 'bg-slate-200 text-slate-600',
};

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={clsx(
        'rounded px-1.5 py-0.5 text-[11px] font-medium',
        STATUS_TONES[status] ?? 'bg-slate-100 text-slate-600',
      )}
    >
      {statusLabel(status)}
    </span>
  );
}

function HeaderButton({
  children,
  onClick,
  tone,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'rounded border px-2 py-0.5 text-[11px]',
        tone === 'danger'
          ? 'border-red-300 text-red-700 hover:bg-red-50'
          : 'border-slate-300 text-slate-600 hover:bg-slate-50',
      )}
    >
      {children}
    </button>
  );
}

/** 心跳停了多久算「可能断了」 */
const STALE_MINUTES = 3;

function staleMinutes(detail: RunDetail): number {
  const last = detail.run.lastHeartbeatAt ?? detail.run.startedAt;
  return (Date.now() - new Date(last).getTime()) / 60_000;
}

function isStale(detail: RunDetail): boolean {
  return staleMinutes(detail) > STALE_MINUTES;
}
