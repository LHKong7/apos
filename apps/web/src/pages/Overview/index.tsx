import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import type { Contribution } from '@apos/domain';
import { api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import {
  absoluteTime,
  duration,
  eventLabel,
  relativeTime,
  riskLabel,
  sourceIcon,
  sourceLabel,
  tokens,
} from '../../lib/format';
import { CardSkeleton, ErrorState } from '../../components/states';
import { useProjectStream } from '../../lib/sse/useProjectStream';
import { useAuthStore } from '../../stores/auth';
import { DecisionDrawer } from '../../features/decision/DecisionDrawer';
import { BlockedReasons } from '../../features/work-item/BlockedReasons';
import { DiagnosticsBanner } from '../../features/graph/DiagnosticsBanner';
import { WorkItemDrawer } from '../../features/work-item/WorkItemDrawer';
import { useT } from '../../lib/i18n';
import { Button } from '@/components/ui/button';

/** 延期档位 → 词条键 / Delay level → message key */
const DELAY_KEYS = {
  low: 'overview.delay.low',
  medium: 'overview.delay.medium',
  high: 'overview.delay.high',
} as const;

/**
 * 项目总览（页面文档 02）—— 项目负责人的指挥台。
 *
 * ★ 「本页不是数据大屏。每个指标旁都必须有下一步动作，否则不放。」
 *   所以健康度可以展开看扣分明细、延期风险可以展开看七项贡献、
 *   待处理项直接开决策抽屉、阻塞项直接开任务详情。
 *   一个只能看不能点的数字在这一页上没有位置。
 */
export function OverviewPage() {
  const t = useT();
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [expand, setExpand] = useState<'health' | 'delay' | null>(null);
  const [openDecision, setOpenDecision] = useState<string | null>(null);
  const [openCard, setOpenCard] = useState<string | null>(null);

  useProjectStream(projectId);

  /**
   * ★ 等身份定下来再问。
   *   「需要你处理」是按 X-User-Id 算的，启动时 /users 还没回来，
   *   这时候发出去的请求是匿名的 —— 后端会如实答「0 项」，
   *   而这一区恰恰是整页最不能说错的地方。
   */
  const userId = useAuthStore((s) => s.userId);
  const overview = useQuery({
    queryKey: qk.overview(projectId!),
    queryFn: () => api.overview(projectId!),
    enabled: Boolean(projectId) && Boolean(userId),
  });

  if (!projectId) return null;
  if (overview.isPending || !overview.data) {
    return <div className="p-4"><CardSkeleton /></div>;
  }
  if (overview.isError) {
    return (
      <div className="p-4">
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
      </div>
    );
  }

  const d = overview.data!;
  const budgetPct = d.tokens.budget ? Math.round((d.tokens.spent / d.tokens.budget) * 100) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/*
        ★ 这里原本还有一条十二个标签的横排导航（以及角色徽标）。
          它整条搬去了项目侧栏 —— 那十二页里只有这一页看得到导航，
          等于「能去哪」这件事只在总览成立。搬走之后这个头只交代
          「这是哪个项目、目标是什么」。
      */}
      <div className="relative z-10 shrink-0 border-b border-slate-200/80 px-4 py-3 glass">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold tracking-tight text-slate-900">
            {t('overview.title')}
          </h1>
          {d.project.goal && (
            <span className="truncate text-xs text-slate-500">{d.project.goal}</span>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-3">
        <div className="mx-auto max-w-5xl space-y-3">
          {/* ── 五个指标卡 ── */}
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            <MetricCard
              label={t('overview.metric.health')}
              value={String(d.health.score)}
              sub={
                d.health.level === 'good'
                  ? t('overview.health.good')
                  : d.health.level === 'fair'
                    ? t('overview.health.fair')
                    : t('overview.health.poor')
              }
              tone={d.health.level === 'good' ? 'good' : d.health.level === 'fair' ? 'warn' : 'bad'}
              onClick={() => setExpand(expand === 'health' ? null : 'health')}
              hint={t('overview.health.hint')}
            />
            <MetricCard
              label={t('overview.metric.progress')}
              value={`${d.progress.pct}%`}
              sub={`${d.progress.done}/${d.progress.total}`}
              onClick={() => navigate(`/projects/${projectId}/board`)}
            />
            <MetricCard
              label={t('overview.metric.delayRisk')}
              value={t(DELAY_KEYS[d.delay.level])}
              sub={
                d.delay.estimatedSlipDays !== null
                  ? t('overview.delay.withSlip', {
                      pct: Math.round(d.delay.probability * 100),
                      days: d.delay.estimatedSlipDays,
                    })
                  : t('overview.delay.noBaseline', {
                      pct: Math.round(d.delay.probability * 100),
                    })
              }
              tone={d.delay.level === 'high' ? 'bad' : d.delay.level === 'medium' ? 'warn' : 'good'}
              onClick={() => setExpand(expand === 'delay' ? null : 'delay')}
              hint={t('overview.delay.hint')}
            />
            <MetricCard
              label={t('overview.metric.decisions')}
              value={String(d.decisions.pending)}
              sub={
                d.decisions.overdue > 0
                  ? t('overview.decisions.overdue', { count: d.decisions.overdue })
                  : d.decisions.unassigned > 0
                    ? t('overview.decisions.unassigned', { count: d.decisions.unassigned })
                    : t('overview.decisions.none')
              }
              tone={d.decisions.overdue > 0 ? 'bad' : 'normal'}
              onClick={() => navigate(`/projects/${projectId}/decisions`)}
            />
            <MetricCard
              label={t('overview.metric.tokens')}
              value={tokens(d.tokens.spent)}
              sub={
                d.tokens.budget === null
                  ? t('overview.tokens.noBudget')
                  : t('overview.tokens.ofBudget', {
                      budget: tokens(d.tokens.budget),
                      pct: budgetPct ?? 0,
                    })
              }
              tone={budgetPct !== null && budgetPct > 90 ? 'bad' : 'normal'}
              onClick={() => navigate(`/projects/${projectId}/analytics?tab=cost`)}
            />
          </div>

          {/*
            ★ 一个说不清来源的分数会被当成事实引用，也会被当成玄学忽略 ——
              两种下场都不好。所以扣分/加权每一项都摊开。
          */}
          {expand === 'health' && (
            <Breakdown
              title={t('overview.health.breakdownTitle', { score: d.health.score })}
              items={d.health.contributions}
              empty={t('overview.health.empty')}
              sign="minus"
            />
          )}
          {expand === 'delay' && (
            <Breakdown
              title={t('overview.delay.breakdownTitle', {
                pct: Math.round(d.delay.probability * 100),
              })}
              items={d.delay.contributions}
              empty={t('overview.delay.empty')}
              sign="plus"
              note={t('overview.delay.note')}
            />
          )}

          {/*
            ★★ 问题诊断搬到了总览。
              执行图上每条问题都带着「改派 / 催办 / 调整 Policy」这类直达按钮 ——
              而那是全站唯一「报了问题就顺手给解法」的地方。看板与总览上
              看到一条阻塞任务时，用户手上一个动作按钮都没有（问题记录 #40）。
              归因那一行同样搬过来（#38）。
          */}
          <DiagnosticsBanner
            projectId={projectId}
            diagnostics={d.diagnostics}
            delayCause={d.delayCause}
            onOpenCard={setOpenCard}
            onRemind={(nodeId) => setOpenCard(nodeId)}
          />

          {/* ── 需要你处理 ── */}
          <section className="rounded border border-slate-200 bg-white">
            <h2 className="border-b border-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700">
              {t('overview.actionItems', { count: d.actionItems.length })}
            </h2>
            {d.actionItems.length === 0 ? (
              <p className="px-3 py-3 text-center text-xs text-slate-400">
                {t('overview.actionItems.empty')}
              </p>
            ) : (
              <ul>
                {d.actionItems.map((a) => (
                  <li
                    key={`${a.kind}-${a.id}`}
                    className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-xs last:border-0"
                  >
                    {a.overdueMinutes !== null ? (
                      <span className="text-red-700">
                          {t('overview.item.overdue', { time: duration(a.overdueMinutes) })}
                        </span>
                    ) : a.dueInMinutes !== null ? (
                      <span className="text-amber-700">
                          {t('overview.item.dueIn', { time: duration(a.dueInMinutes) })}
                        </span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-slate-800">{a.title}</span>
                    <span className="text-slate-500">{riskLabel(a.riskLevel)}</span>
                    <Button variant="neutral" size="xs"
                      onClick={() =>
                        a.kind === 'plan'
                          ? navigate(`/projects/${projectId}/plans/${a.id}`)
                          : setOpenDecision(a.id)
                      }>
                      {t('overview.item.handle')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="grid gap-3 md:grid-cols-2">
            {/* ── 阻塞与风险 ── */}
            <section className="rounded border border-slate-200 bg-white">
              <h2 className="border-b border-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700">
                {t('overview.blocked', { count: d.blocked.length })}
              </h2>
              {d.blocked.length === 0 ? (
                <p className="px-3 py-3 text-center text-xs text-slate-400">
                  {t('overview.blocked.empty')}
                </p>
              ) : (
                <ul>
                  {d.blocked.map((b) => (
                    <li key={b.id} className="border-b border-slate-100 px-3 py-2 last:border-0">
                      {/*
                        ★★ 标题一行、原因分项、修复入口一行 —— 三层，不是一行。
                          此前六条阻塞原因连同六条建议被压成一个字符串塞进这里，
                          中英标点混着走，真正的下一步动作埋在第三个分号后面
                          （问题记录 #2 / #12 / #25）。
                        ★ 标题仍然可点（开卡片详情），但**修复按钮不在这个可点区里** ——
                          嵌套的可点区域会同时触发两个 handler，用户体感是「点了没反应」
                          （问题记录 #30 的同一类坑）。
                      */}
                      <Button
                        variant="ghost"
                        onClick={() => setOpenCard(b.id)}
                        className="h-auto w-full justify-start p-0 text-left text-xs font-normal whitespace-normal hover:bg-transparent"
                      >
                        <span className="text-red-700" title={t('overview.blockedFor')}>
                          <span aria-hidden>⛔</span>{' '}
                          {b.minutes === null ? '—' : duration(b.minutes)}
                        </span>
                        <span className="ml-2 text-slate-800">{b.title}</span>
                        {b.ownerName && (
                          <span className="ml-2 text-[11px] text-slate-400">
                            {t('overview.item.owner', { name: b.ownerName })}
                          </span>
                        )}
                      </Button>
                      <BlockedReasons
                        projectId={projectId}
                        detail={b.detail}
                        fallback={b.reason}
                        className="mt-1 pl-1"
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* ── Agent 团队 ── */}
            <section className="rounded border border-slate-200 bg-white">
              <h2 className="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700">
                {t('overview.agents', { count: d.agents.length })}
                <Link
                  to={`/projects/${projectId}/agents`}
                  className="ml-auto text-[11px] font-normal text-slate-500 underline"
                >
                  {t('overview.agents.all')}
                </Link>
              </h2>
              {d.agents.length === 0 ? (
                <p className="px-3 py-3 text-center text-xs text-slate-400">
                  {t('overview.agents.empty')}
                </p>
              ) : (
                <ul>
                  {d.agents.map((a) => (
                    <li key={a.id} className="border-b border-slate-100 px-3 py-1.5 last:border-0">
                      <Link
                        to={`/projects/${projectId}/agents/${a.id}`}
                        className="block text-xs hover:opacity-80"
                      >
                        <span className="text-slate-800">🤖 {a.name}</span>
                        <span
                          className={clsx(
                            'ml-2 text-[11px]',
                            a.status === 'running'
                              ? 'text-green-700'
                              : a.status === 'paused'
                                ? 'text-amber-700'
                                : 'text-slate-400',
                          )}
                        >
                          ●{' '}
                          {a.status === 'running'
                            ? t('overview.agent.running')
                            : a.status === 'paused'
                              ? t('overview.agent.paused')
                              : t('overview.agent.idle')}
                        </span>
                        {a.currentTask && (
                          <span className="mt-0.5 block truncate text-[11px] text-slate-500">
                            {a.currentTask}
                          </span>
                        )}
                        <span className="text-[11px] text-slate-400">
                          {t('overview.agent.runs', { count: a.runs })}
                          {a.successRate !== null && t('overview.agentSuccess', { percent: Math.round(a.successRate * 100) })}
                          {' · '}
                          {tokens(a.tokens)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {/* ── 人类成员 ── */}
          <section className="rounded border border-slate-200 bg-white px-3 py-2">
            <h2 className="text-xs font-medium text-slate-700">{t('overview.humanMembers', { count: d.members.length })}</h2>
            <ul className="mt-1 space-y-0.5">
              {d.members.map((m) => (
                <li key={m.id} className="text-xs text-slate-700">
                  👤 {m.name}
                  <span className="ml-2 text-slate-500">{m.role}</span>
                  <span className="ml-2 text-slate-500">
                    {t('overview.decisionCount', { count: m.pendingDecisions })}
                    {m.overdueDecisions > 0 && (
                      <span className="ml-1 text-red-700">{t('overview.overdueDecisions', { count: m.overdueDecisions })}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {/*
              ★ 无主的决策要单独说。摊进成员列表里每人都是 0，
                看起来像「没人有待办」，而真相是「有几件事没人认领」。
            */}
            {d.decisions.unassigned > 0 && (
              <p className="mt-1.5 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
                {t('overview.unassignedDecisions', { count: d.decisions.unassigned })}
              </p>
            )}
          </section>

          {/* ── 最近活动 ── */}
          <section className="rounded border border-slate-200 bg-white px-3 py-2">
            <h2 className="text-xs font-medium text-slate-700">{t('overview.recentActivity')}</h2>
            <ul className="mt-1 space-y-0.5">
              {d.recentActivity.map((e) => (
                <li key={e.id} className="flex items-baseline gap-2 text-[11px]">
                  {/* ★ hover 给绝对时间：相对时间答「多久以前」，绝对时间答「几点」（#1） */}
                  <span className="shrink-0 text-slate-400" title={absoluteTime(e.occurredAt)}>
                    {relativeTime(e.occurredAt)}
                  </span>
                  <span aria-hidden>{sourceIcon(e.actorType)}</span>
                  <span className="sr-only">{sourceLabel(e.actorType)}</span>
                  <span className="min-w-0 flex-1 truncate text-slate-600">
                    {eventLabel(e.type)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>

      {openDecision && (
        <DecisionDrawer
          decisionId={openDecision}
          onClose={() => {
            setOpenDecision(null);
            void overview.refetch();
          }}
        />
      )}
      {openCard && (
        <WorkItemDrawer
          workItemId={openCard}
          onClose={() => setOpenCard(null)}
          onOpenDecision={(id) => {
            setOpenCard(null);
            setOpenDecision(id);
          }}
        />
      )}
    </div>
  );
}

function MetricCard({
  label,
  value,
  sub,
  tone = 'normal',
  onClick,
  hint,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'normal' | 'good' | 'warn' | 'bad';
  onClick?: () => void;
  hint?: string;
}) {
  return (
    <Button variant="ghost"
      onClick={onClick}
      /*
        ★ 帮助文案挂在 title 上，不进按钮正文（问题记录 #4）。
          「点开看看是哪些项扣了分」和「55 / 一般」挤在同一个按钮里时，
          扫五张卡的人先读到的是那句解释，而这一排卡的用途是**比较数字**。
          按钮本体只留标签、数值、一行状态；解释交给 hover 与展开区。
      */
      title={hint}
      aria-label={hint ? `${label} ${value}${sub ? ` ${sub}` : ''} — ${hint}` : undefined}
      className={clsx('h-auto p-0 font-normal whitespace-normal hover:bg-transparent justify-start', 
        'lift relative overflow-hidden rounded-xl border bg-white px-3 py-2.5 text-left shadow-sm hover:shadow-md',
        // 指标卡的色调只体现在**顶边那道线**上，不给整块上色 ——
        // 五张卡并排时，五块彩色底会让人先看到颜色，再去找数字
        tone === 'bad'
          ? 'border-red-200 hover:border-red-300'
          : tone === 'warn'
            ? 'border-amber-200 hover:border-amber-300'
            : 'border-slate-200 hover:border-slate-300',
      )}
    >
      {tone !== 'normal' && (
        <span
          aria-hidden
          className={clsx(
            'absolute inset-x-0 top-0 h-px',
            tone === 'bad' ? 'bg-overdue' : tone === 'warn' ? 'bg-gate' : 'bg-emerald-500',
          )}
        />
      )}
      <p className="text-[11px] text-slate-500">{label}</p>
      <p
        className={clsx(
          'mt-0.5 text-xl font-semibold tabular-nums tracking-tight',
          tone === 'bad'
            ? 'text-red-700'
            : tone === 'warn'
              ? 'text-amber-700'
              : tone === 'good'
                ? 'text-green-700'
                : 'text-slate-900',
        )}
      >
        {value}
      </p>
      {sub && <p className="truncate text-[11px] text-slate-400">{sub}</p>}
      {/*
        ★ 有帮助文案的卡片给一个「可展开」的暗示，而不是把那句话印出来。
          没有任何暗示的话，可点这件事只能靠碰运气发现。
      */}
      {hint && (
        <p aria-hidden className="text-[11px] text-slate-300">
          ⌄
        </p>
      )}
    </Button>
  );
}

function Breakdown({
  title,
  items,
  empty,
  sign,
  note,
}: {
  title: string;
  items: Contribution[];
  empty: string;
  sign: 'plus' | 'minus';
  note?: string;
}) {
  return (
    <section className="rounded border border-slate-200 bg-white px-3 py-2">
      <h3 className="text-xs font-medium text-slate-700">{title}</h3>
      {items.length === 0 ? (
        <p className="mt-1 text-xs text-slate-400">{empty}</p>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {items.map((c) => (
            <li key={c.key} className="flex items-baseline gap-2 text-xs">
              <span
                className={clsx(
                  'w-10 shrink-0 text-right tabular-nums font-medium',
                  sign === 'minus' ? 'text-red-700' : 'text-amber-700',
                )}
              >
                {sign === 'plus' ? '+' : ''}
                {c.delta}
                {sign === 'plus' ? '%' : ''}
              </span>
              <span className="w-20 shrink-0 text-slate-700">{c.label}</span>
              <span className="min-w-0 flex-1 text-slate-500">{c.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {note && <p className="mt-1.5 text-[11px] text-slate-400">{note}</p>}
    </section>
  );
}
