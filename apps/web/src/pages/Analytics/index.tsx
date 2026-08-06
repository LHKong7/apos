import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ANALYTICS_RANGES,
  ANALYTICS_TABS,
  type AnalyticsRange,
  type AnalyticsTab,
  type InsightAction,
} from '@apos/domain';
import { api } from '../../lib/api/client';
import { qk } from '../../lib/query/keys';
import { relativeTime, riskLabel, statusLabel } from '../../lib/format';
import { CardSkeleton, EmptyState, ErrorState } from '../../components/states';
import { WorkItemDrawer } from '../../features/work-item/WorkItemDrawer';
import { DecisionDrawer } from '../../features/decision/DecisionDrawer';
import { InsightsPanel } from './InsightsPanel';
import { FlowTab } from './FlowTab';
import { AgentTab } from './AgentTab';
import { HitlTab } from './HitlTab';
import { CostTab } from './CostTab';

const RANGE_LABELS: Record<AnalyticsRange, string> = {
  '7d': '近 7 天',
  '30d': '近 30 天',
  '90d': '近 90 天',
};

const TAB_LABELS: Record<AnalyticsTab, string> = {
  flow: 'Flow',
  agent: 'Agent',
  hitl: 'Human-in-the-Loop',
  cost: '成本',
};

type Drill = 'rework' | 'wip' | 'slow';

const DRILL_TITLES: Record<Drill, string> = {
  rework: '返工过的任务',
  wip: '在制任务',
  slow: '耗时最长的任务',
};

/**
 * 项目 Analytics（页面文档 12）。
 *
 * ★ 这一页分析的是**交付系统本身**，不是统计任务数量。
 *   设计红线：每个图表都必须能引出一个改进动作，看完只说「哦」的图表不放。
 *   所以「系统发现」固定在顶部、不随 Tab 切换 —— 它是结论，
 *   下面四个 Tab 是论据。用户可以只看结论就走。
 */
