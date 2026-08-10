import clsx from 'clsx';
import type { BoardSummary } from '../../lib/api/types';
import type { BoardView } from '../../stores/board';
import { useBoardStore } from '../../stores/board';
import type { BoardFilters } from '../../lib/api/client';
import { GatedButton } from '../../components/Gated';

const VIEWS: { key: BoardView; label: string }[] = [
  { key: 'kanban', label: 'Kanban' },
  { key: 'list', label: 'List' },
  { key: 'agent', label: 'Agent 视图' },
  { key: 'decision', label: '待决策' },
];

interface Props {
  projectName: string;
  onOpenGraph: () => void;
  onOpenAnalytics: () => void;
  onOpenPolicies: () => void;
  onOpenRequirements: () => void;
  onNewWorkItem: () => void;
  summary: BoardSummary | undefined;
  view: BoardView;
  filters: BoardFilters;
  onView: (v: BoardView) => void;
  onFilters: (patch: Partial<BoardFilters>) => void;
  onClearFilters: () => void;
}

/**
 * 顶部状态条。
 *
 * ★ 三个数字不是装饰，是行动入口（页面文档 05 §5.1）：
 *   点一下就应用对应筛选。看到「3 项阻塞」却还要自己去筛选器里找，
 *   这个数字就白显示了。
 */
