import { useT, type MessageKey } from '../../lib/i18n';
import clsx from 'clsx';
import type { BoardSummary } from '../../lib/api/types';
import type { BoardView } from '../../stores/board';
import { useBoardStore } from '../../stores/board';
import type { BoardFilters } from '../../lib/api/client';
import { GatedButton } from '../../components/Gated';
import { Button } from '@/components/ui/button';
import {
  SELECT_EMPTY,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  fromSelectValue,
  toSelectValue,
} from '@/components/ui/select';

/**
 * 显示模式。
 *
 * ★★ 「待决策」不在这一组里。
 *
 *   四个标签并排时它们看起来是同一个维度的四个取值，而实际上
 *   Kanban / List / Agent 回答的是「同一批卡怎么排」，「待决策」
 *   回答的是「只看哪一批卡」—— 后者是筛选，混进来之后用户会以为
 *   切过去是换个排法，结果卡片少了一大半（问题记录 #23）。
 *
 *   它拆出去单独站一格，并且带上待办数 —— 那正是它和另外三个
 *   最大的不同：它是个有数量的收件箱。
 *
 * ★ Kanban / List 两种语言写法一样，直接给字面量；Agent 走词条。
 */
const VIEWS: { key: BoardView; label?: string; labelKey?: MessageKey }[] = [
  { key: 'kanban', label: 'Kanban' },
  { key: 'list', label: 'List' },
  { key: 'agent', labelKey: 'board.view.agent' },
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
            <Button
              key={v.key}
              variant="ghost"
              onClick={() => onView(v.key)}
              aria-pressed={view === v.key}
              className={clsx(
                'h-auto shrink-0 px-3 py-1 text-xs',
                view === v.key
                  ? 'bg-white font-medium text-slate-900 shadow-sm hover:bg-white'
                  : 'font-normal text-slate-500 hover:bg-transparent hover:text-slate-800',
              )}
            >
              {v.labelKey ? t(v.labelKey) : v.label}
            </Button>
          ))}
        </div>

        {/*
          ★ 待决策单独站一格，和上面那组之间留出空隙 ——
            它是「只看等我拍板的那些」，不是第四种排法（问题记录 #23）。
            带数字，而且超时时变红：一个收件箱最该说清的是「有几件、急不急」。
        */}
        <Button
          variant="outline"
          onClick={() => onView('decision')}
          aria-pressed={view === 'decision'}
          title={t('board.view.decisionsHint')}
          className={clsx(
            'h-auto shrink-0 gap-1.5 rounded-lg px-2.5 py-1 text-xs shadow-none',
            view === 'decision'
              ? 'border-slate-900 bg-slate-900 font-medium text-white hover:bg-slate-700 hover:text-white'
              : (summary?.overdueDecisions ?? 0) > 0
                ? 'border-red-300/60 bg-red-50 font-normal text-red-700 hover:bg-red-100'
                : 'border-slate-200 bg-slate-100/50 font-normal text-slate-600 hover:border-slate-300',
          )}
        >
          {t('board.view.decisions')}
          {(summary?.pendingDecisions ?? 0) > 0 && (
            <span className="font-semibold tabular-nums">{summary?.pendingDecisions}</span>
          )}
        </Button>

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

        {/*
          ★★ 这两个开关挪到了左边，和三个数字药丸挨着。
            它们此前紧贴右边那两个下拉框 —— 看起来像是同一组「选一个值」的
            控件，而实际上它们和左边那三个是同一类：**只看某一批卡**
            （问题记录 #22）。下拉框回答「哪一种执行者 / 哪一档风险」，
            开关回答「要不要只留这一批」，两种是不同的操作。
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

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select
            value={toSelectValue(filters.executorType)}
            onValueChange={(v) => onFilters({ executorType: fromSelectValue(v) || undefined })}
          >
            <SelectTrigger
              className="h-auto w-auto rounded-full border-slate-200 bg-slate-100/50 px-2.5 py-1 text-slate-600"
              aria-label={t('board.executor')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SELECT_EMPTY}>{t('board.allExecutors')}</SelectItem>
              <SelectItem value="agent">{t('board.agentsOnly')}</SelectItem>
              <SelectItem value="human">{t('board.humansOnly')}</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={toSelectValue(filters.risk?.[0])}
            onValueChange={(v) => {
              const risk = fromSelectValue(v);
              onFilters({ risk: risk ? [risk] : [] });
            }}
          >
            <SelectTrigger
              className="h-auto w-auto rounded-full border-slate-200 bg-slate-100/50 px-2.5 py-1 text-slate-600"
              aria-label={t('board.risk')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SELECT_EMPTY}>{t('board.allRisks')}</SelectItem>
              <SelectItem value="critical">{t('board.riskCritical')}</SelectItem>
              <SelectItem value="high">{t('board.riskHigh')}</SelectItem>
              <SelectItem value="medium">{t('board.riskMedium')}</SelectItem>
              <SelectItem value="low">{t('board.riskLow')}</SelectItem>
            </SelectContent>
          </Select>

          {hasFilters && (
            <Button
              variant="ghost"
              onClick={onClearFilters}
              className="h-auto rounded-full px-2 py-1 font-normal text-slate-500 underline decoration-slate-300 underline-offset-2 hover:bg-transparent hover:text-slate-800"
            >
              {t('kanban.clearFilters')}
            </Button>
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
  /**
   * ★★ 两个状态各有各的说明。
   *
   *   此前不论开关，tooltip 都是同一句「安静模式：更新数据但不播放卡片
   *   移动动画」—— 它描述的是**开着**时的行为，于是关着的时候那句话是错的，
   *   而用户点它之前看到的恰恰是关着的状态（问题记录 #20 / #47）。
   *
   *   两句话都点明「这只影响动效，不影响数据」——「卡片怎么不动了」
   *   是这个开关最常被误报成的 bug。
   */
  const label = quiet ? t('board.quietMode.on') : t('board.quietMode.off');
  return (
    <Button
      variant="outline"
      onClick={onToggle}
      aria-pressed={quiet}
      aria-label={label}
      title={label}
      className={clsx(
        'h-auto gap-1.5 px-2 py-1 text-xs shadow-none',
        quiet
          ? 'border-brand/50 bg-brand/10 font-medium text-brand hover:bg-brand/10 hover:text-brand'
          : 'border-slate-200 font-normal text-slate-500 hover:border-slate-300 hover:bg-slate-100 hover:text-slate-800',
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
    </Button>
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
    <Button
      variant="outline"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'h-auto rounded-full px-2.5 py-1 text-inherit shadow-none',
        active
          ? 'border-brand/50 bg-brand/10 font-medium text-brand hover:bg-brand/10 hover:text-brand'
          : 'border-slate-200 bg-slate-100/50 font-normal text-slate-500 hover:border-slate-300 hover:bg-slate-100/50 hover:text-slate-800',
      )}
    >
      {children}
    </Button>
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
    <Button
      variant="outline"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'h-auto gap-1.5 rounded-full px-2.5 py-1 text-inherit font-normal shadow-none',
        active
          ? 'border-slate-900 bg-slate-900 text-white hover:bg-slate-700 hover:text-white'
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
    </Button>
  );
}
