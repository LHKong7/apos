import { useState } from 'react';
import clsx from 'clsx';
import { manualTargetForStage } from '@apos/domain';
import { statusLabel } from '../../lib/format';
import type { Stage, WorkItemStatus } from '@apos/contracts';
import { BoardCard, type CardActions } from '../../features/work-item/BoardCard';
import { PlanBoardCard } from '../../features/plan/PlanBoardCard';
import { MOVE_STAGGER_MS, useBoardStore } from '../../stores/board';
import type { BoardCard as Card, BoardColumn, PlanCard } from '../../lib/api/types';
import { Button } from '@/components/ui/button';

/** 列名。★ 拒绝提示里不能甩英文 key 给用户，与后端 STAGE_NAMES 对齐 */
const STAGE_LABELS: Record<Stage, string> = {
  intake: 'Intake',
  planning: 'Planning',
  execution: 'Execution',
  review: 'Review',
  release: 'Release',
  done: 'Done',
};

interface Props {
  columns: BoardColumn[];
  actions: CardActions;
  onManualMove: (card: Card, toStatus: WorkItemStatus, toStage: Stage) => void;
  onOpenPlan: (plan: PlanCard) => void;
  hasFilters: boolean;
  onClearFilters: () => void;
  onExpandDone: () => void;
  doneExpanded: boolean;
}

export function KanbanView({
  columns,
  actions,
  onManualMove,
  onOpenPlan,
  hasFilters,
  onClearFilters,
  onExpandDone,
  doneExpanded,
}: Props) {
  const [dragging, setDragging] = useState<Card | null>(null);
  const setDraggingId = useBoardStore((s) => s.setDragging);

  return (
    /*
     * ★ 列间距 12px → 8px。这不是审美调整，是拿回横向预算：
     *   加了项目侧栏之后，看板的可用宽度少了图标栏那 56px，
     *   六列不横滚的门槛从 1332px 抬到了 1388px —— 1366 的笔记本因此
     *   全都开始横滚。缩间距 + 缩列的下限把门槛压回 1272px。
     *   宽屏上没有损失：列是 flex-1，省下来的间距全给了列本身。
     */
    <div className="board-scroll flex min-h-0 flex-1 gap-2 overflow-x-auto p-3">
      {columns.map((col) => (
        <Column
          key={col.key}
          column={col}
          actions={actions}
          onOpenPlan={onOpenPlan}
          dragging={dragging}
          hasFilters={hasFilters}
          onClearFilters={onClearFilters}
          onExpandDone={onExpandDone}
          doneExpanded={doneExpanded}
          onDragStart={(card) => {
            setDragging(card);
            setDraggingId(card.id);
          }}
          onDragEnd={() => {
            setDragging(null);
            setDraggingId(null);
          }}
          onDrop={(card, toStage) => {
            const target = manualTargetForStage(card.status, toStage);
            if (target) onManualMove(card, target.status, toStage);
          }}
        />
      ))}
    </div>
  );
}