export function TopBar({
  projectName,
  onOpenGraph,
  onOpenAnalytics,
  onOpenPolicies,
  onOpenRequirements,
  onNewWorkItem,
  summary,
  view,
  filters,
  onView,
  onFilters,
  onClearFilters,
}: Props) {
  const quiet = useBoardStore((s) => s.quiet);
  const toggleQuiet = useBoardStore((s) => s.toggleQuiet);
  const hasFilters =
    filters.onlyMine ||
    filters.blocked ||
    filters.humanGate ||
    filters.executorType ||
    (filters.risk?.length ?? 0) > 0;

  return (
    <div className="relative z-20 shrink-0 border-b border-slate-200/80 px-4 py-2 glass">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-sm font-semibold tracking-tight text-slate-900">
          {projectName}
          <span className="mx-1.5 font-normal text-slate-300">/</span>
          <span className="font-medium text-slate-500">看板</span>
        </h1>

        {/*
          ★ 视图切换和「去别的页」在此之前挤在同一个框里，看起来像六个平级的
            标签，其实前四个换的是这一页的呈现，后四个是跳走。分成两组之后
            不用读文字也知道哪些是「在这儿看」，哪些是「离开这儿」。
        */}
        <div className="ml-1 flex rounded-lg border border-slate-200 bg-slate-100/60 p-0.5">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => onView(v.key)}
              aria-pressed={view === v.key}
              className={clsx(
                'rounded-md px-2.5 py-1 text-xs',
                view === v.key
                  ? 'bg-white font-medium text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-800',
              )}
            >
              {v.label}
            </button>
          ))}
        </div>

        {/* 执行图与 Analytics 是独立页面而不是看板的视图 —— 它们回答的是另外的问题 */}
        <div className="flex items-center gap-0.5">
          {[
            { label: '执行图', onClick: onOpenGraph },
            { label: 'Analytics', onClick: onOpenAnalytics },
            { label: '需求', onClick: onOpenRequirements },
            { label: 'Policy', onClick: onOpenPolicies },
          ].map((link) => (
            <button
              key={link.label}
              type="button"
              onClick={link.onClick}
              className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            >
              {link.label}
              <span aria-hidden className="ml-0.5 text-[10px] text-slate-400">
                ↗
              </span>
            </button>
          ))}
        </div>

        {/*
          ★★ 在此之前工作项只能被**生成**出来（需求 → 计划 → 批准 → 分解）。
            那条链是产品的核心，但它同时让「随手记一个 bug」在系统里做不到 ——
            而那是任何任务系统最高频的一个动作。
          ★ 建出来的是**草稿**，还不能派发；放行去执行仍然要 tech_lead，
            两道 Human Gate 一个都没被绕开（见 http/work-items.ts）。
        */}
        <GatedButton
          permission="work_item.create"
          onClick={onNewWorkItem}
          className="rounded-md bg-gradient-to-r from-brand-alt via-brand to-brand-far px-2.5 py-1 text-xs font-medium text-white shadow-sm hover:brightness-110"
        >
          + 新建任务
        </GatedButton>

        <select
          value={filters.executorType ?? ''}
          onChange={(e) => onFilters({ executorType: e.target.value || undefined })}
          className="rounded-md border border-slate-200 px-1.5 py-1 text-xs"
          aria-label="执行者"
        >
          <option value="">全部执行者</option>
          <option value="agent">仅 Agent</option>
          <option value="human">仅人类</option>
        </select>

        <select
          value={filters.risk?.[0] ?? ''}
          onChange={(e) => onFilters({ risk: e.target.value ? [e.target.value] : [] })}
          className="rounded-md border border-slate-200 px-1.5 py-1 text-xs"
          aria-label="风险"
        >
          <option value="">全部风险</option>
          <option value="critical">极高</option>
          <option value="high">高</option>
          <option value="medium">中</option>
          <option value="low">低</option>
        </select>

        {hasFilters && (
          <button
            type="button"
            onClick={onClearFilters}
            className="text-xs text-slate-500 underline hover:text-slate-700"
          >
            清除筛选
          </button>
        )}

        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={Boolean(filters.onlyMine)}
            onChange={(e) => onFilters({ onlyMine: e.target.checked })}
            className="h-3.5 w-3.5 accent-brand"
          />
          只看需我处理
        </label>

        <label
          className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-500"
          title="只更新数据不做移动动画"
        >
          <input
            type="checkbox"
            checked={quiet}
            onChange={toggleQuiet}
            className="h-3.5 w-3.5 accent-slate-500"
          />
          安静模式
        </label>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs">
        <SummaryStat
          icon="⚡"
          count={summary?.pendingDecisions ?? 0}
          label="项待决策"
          active={Boolean(filters.humanGate)}
          tone={summary?.overdueDecisions ? 'danger' : 'warn'}
          onClick={() => onFilters({ humanGate: !filters.humanGate })}
        />
        <SummaryStat
          icon="⛔"
          count={summary?.blocked ?? 0}
          label="项阻塞"
          active={Boolean(filters.blocked)}
          tone="warn"
          onClick={() => onFilters({ blocked: !filters.blocked })}
        />
        <SummaryStat
          icon="🤖"
          count={summary?.executing ?? 0}
          label="个 Agent 执行中"
          active={filters.executorType === 'agent'}
          tone="neutral"
          onClick={() =>
            onFilters({ executorType: filters.executorType === 'agent' ? undefined : 'agent' })
          }
        />
        {(summary?.overdueDecisions ?? 0) > 0 && (
          <span className="font-medium text-red-700">
            其中 {summary?.overdueDecisions} 项已超时
          </span>
        )}
        {(summary?.failed ?? 0) > 0 && (
          <span className="text-red-700">❌ {summary?.failed} 项失败</span>
        )}
      </div>
    </div>
  );
}

function SummaryStat({
  icon,
  count,
  label,
  active,
  tone,
  onClick,
}: {
  icon: string;
  count: number;
  label: string;
  active: boolean;
  tone: 'danger' | 'warn' | 'neutral';
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5',
        active
          ? 'border-slate-900 bg-slate-900 text-white'
          : 'border-slate-200 bg-slate-100/50 hover:border-slate-300 hover:bg-slate-100',
        !active && tone === 'danger' && count > 0 && 'border-red-300/50 bg-red-50 text-red-700',
        !active && tone === 'warn' && count > 0 && 'border-amber-300/40 bg-amber-50 text-amber-700',
        !active && tone === 'neutral' && 'text-slate-600',
        !active && count === 0 && tone !== 'neutral' && 'text-slate-500',
      )}
    >
      <span aria-hidden className="text-[11px] leading-none">
        {icon}
      </span>
      <span className="font-semibold tabular-nums">{count}</span>
      <span className="opacity-80">{label}</span>
    </button>
  );
}
