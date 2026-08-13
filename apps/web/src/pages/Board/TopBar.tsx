import { useT, type MessageKey } from '../../lib/i18n';
import clsx from 'clsx';
import type { BoardSummary } from '../../lib/api/types';
import type { BoardView } from '../../stores/board';
import { useBoardStore } from '../../stores/board';
import type { BoardFilters } from '../../lib/api/client';
import { GatedButton } from '../../components/Gated';

/** ★ Kanban / List 两种语言写法一样，直接给字面量；另两个走词条 */
const VIEWS: { key: BoardView; label?: string; labelKey?: MessageKey }[] = [
  { key: 'kanban', label: 'Kanban' },
  { key: 'list', label: 'List' },
  { key: 'agent', labelKey: 'board.view.agent' },
  { key: 'decision', labelKey: 'board.view.decisions' },
];

interface Props {
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
 *     第一行 = 看哪个视图、要新建什么   （本页的动作）
 *     第二行 = 我要看哪些卡             （**全部**是筛选）
 *
 *   「我在哪」和「能去哪」都不在这条工具条上了 —— 它们归项目侧栏，
 *   因为那两个问题在每一页都要回答，不只是看板。
 *
 *   第二行因此变成一句完整的话：三个数字是筛选入口，右边三个也是筛选，
 *   中间用 ml-auto 留出的空隙就是两组的分界，不需要再画一条线。
 *
 * ★ 三个数字不是装饰，是行动入口（页面文档 05 §5.1）：
 *   点一下就应用对应筛选。看到「3 项阻塞」却还要自己去筛选器里找，
 *   这个数字就白显示了。
 */
export function TopBar({
  onNewWorkItem,
  summary,
  view,
  filters,
  onView,
  onFilters,
  onClearFilters,
}: Props) {
  const t = useT();
  const quiet = useBoardStore((s) => s.quiet);
  const toggleQuiet = useBoardStore((s) => s.toggleQuiet);
  const hasFilters =
    filters.onlyMine ||
    filters.blocked ||
    filters.humanGate ||
    filters.executorType ||
    filters.unclaimed ||
    (filters.risk?.length ?? 0) > 0;

  return (
    <div className="relative z-20 shrink-0 border-b border-slate-200/80 px-4 py-2 glass">
      {/* ── 第一行：看哪个视图、要新建什么 ─────────────────────────── */}
      <div className="flex items-center gap-3">
        {/* 项目名不再重复：侧栏顶上就写着，而且它一直在 */}
        <h1 className="shrink-0 text-sm font-semibold tracking-tight text-slate-900">{t('board.title')}</h1>

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
              {v.labelKey ? t(v.labelKey) : v.label}
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
            {t('board.newWorkItem')}
          </GatedButton>

          {/*
            ★ 这里曾经挂着 执行图 / Analytics / 需求 / Policy 四个跳转。
              它们现在在项目侧栏里 —— 那才是「能去哪」该待的地方，而且
              每一页都在，不只是看板。这个菜单只剩看板自己的显示偏好。
          */}
          <QuietToggle quiet={quiet} onToggle={toggleQuiet} />
        </div>
      </div>

      {/* ── 第二行：全部是筛选 ─────────────────────────────────────── */}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
        <SummaryStat
          icon="⚡"
          count={summary?.pendingDecisions ?? 0}
          label={t('board.pendingDecisions')}
          active={Boolean(filters.humanGate)}
          tone={summary?.overdueDecisions ? 'danger' : 'warn'}
          onClick={() => onFilters({ humanGate: !filters.humanGate })}
        />
        <SummaryStat
          icon="⛔"
          count={summary?.blocked ?? 0}
          label={t('board.blocked')}
          active={Boolean(filters.blocked)}
          tone="warn"
          onClick={() => onFilters({ blocked: !filters.blocked })}
        />
        <SummaryStat
          icon="🤖"
          count={summary?.executing ?? 0}
          label={t('board.agentsRunning')}
          active={filters.executorType === 'agent'}
          tone="neutral"
          onClick={() =>
            onFilters({ executorType: filters.executorType === 'agent' ? undefined : 'agent' })
          }
        />
        {/* 超时与失败是对上面三个数字的补注，跟着它们走，不进右边的筛选组 */}
        {(summary?.overdueDecisions ?? 0) > 0 && (
          <span className="font-medium text-red-700">
            {t('board.overdueOfWhich', { count: summary?.overdueDecisions ?? 0 })}
          </span>
        )}
        {(summary?.failed ?? 0) > 0 && (
          <span className="text-red-700">{t('board.failedCount', { count: summary?.failed ?? 0 })}</span>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select
            value={filters.executorType ?? ''}
            onChange={(e) => onFilters({ executorType: e.target.value || undefined })}
            className="rounded-full border border-slate-200 bg-slate-100/50 px-2.5 py-1 text-xs text-slate-600"
            aria-label={t('board.executor')}
          >
            <option value="">{t('board.allExecutors')}</option>
            <option value="agent">{t('board.agentsOnly')}</option>
            <option value="human">{t('board.humansOnly')}</option>
          </select>

          <select
            value={filters.risk?.[0] ?? ''}
            onChange={(e) => onFilters({ risk: e.target.value ? [e.target.value] : [] })}
            className="rounded-full border border-slate-200 bg-slate-100/50 px-2.5 py-1 text-xs text-slate-600"
            aria-label={t('board.risk')}
          >
            <option value="">{t('board.allRisks')}</option>
            <option value="critical">{t('board.riskCritical')}</option>
            <option value="high">{t('board.riskHigh')}</option>
            <option value="medium">{t('board.riskMedium')}</option>
            <option value="low">{t('board.riskLow')}</option>
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
            {t('board.onlyMine')}
          </FilterToggle>

          {/*
            ★ 待认领：标为人工执行但没人接的任务。批准计划时可以确认放行它们，
              没有这个入口的话，它们在看板上和别的卡片长得一模一样，
              而调度器又永远不会碰它们。
          */}
          <FilterToggle
            active={Boolean(filters.unclaimed)}
            onClick={() => onFilters({ unclaimed: !filters.unclaimed })}
          >
            {t('board.unclaimed')}
          </FilterToggle>

          {hasFilters && (
            <button
              type="button"
              onClick={onClearFilters}
              className="rounded-full px-2 py-1 text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-800"
            >
              {t('kanban.clearFilters')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 安静模式开关。
 *
 * ★ 曾经是「更多」菜单里的一项，而那个菜单主要是为四个跨页链接开的；
 *   链接搬进侧栏之后，为一个开关留一个下拉菜单就只剩累赘了。
 *
 * ★ 带字而不是只给图标：「安静模式」没有公认的图标，而它一旦开着，
 *   用户看到的现象是「卡片怎么不动了」—— 那正是他会去报的 bug。
 *   开着的时候整颗按钮点亮，关掉的路就在他刚才看的地方。
 */
function QuietToggle({ quiet, onToggle }: { quiet: boolean; onToggle: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={quiet}
      title={t('board.quietMode')}
      className={clsx(
        'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition',
        quiet
          ? 'border-brand/50 bg-brand/10 font-medium text-brand'
          : 'border-slate-200 text-slate-500 hover:border-slate-300 hover:bg-slate-100 hover:text-slate-800',
      )}
    >
      <svg
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        aria-hidden
      >
        {/* 三条速度线；开着的时候划掉 —— 「动效关了」 */}
        <path d="M2.5 5h8M2.5 8h6M2.5 11h9" />
        {quiet && <path d="M13.5 3.5l-11 9" />}
      </svg>
      {t('board.quietMode')}
    </button>
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
