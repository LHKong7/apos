import { useEffect, useState } from 'react';
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
 * 看板工具条（Kanban / List / Agent / 待决策 四个视图共用）。
 *
 * ★★ 两行的分工是**按用途**分的，不是按「放不下了往下挪」。
 *
 *   这一版之前十五个控件挤在同一行：视图切换、四个跳去别页的链接、
 *   新建、两个筛选下拉、清除筛选、两个复选框。在 1440 宽度下正好顶满，
 *   再窄一点就折行，折出来的那半行和上面一行没有任何语义关系 ——
 *   用户要在一条视觉噪声里找「风险筛选在哪」。
 *
 *   现在：
 *     第一行 = 我在哪、看哪个视图、要新建什么   （导航与动作）
 *     第二行 = 我要看哪些卡                     （**全部**是筛选）
 *
 *   第二行因此变成一句完整的话：三个数字是筛选入口，右边三个也是筛选，
 *   中间用 ml-auto 留出的空隙就是两组的分界，不需要再画一条线。
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
      {/* ── 第一行：导航与动作 ─────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <h1 className="shrink-0 text-sm font-semibold tracking-tight text-slate-900">
          <span className="hidden sm:inline">{projectName}</span>
          <span className="mx-1.5 hidden font-normal text-slate-300 sm:inline">/</span>
          <span className="font-medium text-slate-500">看板</span>
        </h1>

        <div className="flex min-w-0 overflow-x-auto rounded-lg border border-slate-200 bg-slate-100/60 p-0.5">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => onView(v.key)}
              aria-pressed={view === v.key}
              className={clsx(
                'shrink-0 rounded-md px-3 py-1 text-xs transition',
                view === v.key
                  ? 'bg-white font-medium text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-800',
              )}
            >
              {v.label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
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
            className="rounded-md bg-gradient-to-r from-brand-alt via-brand to-brand-far px-3 py-1 text-xs font-medium text-white shadow-sm hover:brightness-110"
          >
            + 新建任务
          </GatedButton>

          <MoreMenu
            links={[
              { label: '执行图', onClick: onOpenGraph },
              { label: 'Analytics', onClick: onOpenAnalytics },
              { label: '需求', onClick: onOpenRequirements },
              { label: 'Policy', onClick: onOpenPolicies },
            ]}
            quiet={quiet}
            onToggleQuiet={toggleQuiet}
          />
        </div>
      </div>

      {/* ── 第二行：全部是筛选 ─────────────────────────────────────── */}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
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
        {/* 超时与失败是对上面三个数字的补注，跟着它们走，不进右边的筛选组 */}
        {(summary?.overdueDecisions ?? 0) > 0 && (
          <span className="font-medium text-red-700">
            其中 {summary?.overdueDecisions} 项已超时
          </span>
        )}
        {(summary?.failed ?? 0) > 0 && (
          <span className="text-red-700">❌ {summary?.failed} 项失败</span>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select
            value={filters.executorType ?? ''}
            onChange={(e) => onFilters({ executorType: e.target.value || undefined })}
            className="rounded-full border border-slate-200 bg-slate-100/50 px-2.5 py-1 text-xs text-slate-600"
            aria-label="执行者"
          >
            <option value="">全部执行者</option>
            <option value="agent">仅 Agent</option>
            <option value="human">仅人类</option>
          </select>

          <select
            value={filters.risk?.[0] ?? ''}
            onChange={(e) => onFilters({ risk: e.target.value ? [e.target.value] : [] })}
            className="rounded-full border border-slate-200 bg-slate-100/50 px-2.5 py-1 text-xs text-slate-600"
            aria-label="风险"
          >
            <option value="">全部风险</option>
            <option value="critical">极高</option>
            <option value="high">高</option>
            <option value="medium">中</option>
            <option value="low">低</option>
          </select>

          {/*
            ★ 从复选框改成开关药丸：它和左边三个数字是同一类东西（都是
              「只看某一批卡」），长得一样才看得出是一类。复选框 + 一行标签
              还比药丸宽出一截，正是这行挤的原因之一。
          */}
          <FilterToggle
            active={Boolean(filters.onlyMine)}
            onClick={() => onFilters({ onlyMine: !filters.onlyMine })}
          >
            只看需我处理
          </FilterToggle>

          {hasFilters && (
            <button
              type="button"
              onClick={onClearFilters}
              className="rounded-full px-2 py-1 text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-800"
            >
              清除筛选
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 「更多」菜单。
 *
 * ★★ 装的是**跳去别的页面**的四个链接，不是看板自己的功能。
 *
 *   它们此前和视图切换并排在同一个框里，看起来像六个平级的标签，
 *   实际上前四个换的是这一页的呈现，后四个会离开这一页。而且这四页
 *   在项目总览页有完整的导航入口 —— 这里是快捷方式，一次会话点一次，
 *   不值得一直占着第一行最贵的位置。
 *
 * ★ 安静模式也收在这儿：它是显示偏好，不是筛选，放在筛选那一行会
 *   让人以为它会改变「看到哪些卡」。
 */
function MoreMenu({
  links,
  quiet,
  onToggleQuiet,
}: {
  links: { label: string; onClick: () => void }[];
  quiet: boolean;
  onToggleQuiet: () => void;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="更多"
        title="更多"
        className={clsx(
          'relative flex h-7 w-7 items-center justify-center rounded-md border text-slate-500 transition',
          open
            ? 'border-brand/50 bg-brand/10 text-brand'
            : 'border-slate-200 hover:border-slate-300 hover:bg-slate-100 hover:text-slate-800',
        )}
      >
        <span aria-hidden className="text-sm leading-none">
          ⋯
        </span>
        {/*
          ★ 安静模式开着时给个角标。
            它一旦收进菜单，用户就没有任何线索知道「卡片为什么不动了」——
            而那正是他会去报的 bug。
        */}
        {quiet && (
          <span
            aria-hidden
            title="安静模式已开启"
            className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-brand ring-2 ring-slate-50"
          />
        )}
      </button>

      {open && (
        <>
          {/* 点空白处收起。和执行图右键菜单同一套做法 */}
          <button
            type="button"
            aria-label="关闭菜单"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            className="absolute right-0 top-full z-50 mt-1.5 w-52 animate-fade-in-up rounded-lg border border-slate-200 bg-white p-1 shadow-lg"
          >
            <p className="px-2 pb-1 pt-1.5 text-[10px] uppercase tracking-[0.12em] text-slate-400">
              去其他页面
            </p>
            {links.map((link) => (
              <button
                key={link.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  link.onClick();
                }}
                className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              >
                {link.label}
                <span aria-hidden className="ml-auto text-[10px] text-slate-400">
                  ↗
                </span>
              </button>
            ))}

            <div aria-hidden className="my-1 h-px bg-slate-200" />

            <label className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-slate-100">
              <input
                type="checkbox"
                checked={quiet}
                onChange={onToggleQuiet}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-brand"
              />
              <span>
                <span className="block text-xs text-slate-700">安静模式</span>
                <span className="block text-[10px] leading-tight text-slate-400">
                  只更新数据，不做卡片移动动画
                </span>
              </span>
            </label>
          </div>
        </>
      )}
    </div>
  );
}

/** 开关式筛选。和 SummaryStat 长一样 —— 它们本来就是同一类操作 */
function FilterToggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'rounded-full border px-2.5 py-1 transition',
        active
          ? 'border-brand/50 bg-brand/10 font-medium text-brand'
          : 'border-slate-200 bg-slate-100/50 text-slate-500 hover:border-slate-300 hover:text-slate-800',
      )}
    >
      {children}
    </button>
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
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition',
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
