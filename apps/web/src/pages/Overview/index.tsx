import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import type { Contribution } from '@apos/domain';
import { api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { duration, eventLabel, money, relativeTime, riskLabel } from '../../lib/format';
import { CardSkeleton, ErrorState } from '../../components/states';
import { useProjectStream } from '../../lib/sse/useProjectStream';
import { useAuthStore } from '../../stores/auth';
import { DecisionDrawer } from '../../features/decision/DecisionDrawer';
import { WorkItemDrawer } from '../../features/work-item/WorkItemDrawer';

const DELAY_LABELS = { low: '低', medium: '中', high: '高' } as const;

/**
 * 项目总览（页面文档 02）—— 项目负责人的指挥台。
 *
 * ★ 「本页不是数据大屏。每个指标旁都必须有下一步动作，否则不放。」
 *   所以健康度可以展开看扣分明细、延期风险可以展开看七项贡献、
 *   待处理项直接开决策抽屉、阻塞项直接开任务详情。
 *   一个只能看不能点的数字在这一页上没有位置。
 */
export function OverviewPage() {
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
  const budgetPct = d.cost.budget ? Math.round((d.cost.spent / d.cost.budget) * 100) : null;

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
          <h1 className="text-sm font-semibold tracking-tight text-slate-900">总览</h1>
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
              label="健康度"
              value={String(d.health.score)}
              sub={d.health.level === 'good' ? '良好' : d.health.level === 'fair' ? '一般' : '较差'}
              tone={d.health.level === 'good' ? 'good' : d.health.level === 'fair' ? 'warn' : 'bad'}
              onClick={() => setExpand(expand === 'health' ? null : 'health')}
              hint="点开看扣分明细"
            />
            <MetricCard
              label="进度"
              value={`${d.progress.pct}%`}
              sub={`${d.progress.done}/${d.progress.total}`}
              onClick={() => navigate(`/projects/${projectId}/board`)}
            />
            <MetricCard
              label="延期风险"
              value={DELAY_LABELS[d.delay.level]}
              sub={
                d.delay.estimatedSlipDays !== null
                  ? `${Math.round(d.delay.probability * 100)}% · 预计 +${d.delay.estimatedSlipDays} 天`
                  : `${Math.round(d.delay.probability * 100)}% · 无排期基准`
              }
              tone={d.delay.level === 'high' ? 'bad' : d.delay.level === 'medium' ? 'warn' : 'good'}
              onClick={() => setExpand(expand === 'delay' ? null : 'delay')}
              hint="点开看预测怎么来的"
            />
            <MetricCard
              label="待决策"
              value={String(d.decisions.pending)}
              sub={
                d.decisions.overdue > 0
                  ? `${d.decisions.overdue} 项已超时`
                  : d.decisions.unassigned > 0
                    ? `${d.decisions.unassigned} 项无人认领`
                    : '无超时'
              }
              tone={d.decisions.overdue > 0 ? 'bad' : 'normal'}
              onClick={() => navigate(`/projects/${projectId}/decisions`)}
            />
            <MetricCard
              label="成本"
              value={money(String(d.cost.spent))}
              sub={d.cost.budget === null ? '未设预算' : `预算 ${money(String(d.cost.budget))} · ${budgetPct}%`}
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
              title={`健康度 ${d.health.score} 分是这么来的（100 分起扣）`}
              items={d.health.contributions}
              empty="没有扣分项 —— 各项指标都在正常范围"
              sign="minus"
            />
          )}
          {expand === 'delay' && (
            <Breakdown
              title={`延期概率 ${Math.round(d.delay.probability * 100)}% 是这么来的（基础风险 10% 起）`}
              items={d.delay.contributions}
              empty="没有识别到明显的延期风险来源"
              sign="plus"
              note="这不是统计模型，是一组显式的经验规则。知道它怎么算的，你才知道什么时候该忽略它"
            />
          )}

          {/* ── 需要你处理 ── */}
          <section className="rounded border border-slate-200 bg-white">
            <h2 className="border-b border-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700">
              ⚡ 需要你处理（{d.actionItems.length}）
            </h2>
            {d.actionItems.length === 0 ? (
              <p className="px-3 py-3 text-center text-xs text-slate-400">
                当前没有等着你的事 —— 这正是这个产品该有的常态
              </p>
            ) : (
              <ul>
                {d.actionItems.map((a) => (
                  <li
                    key={`${a.kind}-${a.id}`}
                    className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-xs last:border-0"
                  >
                    {a.overdueMinutes !== null ? (
                      <span className="text-red-700">⏰ 超时 {duration(a.overdueMinutes)}</span>
                    ) : a.dueInMinutes !== null ? (
                      <span className="text-amber-700">⚠ {duration(a.dueInMinutes)} 内到期</span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-slate-800">{a.title}</span>
                    <span className="text-slate-500">{riskLabel(a.riskLevel)}</span>
                    <button
                      type="button"
                      onClick={() =>
                        a.kind === 'plan'
                          ? navigate(`/projects/${projectId}/plans/${a.id}`)
                          : setOpenDecision(a.id)
                      }
                      className="rounded bg-slate-900 px-2 py-0.5 text-[11px] text-white hover:bg-slate-700"
                    >
                      处理 →
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="grid gap-3 md:grid-cols-2">
            {/* ── 阻塞与风险 ── */}
            <section className="rounded border border-slate-200 bg-white">
              <h2 className="border-b border-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700">
                ⛔ 阻塞与风险（{d.blocked.length}）
              </h2>
              {d.blocked.length === 0 ? (
                <p className="px-3 py-3 text-center text-xs text-slate-400">没有阻塞的任务</p>
              ) : (
                <ul>
                  {d.blocked.map((b) => (
                    <li key={b.id} className="border-b border-slate-100 px-3 py-1.5 last:border-0">
                      <button
                        type="button"
                        onClick={() => setOpenCard(b.id)}
                        className="w-full text-left text-xs"
                      >
                        <span className="text-red-700">
                          ⛔ {b.minutes === null ? '—' : duration(b.minutes)}
                        </span>
                        <span className="ml-2 text-slate-800">{b.title}</span>
                        {b.reason && (
                          <span className="mt-0.5 block text-[11px] text-slate-500">{b.reason}</span>
                        )}
                        {b.ownerName && (
                          <span className="text-[11px] text-slate-400">负责人 {b.ownerName}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* ── Agent 团队 ── */}
            <section className="rounded border border-slate-200 bg-white">
              <h2 className="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700">
                🤖 Agent 团队（{d.agents.length}）
                <Link
                  to={`/projects/${projectId}/agents`}
                  className="ml-auto text-[11px] font-normal text-slate-500 underline"
                >
                  全部 →
                </Link>
              </h2>
              {d.agents.length === 0 ? (
                <p className="px-3 py-3 text-center text-xs text-slate-400">还没有 Agent 执行过任务</p>
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
                          ● {a.status === 'running' ? '执行中' : a.status === 'paused' ? '已暂停' : '空闲'}
                        </span>
                        {a.currentTask && (
                          <span className="mt-0.5 block truncate text-[11px] text-slate-500">
                            {a.currentTask}
                          </span>
                        )}
                        <span className="text-[11px] text-slate-400">
                          {a.runs} 次执行
                          {a.successRate !== null && ` · 成功率 ${Math.round(a.successRate * 100)}%`}
                          {' · '}
                          {money(String(a.cost))}
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
            <h2 className="text-xs font-medium text-slate-700">👥 人类成员（{d.members.length}）</h2>
            <ul className="mt-1 space-y-0.5">
              {d.members.map((m) => (
                <li key={m.id} className="text-xs text-slate-700">
                  👤 {m.name}
                  <span className="ml-2 text-slate-500">{m.role}</span>
                  <span className="ml-2 text-slate-500">
                    {m.pendingDecisions} 项决策
                    {m.overdueDecisions > 0 && (
                      <span className="ml-1 text-red-700">（{m.overdueDecisions} 超时）</span>
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
                另有 {d.decisions.unassigned} 项决策没有指定责任人。没人认领的决策最容易烂在队列里
              </p>
            )}
          </section>

          {/* ── 最近活动 ── */}
          <section className="rounded border border-slate-200 bg-white px-3 py-2">
            <h2 className="text-xs font-medium text-slate-700">🕐 最近活动</h2>
            <ul className="mt-1 space-y-0.5">
              {d.recentActivity.map((e) => (
                <li key={e.id} className="flex items-baseline gap-2 text-[11px]">
                  <span className="text-slate-400">{relativeTime(e.occurredAt)}</span>
                  <span aria-hidden>
                    {e.actorType === 'human' ? '👤' : e.actorType === 'agent' ? '🤖' : '🔧'}
                  </span>
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
    <button
      type="button"
      onClick={onClick}
      className={clsx(
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
      {hint && <p className="text-[11px] text-slate-400">{hint}</p>}
    </button>
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