function Column({
  column,
  actions,
  onOpenPlan,
  dragging,
  hasFilters,
  onClearFilters,
  onExpandDone,
  doneExpanded,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  column: BoardColumn;
  actions: CardActions;
  onOpenPlan: (plan: PlanCard) => void;
  dragging: Card | null;
  hasFilters: boolean;
  onClearFilters: () => void;
  onExpandDone: () => void;
  doneExpanded: boolean;
  onDragStart: (card: Card) => void;
  onDragEnd: () => void;
  onDrop: (card: Card, toStage: Stage) => void;
}) {
  const [over, setOver] = useState(false);

  const drop = dragging ? evaluateDrop(dragging, column.key) : null;
  const wipExceeded = column.wipLimit !== null && column.count >= column.wipLimit;

  return (
    <section
      onDragOver={(e) => {
        if (!dragging) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = drop?.allowed ? 'move' : 'none';
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (dragging && drop?.allowed) onDrop(dragging, column.key);
      }}
      className={clsx(
        // 六列在 1280 宽度内不横滚（含 56px 图标栏）；更窄时按 min-w 收缩后再横滚
        'flex min-w-[12rem] max-w-[20rem] flex-1 shrink-0 flex-col rounded-xl border border-slate-200/60 bg-slate-100/50 transition',
        over && drop?.allowed && 'border-emerald-400/60 ring-2 ring-emerald-400',
        over && drop && !drop.allowed && 'border-red-400/60 ring-2 ring-red-400',
      )}
    >
      <header className="flex items-baseline gap-1.5 border-b border-slate-200/50 px-2.5 py-2">
        <h2 className="text-xs font-semibold tracking-tight text-slate-700">{column.name}</h2>
        <span className="rounded-full bg-slate-200/70 px-1.5 text-[11px] tabular-nums text-slate-500">
          {column.count}
        </span>
        {column.wipLimit !== null && (
          <span
            className={clsx(
              'ml-auto text-[11px] tabular-nums',
              wipExceeded ? 'font-medium text-orange-600' : 'text-slate-400',
            )}
            title={
              wipExceeded
                ? '已达 WIP 上限，Flow Engine 暂停向该列调度新任务'
                : `WIP 上限 ${column.wipLimit}`
            }
          >
            WIP {column.count}/{column.wipLimit} {wipExceeded && '⚠'}
          </span>
        )}
      </header>

      {/* 拖到不允许的列时说明原因，而不是只给个禁止图标 */}
      {over && drop && !drop.allowed && (
        <p className="mx-2 mb-1 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
          {drop.reason}
        </p>
      )}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2 pt-2">
        {/*
          ★ 计划卡排在任务前面。这一列同时有两种东西时，「等着人批的计划」
            优先级高于任何任务 —— 它一批下去，下游整批任务才开始流动。
        */}
        {column.plans.map((plan) => (
          <PlanBoardCard key={plan.id} plan={plan} onOpen={onOpenPlan} />
        ))}

        {column.items.map((card, i) => (
          <BoardCard
            key={card.id}
            card={card}
            actions={actions}
            moveDelayMs={i * MOVE_STAGGER_MS}
            draggable
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />
        ))}

        {column.items.length === 0 && column.plans.length === 0 && (
          <p className="px-1 py-3 text-center text-[11px] text-slate-400">
            {hasFilters ? (
              <>
                无匹配{' '}
                <button type="button" onClick={onClearFilters} className="underline">
                  清除筛选
                </button>
              </>
            ) : column.key === 'execution' ? (
              '等待上游任务完成'
            ) : column.key === 'planning' ? (
              /*
               * ★ 这一列不放任务，放的是待批准的计划 —— 不说清楚的话，
               *   一个永远空着的列只会让人以为功能坏了（在此之前正是如此）。
               */
              '需求批准后，生成的计划会在这里等待批准'
            ) : (
              '暂无任务'
            )}
          </p>
        )}

        {column.hasMore && !doneExpanded && (
          <Button variant="outline" size="xs"
            onClick={onExpandDone}
            className="w-full border-dashed text-slate-500 hover:border-slate-400 hover:bg-white hover:text-slate-700">
            {/* count 含计划卡，折叠数只该算任务 */}
            ⋯ 展开其余 {column.count - column.plans.length - column.items.length} 项
          </Button>
        )}
      </div>
    </section>
  );
}

/**
 * 拖拽合法性判定。
 *
 * ★ 前端判定只为体验（立刻给出红色禁止态与原因），不是安全边界 ——
 *   后端 transition 会独立校验一次。规则同源于 WORK_ITEM_MACHINE，
 *   不在这里重写一套 if-else，否则两边迟早漂移。
 */
export function evaluateDrop(
  card: Card,
  toStage: Stage,
): { allowed: boolean; reason: string } {
  if (card.stage === toStage) return { allowed: false, reason: '已经在这一列了' };

  /**
   * ★ Planning 列装的是**待批准的计划**，不是任务 —— `planning` /
   *   `awaiting_plan_approval` 这两个状态在 WORK_ITEM_MACHINE 里没有任何
   *   转移指向，任务本来就进不去。
   *
   *   单独给一句话是因为这一列现在**看得见卡片**了：用户会自然地想把任务
   *   拖过去归类，而通用那句「不能直接进入 planning」既没解释为什么，
   *   还把 stage 的英文 key 直接甩在了脸上。
   */
  if (toStage === 'planning') {
    return {
      allowed: false,
      reason: 'Planning 列放的是待批准的计划，不接收任务卡片',
    };
  }

  // ★ 落点由状态机推导，与后端 manualTriggerFor 同源
  const target = manualTargetForStage(card.status, toStage);
  if (!target) {
    return {
      allowed: false,
      reason: `「${card.title}」当前是「${statusLabel(card.status)}」，不能直接进入「${STAGE_LABELS[toStage]}」`,
    };
  }

  if (toStage === 'execution' && card.unmetDependencies > 0) {
    return {
      allowed: false,
      reason: `该任务还有 ${card.unmetDependencies} 个前置依赖未完成，不能进入 Execution`,
    };
  }

  return { allowed: true, reason: '' };
}
