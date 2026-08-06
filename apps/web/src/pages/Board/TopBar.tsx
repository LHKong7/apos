import clsx from 'clsx';
import type { BoardSummary } from '../../lib/api/types';
import type { BoardView } from '../../stores/board';
import { useBoardStore } from '../../stores/board';
import type { BoardFilters } from '../../lib/api/client';

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
    <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-sm font-semibold text-slate-900">{projectName} / 看板</h1>

        <div className="ml-2 flex rounded border border-slate-300 p-0.5">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => onView(v.key)}
              className={clsx(
                'rounded px-2 py-0.5 text-xs',
                view === v.key ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100',
              )}
            >
              {v.label}
            </button>
          ))}
          {/* 执行图与 Analytics 是独立页面而不是看板的视图 —— 它们回答的是另外的问题 */}
          <button
            type="button"
            onClick={onOpenGraph}
            className="rounded px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-100"
          >
            执行图 ↗
          </button>
          <button
            type="button"
            onClick={onOpenAnalytics}
            className="rounded px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-100"
          >
            Analytics ↗
          </button>
          <button
            type="button"
            onClick={onOpenPolicies}
            className="rounded px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-100"
          >
            Policy ↗
          </button>
        </div>

        <select
          value={filters.executorType ?? ''}
          onChange={(e) => onFilters({ executorType: e.target.value || undefined })}
          className="rounded border border-slate-300 px-1.5 py-1 text-xs"
          aria-label="执行者"
        >
          <option value="">全部执行者</option>
          <option value="agent">仅 Agent</option>
          <option value="human">仅人类</option>
        </select>

        <select
          value={filters.risk?.[0] ?? ''}
          onChange={(e) => onFilters({ risk: e.target.value ? [e.target.value] : [] })}
          className="rounded border border-slate-300 px-1.5 py-1 text-xs"
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
            className="h-3.5 w-3.5 accent-slate-900"
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
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition',
        active ? 'bg-slate-900 text-white' : 'hover:bg-slate-100',
        !active && tone === 'danger' && 'text-red-700',
        !active && tone === 'warn' && count > 0 && 'text-amber-700',
        !active && tone === 'neutral' && 'text-slate-600',
      )}
    >
      <span aria-hidden>{icon}</span>
      <span className="font-medium tabular-nums">{count}</span>
      <span>{label}</span>
    </button>
  );
}
