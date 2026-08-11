import { useState } from 'react';
import clsx from 'clsx';
import { manualTargetForStage } from '@apos/domain';
import { statusLabel } from '../../lib/format';
import type { Stage, WorkItemStatus } from '@apos/contracts';
import { BoardCard, type CardActions } from '../../features/work-item/BoardCard';
import { MOVE_STAGGER_MS, useBoardStore } from '../../stores/board';
import type { BoardCard as Card, BoardColumn } from '../../lib/api/types';

interface Props {
  columns: BoardColumn[];
  actions: CardActions;
  onManualMove: (card: Card, toStatus: WorkItemStatus, toStage: Stage) => void;
  hasFilters: boolean;
  onClearFilters: () => void;
  onExpandDone: () => void;
  doneExpanded: boolean;
}

export function KanbanView({
  columns,
  actions,
  onManualMove,
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

        {column.items.length === 0 && (
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
            ) : (
              '暂无任务'
            )}
          </p>
        )}

        {column.hasMore && !doneExpanded && (
          <button
            type="button"
            onClick={onExpandDone}
            className="w-full rounded-md border border-dashed border-slate-300 py-1 text-[11px] text-slate-500 hover:border-slate-400 hover:bg-white hover:text-slate-700"
          >
            ⋯ 展开其余 {column.count - column.items.length} 项
          </button>
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

  // ★ 落点由状态机推导，与后端 manualTriggerFor 同源
  const target = manualTargetForStage(card.status, toStage);
  if (!target) {
    return {
      allowed: false,
      reason: `「${card.title}」当前是「${statusLabel(card.status)}」，不能直接进入 ${toStage}`,
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
