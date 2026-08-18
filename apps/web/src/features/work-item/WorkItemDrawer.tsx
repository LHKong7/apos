import { useT } from '../../lib/i18n';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { ApiError, api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import {
  absoluteTime,
  eventLabel,
  relativeTime,
  riskLabel,
  sourceIcon,
  sourceLabel,
  statusLabel,
  tokens,
  typeIcon,
  typeLabel,
} from '../../lib/format';
import { QueryBoundary } from '../../components/states';
import { GatedButton } from '../../components/Gated';
import { Drawer } from '../../components/Drawer';
import { ExecutorPicker } from './ExecutorPicker';
import { BlockedReasons } from './BlockedReasons';
import { useBoardStore } from '../../stores/board';
import { useEditingStore } from '../../stores/editing';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { TimelineEvent } from '../../lib/api/types';

interface Props {
  workItemId: string;
  onClose: () => void;
  onOpenDecision: (decisionId: string) => void;
}

export function WorkItemDrawer({ workItemId, onClose, onOpenDecision }: Props) {
  const t = useT();
  const qc = useQueryClient();
  const setOpenedCard = useBoardStore((s) => s.setOpenedCard);

  // 打开详情期间，这张卡的自动移动动画延后（页面文档 05 §5.5）
  useEffect(() => {
    setOpenedCard(workItemId);
    return () => setOpenedCard(null);
  }, [workItemId, setOpenedCard]);

  const query = useQuery({
    queryKey: qk.workItem(workItemId),
    queryFn: () => api.workItem(workItemId),
  });

  const [tab, setTab] = useState<'overview' | 'runs' | 'timeline'>('overview');

  const retry = useMutation({
    mutationFn: (context: string) =>
      api.retry(workItemId, {
        additionalContext: context.trim()
          ? [{ title: t('itemDrawer.addedContext'), content: context.trim() }]
          : undefined,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.workItem(workItemId) });
      void qc.invalidateQueries({ queryKey: ['board'] });
    },
  });

  return (
    <Drawer title={t('itemDrawer.title')} onClose={onClose} width="w-[min(34rem,100vw)]">
      <QueryBoundary query={query}>
        {({ item, runs, artifacts, timeline }) => (
          <div className="space-y-3 text-sm">
            <header>
              <div className="flex items-start gap-2">
                <span aria-hidden title={typeLabel(item.type)}>{typeIcon(item.type)}</span>
                <span className="sr-only">{typeLabel(item.type)}</span>
                <h3 className="flex-1 font-semibold text-slate-900">{item.title}</h3>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                <span className="rounded bg-slate-100 px-1.5 py-0.5">
                  {statusLabel(item.status)}
                </span>
                <span>{riskLabel(item.riskLevel)}</span>
                <span>{t('itemDrawer.tokens', { amount: tokens(item.actualTokens) })}</span>
                {item.estimatedTokens !== null && (
                  <span>{t('itemDrawer.estimated', { amount: tokens(item.estimatedTokens) })}</span>
                )}
                <span>{t('itemDrawer.updatedAt', { time: relativeTime(item.updatedAt) })}</span>
              </div>
              {item.humanGate && (
                <Button variant="gate" size="sm"
                  onClick={() => {
                    // Human Gate 徽标是决策的入口（页面文档 05 §3）
                    const pending = timeline.find((e) => e.type === 'decision.created');
                    if (pending) onOpenDecision(String(pending.payload['decisionId'] ?? pending.id));
                  }}
                  className="mt-2 w-full">
                  {t('itemDrawer.awaitingDecision')}
                </Button>
              )}
            </header>

            <nav className="flex gap-1 border-b border-slate-200">
              {/* ★ 参数不叫 t —— 会遮住 i18n 的 t */}
              {(['overview', 'runs', 'timeline'] as const).map((key) => (
                <Button variant="ghost"
                  key={key}
                  onClick={() => setTab(key)}
                  className={clsx('h-auto p-0 font-normal whitespace-normal hover:bg-transparent', 
                    'px-2 py-1 text-xs',
                    tab === key
                      ? 'border-b-2 border-brand font-medium text-slate-900'
                      : 'text-slate-500',
                  )}
                >
                  {key === 'overview'
                    ? t('itemDrawer.tab.overview')
                    : key === 'runs'
                      ? t('itemDrawer.tab.runs', { count: runs.length })
                      : t('itemDrawer.tab.timeline')}
                </Button>
              ))}
            </nav>

            {tab === 'overview' && (
              <div className="space-y-3">
                {/*
                  ★ 执行者选择放在概览最上面：这是打开一张卡最常做的动作，
                    而在它出现之前看板上根本没有这个入口 —— 唯一的指派路径
                    是「派发」按钮，而那个按钮会立刻开始执行。
                */}
                <ExecutorPicker
                  workItemId={workItemId}
                  projectId={item.projectId}
                  status={item.status}
                />

                {item.description && (
                  <p className="whitespace-pre-wrap text-xs text-slate-600">{item.description}</p>
                )}

                {/*
                  ★ 阻塞原因摊开成分项，每条标出它配在哪一层，并给出直达修复入口。
                    此前这里是一整块橙底文字，把六条原因和六条建议压成一段
                    （问题记录 #2 / #6 / #12）。
                */}
                {(item.blockedDetail || item.blockedReason) && (
                  <div className="rounded border border-orange-200 bg-orange-50 px-2 py-1.5">
                    <BlockedReasons
                      projectId={item.projectId}
                      detail={item.blockedDetail}
                      fallback={item.blockedReason}
                    />
                  </div>
                )}

                {item.acceptanceCriteria.length > 0 && (
                  <section>
                    <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
                      {t('itemDrawer.acceptanceCriteria')}
                    </h4>
                    <ul className="space-y-1">
                      {item.acceptanceCriteria.map((c) => (
                        <li key={c.id} className="flex items-start gap-1.5 text-xs">
                          {/*
                            ★★ 从 ✅ / ❌ / ⬜ 换成同一套描边记号。
                              那三个 emoji 是三种不同来源的字符 —— 彩色方块、
                              彩色叉、空心方框，粗细和基线各不一样，摆在一起
                              不像一套设计语言（问题记录 #29）。
                              现在是同粗细的 ✓ / ✕ / ○，颜色承担状态，
                              形状承担色觉障碍下的可读性。
                            ★ 语义由紧随其后的 sr-only 文字承担，读屏用户听到的是
                              「已通过」，而不是「白色中等方块」（问题记录 #19）。
                          */}
                          <span
                            aria-hidden
                            className={clsx(
                              'w-3 shrink-0 text-center font-medium',
                              c.status === 'passed'
                                ? 'text-emerald-600'
                                : c.status === 'failed'
                                  ? 'text-rose-600'
                                  : 'text-slate-300',
                            )}
                          >
                            {c.status === 'passed' ? '✓' : c.status === 'failed' ? '✕' : '○'}
                          </span>
                          <span className="sr-only">
                            {c.status === 'passed'
                              ? t('itemDrawer.criterion.passed')
                              : c.status === 'failed'
                                ? t('itemDrawer.criterion.failed')
                                : t('itemDrawer.criterion.pending')}
                          </span>
                          <span className="flex-1 text-slate-700">{c.text}</span>
                          <span className="text-[10px] text-slate-400">{c.verification}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {item.constraints.length > 0 && (
                  <section>
                    <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
                      {t('itemDrawer.constraints')}
                    </h4>
                    <ul className="space-y-1 text-xs text-slate-700">
                      {item.constraints.map((c, i) => (
                        <li key={i}>
                          · {c.description}
                          <span className="ml-1 text-[10px] text-slate-400">
                            {t('itemDrawer.enforcement', {
                              how:
                                c.enforcement === 'system'
                                  ? t('itemDrawer.verifyAuto')
                                  : c.enforcement === 'agent'
                                    ? t('itemDrawer.verifyAgent')
                                    : t('itemDrawer.verifyHuman'),
                            })}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {artifacts.length > 0 && (
                  <section>
                    <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
                      {t('itemDrawer.artifacts')}
                    </h4>
                    <ul className="space-y-1 text-xs">
                      {artifacts.map((a) => (
                        <li key={a.id}>
                          {a.externalUrl ? (
                            <a
                              href={a.externalUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-sky-700 underline"
                            >
                              📎 {a.title}
                            </a>
                          ) : (
                            <details>
                              <summary className="cursor-pointer text-slate-700">
                                📄 {a.title}
                              </summary>
                              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-[11px]">
                                {a.content}
                              </pre>
                            </details>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            )}

            {tab === 'runs' && (
              <RunsTab
                workItemId={workItemId}
                runs={runs}
                failed={item.status === 'failed'}
                onRetry={(ctx) => retry.mutate(ctx)}
                pending={retry.isPending}
                error={retry.error}
              />
            )}

            {tab === 'timeline' && <TimelineTab events={timeline} />}
          </div>
        )}
      </QueryBoundary>
    </Drawer>
  );
}

/**
 * 事件流。
 *
 * ★★ 这一栏此前直接印 `e.type`（`work_item.blocked`）加一个 emoji，
 *   看不到是谁做的、对什么做的、为什么（问题记录 #44）。事件类型是给系统看的，
 *   时间线是给人看的 —— 印键名等于把「发生了什么」退化成一段日志。
 *
 * ★★ 还有一个筛选。调度器曾经每轮都写一条 blocked，几十条一模一样的事件
 *   把真正的状态变更淹掉（#43）。根因已经在 scheduler.ts 修掉了，
 *   但**存量数据里那几十条还在**，而且以后仍会有噪声型事件 ——
 *   所以「只看状态变更」这一档要一直留着。
 *
 * Event types are for the system; a timeline is for a person. The filter stays
 * even though the duplicate-blocked flood is fixed at the source, because the
 * rows already written are still in the database.
 */
const TIMELINE_FILTERS = [
  { key: 'all', labelKey: 'itemDrawer.timeline.all' },
  { key: 'status', labelKey: 'itemDrawer.timeline.status' },
  { key: 'agent', labelKey: 'itemDrawer.timeline.agent' },
  { key: 'human', labelKey: 'itemDrawer.timeline.human' },
] as const;

type TimelineFilter = (typeof TIMELINE_FILTERS)[number]['key'];

/** 「状态变更」这一档收哪些事件 —— 决策与流转，不含执行细节 */
const STATUS_EVENT_PREFIXES = ['work_item.', 'decision.', 'plan.', 'requirement.'];

function matchesFilter(e: TimelineEvent, filter: TimelineFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'status':
      return STATUS_EVENT_PREFIXES.some((p) => e.type.startsWith(p));
    case 'agent':
      return e.actorType === 'agent' || e.type.startsWith('agent_run.');
    case 'human':
      return e.actorType === 'human';
  }
}

function TimelineTab({ events }: { events: TimelineEvent[] }) {
  const t = useT();
  const [filter, setFilter] = useState<TimelineFilter>('all');
  const shown = events.filter((e) => matchesFilter(e, filter));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {TIMELINE_FILTERS.map((f) => (
          <Button
            key={f.key}
            variant={filter === f.key ? 'neutral' : 'ghost'}
            size="xs"
            onClick={() => setFilter(f.key)}
            className={clsx(filter !== f.key && 'text-slate-600 hover:bg-slate-100')}
          >
            {t(f.labelKey)}
          </Button>
        ))}
      </div>

      <ul className="space-y-1.5">
        {shown.map((e) => (
          <li key={e.id} className="flex gap-2 text-xs">
            {/*
              ★ 相对时间带绝对时间的 title —— 一列「刚刚」看不出事件顺序，
                而排查问题时要的恰恰是「这两条差了几秒」（问题记录 #1）。
            */}
            <span
              className="w-16 shrink-0 text-right text-[10px] text-slate-400"
              title={absoluteTime(e.occurredAt)}
            >
              {relativeTime(e.occurredAt)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-slate-700">{eventLabel(e.type)}</span>
              <span className="ml-1 text-[10px] text-slate-500">
                {/* emoji 只是装饰，语义在紧随其后的来源文字上（#19） */}
                <span aria-hidden>{sourceIcon(e.actorType)}</span> {sourceLabel(e.actorType)}
              </span>
              {eventDetail(e) && (
                <span className="mt-0.5 block text-[10px] text-slate-500">{eventDetail(e)}</span>
              )}
            </span>
          </li>
        ))}
        {shown.length === 0 && (
          <p className="text-xs text-slate-400">
            {events.length === 0 ? t('itemDrawer.noEvents') : t('itemDrawer.timeline.noMatch')}
          </p>
        )}
      </ul>
    </div>
  );
}

/**
 * 从 payload 里挖出那一行「为什么」。
 *
 * ★ 只认几个已知字段，认不出来就不显示 —— 把整个 payload 印出来
 *   等于换一种方式重现「一行日志」，而那正是这次要改掉的东西。
 */
function eventDetail(e: TimelineEvent): string | null {
  for (const key of ['reason', 'note', 'message', 'errorMessage']) {
    const v = e.payload[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function RunsTab({
  workItemId,
  runs,
  failed,
  onRetry,
  pending,
  error,
}: {
  workItemId: string;
  runs: {
    id: string;
    attempt: number;
    status: string;
    tokens: number;
    stepCurrent: number | null;
    stepTotal: number | null;
    progressNote: string | null;
    errorClass: string | null;
    errorMessage: string | null;
    agentSelfReport: string | null;
  }[];
  failed: boolean;
  onRetry: (context: string) => void;
  pending: boolean;
  error: unknown;
}) {
  const t = useT();
  const [context, setContext] = useState('');
  const { startEdit, endEdit, conflictOf } = useEditingStore();
  const conflict = conflictOf(workItemId, 'retryContext');

  return (
    <div className="space-y-3">
      {runs.map((run) => (
        <article key={run.id} className="rounded border border-slate-200 p-2 text-xs">
          <div className="flex items-center gap-2">
            <Link to={`/runs/${run.id}`} className="font-medium hover:underline">
              {t('runSum.attemptNo', { n: run.attempt })}
            </Link>
            <span
              className={clsx(
                'rounded px-1.5 text-[10px]',
                run.status === 'completed'
                  ? 'bg-emerald-100 text-emerald-700'
                  : run.status === 'failed'
                    ? 'bg-red-100 text-red-700'
                    : 'bg-slate-100 text-slate-600',
              )}
            >
              {run.status}
            </span>
            <span className="ml-auto tabular-nums text-slate-500">{tokens(run.tokens)}</span>
          </div>
          {run.progressNote && <p className="mt-1 text-slate-600">{run.progressNote}</p>}
          {run.errorMessage && (
            <p className="mt-1 text-red-700">
              [{run.errorClass}] {run.errorMessage}
            </p>
          )}
          {run.agentSelfReport && (
            <p className="mt-1 rounded bg-amber-50 p-1.5 text-amber-800">
              {t('itemDrawer.agentSelfReport', { report: run.agentSelfReport })}
            </p>
          )}
        </article>
      ))}

      {runs.length === 0 && <p className="text-xs text-slate-400">{t('itemDrawer.noRuns')}</p>}

      <section className="border-t border-slate-200 pt-3">
        <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
          {failed ? t('itemDrawer.retryWithContext') : t('itemDrawer.redispatch')}
        </h4>
        {conflict && (
          <p className="mb-1 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
            {t('itemDrawer.updatedConflict')}
          </p>
        )}
        <Textarea
          value={context}
          onChange={(e) => setContext(e.target.value)}
          onFocus={() => startEdit(workItemId, 'retryContext')}
          onBlur={() => endEdit(workItemId, 'retryContext')}
          rows={3}
          placeholder={t('itemDrawer.contextPlaceholder')}
        />
        {/* 重新派发要花钱、会改代码 —— 只读角色不该点得动（§2.3 执行任务） */}
        <GatedButton
          permission="work_item.execute"
          disabled={pending}
          disabledReason={t('itemDrawer.dispatching')}
          onClick={() => onRetry(context)}
          className="mt-1.5 w-full rounded bg-slate-900 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-40"
        >
          {pending ? t('itemDrawer.dispatchingShort') : t('itemDrawer.retry')}
        </GatedButton>
        {error !== null && error !== undefined && (
          <p className="mt-1.5 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
            {error instanceof ApiError ? error.message : t('itemDrawer.dispatchFailed')}
          </p>
        )}
      </section>
    </div>
  );
}
