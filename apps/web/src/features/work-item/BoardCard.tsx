import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { AssigneeChip, actorStateFrom } from '../../components/AssigneeChip';
import { BlockedDuration, CostMeter, HumanGateBadge, PriorityBadge, RiskBadge } from '../../components/badges';
import { duration, sourceIcon, sourceLabel, statusLabel, typeIcon } from '../../lib/format';
import { MOVE_HIGHLIGHT_MS, useBoardStore } from '../../stores/board';
import type { BoardCard as Card } from '../../lib/api/types';

export interface CardActions {
  onOpen: (card: Card) => void;
  onHandleGate: (card: Card) => void;
  onRetry: (card: Card) => void;
  onRemind: (card: Card) => void;
  onTakeover: (card: Card) => void;
  onViewRun: (card: Card) => void;
}

interface Props {
  card: Card;
  actions: CardActions;
  /** 错峰序号，用于同时移动多张卡时延迟动画（页面文档 05 §5.5） */
  moveDelayMs?: number;
  draggable?: boolean;
  onDragStart?: (card: Card) => void;
  onDragEnd?: () => void;
}

/**
 * 看板卡片。
 *
 * ★ 核心设计原则（页面文档 05 §5.3）：**按状态决定显示什么**，
 *   而不是所有卡片显示所有字段。
 *
 *   所有字段都显示的卡片，扫视时每张都要重新读一遍才知道重点在哪；
 *   按状态裁剪之后，「待决策」卡片上最显眼的一定是时限和处理按钮，
 *   「失败」卡片上最显眼的一定是失败次数和下一步会发生什么。
 *
 *   卡片高度也因此保持在 120–160px：高度差异大会变成瀑布流，
 *   既难扫视，也让虚拟滚动的位置估算失准。
 */
export function BoardCard({ card, actions, moveDelayMs = 0, draggable, onDragStart, onDragEnd }: Props) {
  const move = useBoardStore((s) => s.moves.get(card.id));
  const quiet = useBoardStore((s) => s.quiet);
  const openedCardId = useBoardStore((s) => s.openedCardId);
  const clearMove = useBoardStore((s) => s.clearMove);

  const [animating, setAnimating] = useState(false);

  // 用户正在看这张卡的详情时不做动画（页面文档 05 §5.5）
  const suppressed = quiet || openedCardId === card.id;

  useEffect(() => {
    if (!move || suppressed) return;
    const start = setTimeout(() => setAnimating(true), moveDelayMs);
    const end = setTimeout(() => {
      setAnimating(false);
      clearMove(card.id);
    }, moveDelayMs + MOVE_HIGHLIGHT_MS);
    return () => {
      clearTimeout(start);
      clearTimeout(end);
    };
  }, [move, suppressed, moveDelayMs, card.id, clearMove]);

  const gate = card.humanGate;
  const overdue = card.decisionDueInMinutes !== null && card.decisionDueInMinutes < 0;

  return (
    <article
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', card.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart?.(card);
      }}
      onDragEnd={onDragEnd}
      onClick={() => actions.onOpen(card)}
      className={clsx(
        'relative cursor-pointer rounded-lg border bg-white p-2.5 text-left shadow-sm transition',
        'hover:border-slate-300 hover:shadow',
        animating && 'animate-card-land',
        overdue && !quiet && 'animate-pulse-once',
        card.status === 'failed' ? 'border-red-200' : 'border-slate-200',
      )}
    >
      {/* Human Gate 卡片左侧竖条（页面文档 05 §5.4） */}
      {gate && (
        <span
          aria-hidden
          className={clsx(
            'absolute inset-y-0 left-0 w-1 rounded-l-lg',
            overdue ? 'bg-overdue' : 'bg-gate',
          )}
        />
      )}

      {/* 移动来源角标，3 秒后随动画一起消失 */}
      {move && !suppressed && animating && (
        <span
          title={sourceLabel(move.source)}
          className="absolute -right-1 -top-1 rounded-full bg-white px-1 text-[10px] shadow ring-1 ring-slate-200"
        >
          {sourceIcon(move.source)}
        </span>
      )}

      <header className="flex items-start gap-1.5">
        <span aria-hidden className="text-xs leading-5">
          {typeIcon(card.type)}
        </span>
        <PriorityBadge priority={card.priority} />
        <h3 className="line-clamp-2 flex-1 text-[13px] font-medium leading-5 text-slate-900">
          {card.title}
        </h3>
      </header>
      {/*
        ★ 编号是这张卡唯一能**用嘴说出来**的名字：站会上指一张卡、
          聊天里提一条任务、提交信息里引用它，用的都是它而不是 uuid。
          放在标题下面而不是标题里 —— 它是标识不是内容，
          抢在标题前面会让扫视时先读到一串没有信息量的字符。
      */}
      <p className="mt-0.5 pl-5 font-mono text-[10px] text-slate-400">{card.ref}</p>

      {/* 已了结的 Gate（已批准 / 人工接管…）没有待办，只留一个小徽标交代来龙去脉 */}
      {gate && !card.humanGateRef && (
        <div className="mt-1">
          <HumanGateBadge gate={gate} />
        </div>
      )}

      <div className="mt-1.5 space-y-1.5">
        <StatusBody card={card} actions={actions} />
      </div>
    </article>
  );
}

