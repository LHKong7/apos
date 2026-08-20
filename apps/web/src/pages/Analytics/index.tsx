import { useT, type MessageKey } from '../../lib/i18n';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ANALYTICS_RANGES,
  ANALYTICS_TABS,
  type AnalyticsRange,
  type AnalyticsTab,
  type Insight,
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
import { QualityTab } from './QualityTab';
import { BenefitTab } from './BenefitTab';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const RANGE_KEYS: Record<AnalyticsRange, MessageKey> = {
  '7d': 'analytics.last7d',
  '30d': 'analytics.last30d',
  '90d': 'analytics.last90d',
};

/** ★ 前三个是专有名词，两种语言一样；后三个走词条 */
const TAB_LITERALS: Partial<Record<AnalyticsTab, string>> = {
  flow: 'Flow',
  agent: 'Agent',
  hitl: 'Human-in-the-Loop',
};

const TAB_KEYS: Partial<Record<AnalyticsTab, MessageKey>> = {
  cost: 'analytics.tab.tokens',
  quality: 'analytics.tab.quality',
  benefit: 'analytics.tab.costBenefit',
};

function tabLabel(tab: AnalyticsTab, tr: (k: MessageKey) => string): string {
  const key = TAB_KEYS[tab];
  return key ? tr(key) : (TAB_LITERALS[tab] ?? tab);
}

type Drill = 'rework' | 'wip' | 'slow';

const DRILL_KEYS: Record<Drill, MessageKey> = {
  rework: 'analytics.reworked',
  wip: 'analytics.inProgress',
  slow: 'analytics.slowest',
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
  const t = useT();
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

  /**
   * ★ `insight` 可选：HitlTab 那条「按建议建规则」的入口只发 create_policy，
   *   手上没有 Insight。只有 view_items 会读它。
   */
  const handleAction = (action: InsightAction, insight?: Insight) => {
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
        /**
         * ★★ 按 insight.type 分流，不能拿 label 去匹配文字。
         *
         *   label 是**服务端**生成的中文句子（「看返工的任务」），而这里能拿到的
         *   只有译文 —— 英文（默认语言）下两边永远对不上，于是返工的下钻
         *   会静默落到在制品那一栏。这类 bug 不报错，只是给错答案。
         *
         *   type 是枚举，跟语言无关。同一条纪律：跨语言的判定要落在结构上，
         *   不落在句子上。
         */
        setDrill(insight?.type === 'rework_high' ? 'rework' : 'wip');
        break;
      case 'create_policy':
        // ★ 「分析 → 规则」是产品持续降低人类负担的飞轮。
        //   这个跳转把它接上了：从「这类决策你做了 6 次结果都一样」
        //   直接走到能创建规则的地方
        navigate(`/projects/${projectId}/settings/policies`);
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
            {data?.project.name ?? t('policy.scope.project')} / Analytics
          </h1>
          <Link
            to={`/projects/${projectId}/board`}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            {t('nav.backToBoard')}
          </Link>

          <Select value={range} onValueChange={(v) => setParam('range', v)}>
            <SelectTrigger className="ml-2 w-auto" aria-label={t('analytics.timeRange')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ANALYTICS_RANGES.map((r) => (
                <SelectItem key={r} value={r}>
                  {t(RANGE_KEYS[r])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* ★ 默认开启：绝对值不重要，趋势才重要（页面文档 §5.8） */}
          <Label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-600">
            <Checkbox
              tone="neutral"
              checked={compare}
              onCheckedChange={(v) => setParam('compare', String(v))}
            />
            {t('analytics.comparePrevious')}
          </Label>

          {data && (
            <span className="ml-auto text-[11px] text-slate-400">
              {t('analytics.computedLive', { time: relativeTime(data.generatedAt) })}
            </span>
          )}
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {/* ★ 参数不叫 t —— 会遮住 i18n 的 t */}
          {ANALYTICS_TABS.map((key) => (
            <Button variant="ghost"
              key={key}
              onClick={() => setParam('tab', key)}
              className={clsx('h-auto p-0 font-normal whitespace-normal hover:bg-transparent', 
                'rounded px-2 py-0.5 text-xs',
                tab === key ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100',
              )}
            >
              {tabLabel(key, t)}
            </Button>
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
                {t('analytics.lowConfidence', {
                  days: data.confidence.days,
                  completed: data.confidence.completed,
                  needed: Math.max(0, data.confidence.needed - data.confidence.completed),
                })}
              </p>
            )}

            {!compare && (
              <p className="text-[11px] text-slate-400">
                {t('analytics.compareOff')}
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
                  handleAction({
                    kind: 'create_policy',
                    code: 'create_policy_for',
                    params: { name: r.label },
                    label: r.label,
                    ref: r.type,
                  })
                }
              />
            )}
            {tab === 'cost' && (
              <CostTab data={data} onOpenRun={(runId) => navigate(`/runs/${runId}`)} />
            )}
            {tab === 'quality' && <QualityTab data={data} projectId={projectId!} />}
            {tab === 'benefit' && <BenefitTab data={data} projectId={projectId!} />}
          </div>
        </div>
      )}

      {/* ── 下钻：每个指标都要能落到具体任务上 ── */}
      {drill && (
        <aside className="fixed inset-y-0 right-0 z-40 flex w-[28rem] max-w-full flex-col border-l border-slate-200 bg-white shadow-xl">
          <header className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
            <h2 className="text-sm font-medium text-slate-800">{t(DRILL_KEYS[drill])}</h2>
            <Button variant="ghost"
              onClick={() => setDrill(null)}
              className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent text-xs text-slate-500 hover:text-slate-800"
            >
              {t('common.close')}
            </Button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {drillItems.isPending && <CardSkeleton />}
            {drillItems.data?.items.length === 0 && (
              <EmptyState icon="✓" message={t('analytics.noMatching')} />
            )}
            <ul className="space-y-1">
              {drillItems.data?.items.map((item) => (
                <li key={item.id}>
                  <Button variant="outline" size="sm"
                    onClick={() => setOpenCard(item.id)}
                    className="w-full border-slate-200 text-left hover:border-slate-300">
                    <span className="block truncate text-slate-800">{item.title}</span>
                    <span className="mt-0.5 block text-[11px] text-slate-500">
                      {statusLabel(item.status)} · {riskLabel(item.riskLevel)}
                      {item.elapsedHours !== null && t('analytics.elapsed', { hours: item.elapsedHours })}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 z-50 max-w-lg -translate-x-1/2 rounded bg-slate-900 px-3 py-2 text-xs text-white shadow-lg">
          {toast}
          <Button variant="ghost" className="h-auto p-0 font-normal whitespace-normal hover:bg-transparent ml-2 underline" onClick={() => setToast(null)}>
            {t('common.gotIt')}
          </Button>
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