export function AnalyticsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const range = (ANALYTICS_RANGES as readonly string[]).includes(params.get('range') ?? '')
    ? (params.get('range') as AnalyticsRange)
    : '30d';
  const tab = (ANALYTICS_TABS as readonly string[]).includes(params.get('tab') ?? '')
    ? (params.get('tab') as AnalyticsTab)
    : 'flow';
  const compare = params.get('compare') !== 'false';

  const [drill, setDrill] = useState<Drill | null>(null);
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [openDecision, setOpenDecision] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const analytics = useQuery({
    queryKey: qk.analytics(projectId!, range, compare),
    queryFn: () => api.analytics(projectId!, range, compare),
    enabled: Boolean(projectId),
    // ★ 换时间范围时不闪骨架屏，保住上一份渲染 —— 数字跳一下比空一下好读
    placeholderData: (prev) => prev,
  });

  const drillItems = useQuery({
    queryKey: qk.analyticsItems(projectId!, drill ?? '', range),
    queryFn: () => api.analyticsItems(projectId!, drill!, range),
    enabled: Boolean(projectId && drill),
  });

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  };

  const handleAction = (action: InsightAction) => {
    switch (action.kind) {
      case 'view_tab':
        if (action.tab) setParam('tab', action.tab);
        break;
      case 'view_agent':
        setParam('tab', 'agent');
        break;
      case 'view_cost':
        setParam('tab', 'cost');
        break;
      case 'view_decisions':
        setParam('tab', 'hitl');
        break;
      case 'view_items':
        setDrill(action.label.includes('返工') ? 'rework' : 'wip');
        break;
      case 'create_policy':
        // Policy 配置页还没有。说清楚现状，并给出现在就能做的替代动作 ——
        // 静默失败或者假装成功都比这句话糟糕
        setToast(
          'Policy 配置页尚未实现。当前可以在项目设置里下调该类操作的自治级别，' +
            '或联系 tech_lead 添加自动放行规则。',
        );
        break;
    }
  };

  if (!projectId) return null;

  const data = analytics.data;
  const stale = analytics.isPlaceholderData;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ── 工具栏：一行筛选控制整页，不做每张图各自的筛选 ── */}
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-slate-900">
            {data?.project.name ?? '项目'} / Analytics
          </h1>
          <Link
            to={`/projects/${projectId}/board`}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            ← 回到看板
          </Link>

          <select
            value={range}
            onChange={(e) => setParam('range', e.target.value)}
            className="ml-2 rounded border border-slate-300 px-1.5 py-1 text-xs"
            aria-label="时间范围"
          >
            {ANALYTICS_RANGES.map((r) => (
              <option key={r} value={r}>
                {RANGE_LABELS[r]}
              </option>
            ))}
          </select>

          {/* ★ 默认开启：绝对值不重要，趋势才重要（页面文档 §5.8） */}
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={compare}
              onChange={(e) => setParam('compare', String(e.target.checked))}
              className="h-3.5 w-3.5 accent-slate-900"
            />
            对比上一周期
          </label>

          {data && (
            <span className="ml-auto text-[11px] text-slate-400">
              数据实时计算 · {relativeTime(data.generatedAt)}
            </span>
          )}
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {ANALYTICS_TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setParam('tab', t)}
              className={clsx(
                'rounded px-2 py-0.5 text-xs',
                tab === t ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100',
              )}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      {analytics.isError && (
        <div className="p-4">
          <ErrorState error={analytics.error} onRetry={() => void analytics.refetch()} />
        </div>
      )}

      {analytics.isPending && (
        <div className="space-y-2 p-4">
          <CardSkeleton />
          <CardSkeleton />
        </div>
      )}

      {data && (
        <div className={clsx('min-h-0 flex-1 overflow-y-auto bg-slate-50 p-3', stale && 'opacity-60')}>
          <div className="mx-auto max-w-5xl space-y-3">
            {/*
              ★ 样本不足时先说清楚，再显示数字。
                不说的话，用户会拿一个基于 3 个任务的「返工率 33%」去开会。
            */}
            {data.confidence.level === 'low' && (
              <p className="rounded border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs text-sky-900">
                数据积累中：近 {data.confidence.days} 天完成 {data.confidence.completed} 项，
                还需约 {Math.max(0, data.confidence.needed - data.confidence.completed)} 项
                才能产出可靠分析。以下数字仅供参考，不建议据此下强结论。
              </p>
            )}

            {!compare && (
              <p className="text-[11px] text-slate-400">
                已关闭环比。首个周期或数据不足时，绝对值参考价值有限
              </p>
            )}

            <InsightsPanel
              insights={data.insights}
              onAction={handleAction}
              lowConfidence={data.confidence.level === 'low'}
            />

            {tab === 'flow' && <FlowTab data={data} onDrill={setDrill} />}
            {tab === 'agent' && <AgentTab data={data} />}
            {tab === 'hitl' && (
              <HitlTab
                data={data}
                onCreatePolicy={(r) =>
                  handleAction({ kind: 'create_policy', label: r.label, ref: r.type })
                }
              />
            )}
            {tab === 'cost' && (
              <CostTab data={data} onOpenRun={(runId) => navigate(`/runs/${runId}`)} />
            )}
          </div>
        </div>
      )}

      {/* ── 下钻：每个指标都要能落到具体任务上 ── */}
      {drill && (
        <aside className="fixed inset-y-0 right-0 z-40 flex w-[28rem] max-w-full flex-col border-l border-slate-200 bg-white shadow-xl">
          <header className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
            <h2 className="text-sm font-medium text-slate-800">{DRILL_TITLES[drill]}</h2>
            <button
              type="button"
              onClick={() => setDrill(null)}
              className="text-xs text-slate-500 hover:text-slate-800"
            >
              关闭
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {drillItems.isPending && <CardSkeleton />}
            {drillItems.data?.items.length === 0 && (
              <EmptyState icon="✓" message="没有符合条件的任务" />
            )}
            <ul className="space-y-1">
              {drillItems.data?.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => setOpenCard(item.id)}
                    className="w-full rounded border border-slate-200 px-2 py-1.5 text-left text-xs hover:border-slate-300"
                  >
                    <span className="block truncate text-slate-800">{item.title}</span>
                    <span className="mt-0.5 block text-[11px] text-slate-500">
                      {statusLabel(item.status)} · {riskLabel(item.riskLevel)}
                      {item.elapsedHours !== null && ` · 耗时 ${item.elapsedHours}h`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 z-50 max-w-lg -translate-x-1/2 rounded bg-slate-900 px-3 py-2 text-xs text-white shadow-lg">
          {toast}
          <button type="button" className="ml-2 underline" onClick={() => setToast(null)}>
            知道了
          </button>
        </div>
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

      {openDecision && (
        <DecisionDrawer decisionId={openDecision} onClose={() => setOpenDecision(null)} />
      )}
    </div>
  );
}
