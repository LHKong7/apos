import clsx from 'clsx';
import { AssigneeChip } from '../../components/AssigneeChip';
import { duration } from '../../lib/format';
import type { PlanCard } from '../../lib/api/types';
import { Button } from '@/components/ui/button';

/** 等太久要能在余光里看出来。阈值与 BlockedDuration 对齐，全站一个尺度 */
function waitingTone(minutes: number): string {
  if (minutes > 240) return 'text-red-700 font-semibold';
  if (minutes > 60) return 'text-amber-600';
  return 'text-slate-500';
}

/**
 * 「计划待批准」卡片 —— 页面文档 05 §5.2 原型图里 Planning 列那一张。
 *
 * ★★ 为什么 Planning 列放的是计划而不是任务：
 *
 *   `planning` / `awaiting_plan_approval` 这两个状态在 WORK_ITEM_MACHINE 里
 *   只作为起点出现，没有任何一条转移指向它们 —— 也就是说**没有任何工作项
 *   能进入这一列**。而计划生成时任务是直接建成 draft 的（planning/service.ts），
 *   躺在 Intake。于是这一列在此之前永远是空的，用户只能猜它是干嘛的。
 *
 *   真正卡在这个阶段的东西是「一份等着人批的计划」。它才是这一列的内容。
 *
 * ★ 刻意不复用 BoardCard：计划没有状态机、没有执行者、没有依赖，
 *   套进去要给一半字段填 null，而 BoardCard 里那些按状态分支的逻辑
 *   会开始处理一个永远不成立的形态。
 */
export function PlanBoardCard({ plan, onOpen }: { plan: PlanCard; onOpen: (plan: PlanCard) => void }) {
  return (
    <article
      onClick={() => onOpen(plan)}
      /**
       * ★ 不加 draggable：计划不走工作项状态机，拖到别的列没有任何语义。
       *   给一个能拖起来、但落到哪都被拒的卡片，比不能拖更让人困惑。
       */
      className={clsx(
        'lift relative cursor-pointer overflow-hidden rounded-lg border border-slate-200 bg-white p-2.5 text-left shadow-sm',
        'hover:border-slate-300 hover:shadow-md',
      )}
    >
      {/* 左侧竖条 —— 与 Human Gate 卡片同一个视觉语言：这张卡在等人 */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b from-gate to-gate/50"
      />

      <header className="flex items-start gap-1.5">
        <span aria-hidden className="text-xs leading-5">
          📋
        </span>
        <span className="shrink-0 rounded bg-slate-100 px-1 text-[10px] font-medium leading-5 text-slate-500">
          Plan v{plan.version}
        </span>
        <h3 className="line-clamp-2 flex-1 text-[13px] font-medium leading-5 text-slate-900">
          {plan.title}
        </h3>
      </header>

      {/*
        ★ 两行，每行两组，而不是把五样东西挤在一行 —— 看板列在 1366 的
          笔记本上只有约 200px 宽，挤在一行的结果是「已等 1m」被折成两行，
          卡片高度跟着窜出去，整列的扫视节奏就乱了。
      */}
      <div className="mt-1.5 space-y-1.5">
        <div className="flex items-center justify-between gap-1.5 text-[11px] text-slate-500">
          {/*
            ★ 「+N 任务」是这张卡最该先被读到的东西：它回答的是
              「批下去会发生什么」，而那正是批准前唯一要判断的事。
          */}
          <span className="truncate">
            <span className="font-medium text-slate-700">+{plan.taskCount} 任务</span>
            {plan.estimatedHours && (
              <span className="ml-1.5 tabular-nums">{Number(plan.estimatedHours)}h</span>
            )}
            {plan.estimatedCost && (
              <span className="ml-1.5 tabular-nums">${Number(plan.estimatedCost).toFixed(2)}</span>
            )}
          </span>
          {/*
            ★ 显示的是「已等待」而不是原型图上的「⏳ 4h 内」倒计时：
              计划没有截止时间字段，编一个出来是在界面上撒谎。
              等待时长同样能表达「这事拖着没人管」。
          */}
          <span
            className={clsx('shrink-0 whitespace-nowrap tabular-nums', waitingTone(plan.waitingMinutes))}
            title="已等待批准的时长"
          >
            ⏳ {duration(plan.waitingMinutes)}
          </span>
        </div>

        <div className="flex items-center justify-between gap-2">
          {plan.approver ? (
            <AssigneeChip actor={{ type: 'human', ...plan.approver }} size="sm" />
          ) : (
            <span className="text-[11px] text-slate-400">无技术负责人</span>
          )}
          <Button variant="gate" size="xs"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(plan);
            }}
            className="shrink-0 hover:brightness-110">
            处理 →
          </Button>
        </div>
      </div>
    </article>
  );
}