/** 按状态裁剪的卡片主体 —— 这个 switch 就是页面文档 05 §5.3 的表格 */
function StatusBody({ card, actions }: { card: Card; actions: CardActions }) {
  const executor = card.executor;
  const chip = executor ? (
    <AssigneeChip
      actor={executor}
      state={actorStateFrom(card.status, card.runStatus)}
      size="sm"
      onClick={
        executor.type === 'agent' && card.runId
          ? () => actions.onViewRun(card)
          : undefined
      }
    />
  ) : (
    <span className="text-[11px] text-slate-400">未分配</span>
  );

  // 待审批 / 待决策：突出 Gate、时限、风险与处理入口，隐藏进度与成本
  if (card.humanGate && card.humanGateRef) {
    return (
      <>
        <HumanGateBadge gate={card.humanGate} dueInMinutes={card.decisionDueInMinutes} />
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <RiskBadge risk={card.riskLevel} />
            {card.owner && (
              <AssigneeChip actor={{ type: 'human', ...card.owner }} size="sm" />
            )}
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              actions.onHandleGate(card);
            }}
            className="shrink-0 rounded bg-gate px-2 py-0.5 text-[11px] font-medium text-white hover:brightness-95"
          >
            处理 →
          </button>
        </div>
      </>
    );
  }

  // 阻塞：突出时长与原因，成本进度都不重要
  if (card.blockedSince) {
    return (
      <>
        <BlockedDuration minutes={card.blockedMinutes ?? 0} />
        <p className="line-clamp-2 text-[11px] leading-4 text-slate-600">
          {card.blockedReason ?? '原因未记录'}
        </p>
        <div className="flex items-center justify-between gap-2">
          {card.owner ? (
            <AssigneeChip actor={{ type: 'human', ...card.owner }} size="sm" />
          ) : (
            chip
          )}
          <div className="flex shrink-0 gap-1">
            {card.humanGateRef && (
              <CardButton onClick={() => actions.onRemind(card)}>催办</CardButton>
            )}
            <CardButton onClick={() => actions.onTakeover(card)}>接管</CardButton>
          </div>
        </div>
      </>
    );
  }

  // 失败：失败次数 + 下一步会发生什么 + 直接可操作
  if (card.status === 'failed') {
    return (
      <>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-red-700">
            ❌ 失败 {card.consecutiveFailures}/3
          </span>
          {chip}
        </div>
        <p className="text-[11px] leading-4 text-slate-600">{nextActionHint(card)}</p>
        <div className="flex gap-1">
          {card.runId && <CardButton onClick={() => actions.onViewRun(card)}>看日志</CardButton>}
          <CardButton onClick={() => actions.onRetry(card)}>重试</CardButton>
          <CardButton onClick={() => actions.onTakeover(card)}>我来接管</CardButton>
        </div>
      </>
    );
  }

  // 执行中：Agent、进度、耗时、成本、最新事件
  if (card.status === 'executing') {
    const step = card.progress;
    const pct = step && step.total ? Math.round((step.step / step.total) * 100) : null;
    return (
      <>
        <div className="flex items-center justify-between gap-2">
          {chip}
          <CostMeter spent={card.cost} estimated={card.estimatedCost} />
        </div>
        {pct !== null && (
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
              <span className="block h-full bg-agent transition-all" style={{ width: `${pct}%` }} />
            </span>
            <span className="text-[11px] tabular-nums text-slate-500">{pct}%</span>
          </div>
        )}
        {card.latestNote && (
          <p className="line-clamp-1 text-[11px] text-slate-500">最新：{card.latestNote}</p>
        )}
      </>
    );
  }

  // 审核中：谁在审，进度如何
  if (card.status === 'reviewing' || card.status === 'changes_requested') {
    return (
      <>
        <div className="flex items-center justify-between gap-2">
          {chip}
          <span className="text-[11px] text-slate-500">{statusLabel(card.status)}</span>
        </div>
        {card.artifactCount > 0 && (
          <p className="text-[11px] text-slate-500">📎 {card.artifactCount} 项产物待审</p>
        )}
      </>
    );
  }

  // 已完成：执行者、Lead Time、总成本，其余全部隐藏
  if (card.status === 'done' || card.status === 'released' || card.status === 'acceptance') {
    return (
      <>
        <div className="flex items-center justify-between gap-2">
          {chip}
          <span className="text-[11px] tabular-nums text-slate-500">
            ✓ ${Number(card.cost).toFixed(2)}
          </span>
        </div>
        {card.owner && (
          <p className="text-[11px] text-slate-500">验收：{card.owner.name}</p>
        )}
      </>
    );
  }

  // 其余（待执行、规划中…）：最小信息集
  return (
    <div className="flex items-center justify-between gap-2">
      {chip}
      <div className="flex items-center gap-1.5">
        <RiskBadge risk={card.riskLevel} />
        {card.unmetDependencies > 0 && (
          <span
            className="text-[11px] text-slate-500"
            title={`${card.unmetDependencies} 个前置依赖未完成`}
          >
            🔗 {card.unmetDependencies}
          </span>
        )}
        <span className="text-[11px] text-slate-400">{statusLabel(card.status)}</span>
      </div>
    </div>
  );
}

/** 把「下一步会发生什么」讲清楚，而不是只说失败了几次 */
function nextActionHint(card: Card): string {
  const remaining = 3 - card.consecutiveFailures;
  if (remaining <= 0) return '已达失败上限，等待人工介入';
  if (remaining === 1) return '再失败 1 次将请求人工介入';
  return `还可自动重试 ${remaining} 次`;
}

function CardButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-100"
    >
      {children}
    </button>
  );
}

export { duration };
