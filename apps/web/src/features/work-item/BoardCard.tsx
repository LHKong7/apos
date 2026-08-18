import { t, useT } from '../../lib/i18n';
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { AssigneeChip, actorStateFrom } from '../../components/AssigneeChip';
import { BlockedDuration, CostMeter, HumanGateBadge, PriorityBadge, RiskBadge } from '../../components/badges';
import {
  duration,
  sourceIcon,
  sourceLabel,
  statusLabel,
  tokens,
  typeIcon,
  typeLabel,
} from '../../lib/format';
import { MOVE_HIGHLIGHT_MS, useBoardStore } from '../../stores/board';
import type { BoardCard as Card } from '../../lib/api/types';
import { Button } from '@/components/ui/button';
import { useBlockedSummary } from './BlockedReasons';
import { DependencyChain } from './DependencyChain';

export interface CardActions {
  onOpen: (card: Card) => void;
  /**
   * 按 id 打开另一张卡。
   *
   * ★ 与 `onOpen` 分开是因为依赖链上的目标**不在当前这一批卡片里** ——
   *   它可能在别的列、被筛选掉了、甚至不在这一屏。只有 id 可用。
   */
  onOpenById: (id: string) => void;
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
        'lift relative cursor-pointer overflow-hidden rounded-lg border bg-white p-2.5 text-left shadow-sm',
        'hover:border-slate-300 hover:shadow-md',
        animating && 'animate-card-land',
        overdue && !quiet && 'animate-pulse-once',
        card.status === 'failed' ? 'border-red-200' : 'border-slate-200',
        // 超时的卡片自己发一点光。一屏三十张卡时，只靠左边那条竖线
        // 是找不到它的 —— 发光是在余光里也成立的那一层
        overdue && 'glow-overdue',
      )}
    >
      {/* Human Gate 卡片左侧竖条（页面文档 05 §5.4） */}
      {gate && (
        <span
          aria-hidden
          className={clsx(
            'absolute inset-y-0 left-0 w-[3px]',
            overdue
              ? 'bg-gradient-to-b from-overdue to-overdue/50'
              : 'bg-gradient-to-b from-gate to-gate/50',
          )}
        />
      )}

      {/* 移动来源角标，3 秒后随动画一起消失 */}
      {move && !suppressed && animating && (
        <span
          title={sourceLabel(move.source)}
          className="absolute right-1 top-1 rounded-full bg-slate-100 px-1 text-[10px] shadow ring-1 ring-slate-200"
        >
          {sourceIcon(move.source)}
        </span>
      )}

      <header className="flex items-start gap-1.5">
        {/* ★ 图标只给眼睛，类型名给读屏 —— 「🔍」被读成「放大镜」而不是「调研」（#19） */}
        <span aria-hidden className="text-xs leading-5" title={typeLabel(card.type)}>
          {typeIcon(card.type)}
        </span>
        <span className="sr-only">{typeLabel(card.type)}</span>
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
  const t = useT();
  const summarize = useBlockedSummary();
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
    <span className="text-[11px] text-slate-400">{t('card.unassigned')}</span>
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
          <Button variant="gate" size="xs"
            onClick={(e) => {
              e.stopPropagation();
              actions.onHandleGate(card);
            }}
            className="shrink-0 hover:brightness-110">
            {t('card.handle')}
          </Button>
        </div>
      </>
    );
  }

  // 阻塞：突出时长与原因，成本进度都不重要
  if (card.blockedSince) {
    return (
      <>
        <BlockedDuration minutes={card.blockedMinutes ?? 0} />
        {/*
          ★ 归并同类后的一句话，不是服务端拼好的那串分号（问题记录 #2 / #25）。
            完整分项在详情抽屉里 —— 卡片只负责让人一眼看出「卡在哪一类」。
        */}
        <p className="line-clamp-2 text-[11px] leading-4 text-slate-600">
          {summarize(card.blockedDetail, card.blockedReason)}
        </p>
        <div className="flex items-center justify-between gap-2">
          {card.owner ? (
            <AssigneeChip actor={{ type: 'human', ...card.owner }} size="sm" />
          ) : (
            chip
          )}
          <div className="flex shrink-0 gap-1">
            {card.humanGateRef && (
              <CardButton onClick={() => actions.onRemind(card)}>{t('card.remind')}</CardButton>
            )}
            {/*
              ★★ 「接管」按钮只在真的接得了的时候出现。
                此前它跟着 `blockedSince` 这个**标记**走，而标记可以挂在
                status 仍是 ready 的卡片上 —— 卡片写着「已阻塞」，点下去
                报「当前状态 ready 不支持该操作」，一句和按钮自己互相矛盾的话
                （问题记录 #16 / #27）。状态是事实，标记只是注解。
            */}
            {canTakeOver(card) ? (
              <CardButton onClick={() => actions.onTakeover(card)}>
                {t('card.takeOver')}
              </CardButton>
            ) : (
              <CardButton onClick={() => actions.onOpen(card)}>{t('card.howToFix')}</CardButton>
            )}
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
            {t('card.failedTimes', { count: card.consecutiveFailures })}
          </span>
          {chip}
        </div>
        <p className="text-[11px] leading-4 text-slate-600">{nextActionHint(card)}</p>
        <div className="flex gap-1">
          {card.runId && <CardButton onClick={() => actions.onViewRun(card)}>{t('card.viewLog')}</CardButton>}
          <CardButton onClick={() => actions.onRetry(card)}>{t('card.retry')}</CardButton>
          {canTakeOver(card) && (
            <CardButton onClick={() => actions.onTakeover(card)}>{t('card.takeItOver')}</CardButton>
          )}
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
          <CostMeter spent={card.tokens} estimated={card.estimatedTokens} />
        </div>
        {pct !== null && (
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
              {/* 进度条用 Agent 色渐变 —— 全站「机器在做事」只有这一个色 */}
              <span
                className="block h-full rounded-full bg-gradient-to-r from-agent/70 to-agent transition-all"
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="text-[11px] tabular-nums text-slate-500">{pct}%</span>
          </div>
        )}
        {card.latestNote && (
          <p className="line-clamp-1 text-[11px] text-slate-500">{t('card.latestNote', { note: card.latestNote })}</p>
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
          <p className="text-[11px] text-slate-500">{t('card.artifactsPending', { count: card.artifactCount })}</p>
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
            ✓ {tokens(card.tokens)}
          </span>
        </div>
        {card.owner && (
          <p className="text-[11px] text-slate-500">{t('card.acceptanceBy', { name: card.owner.name })}</p>
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
        {/*
          ★ 依赖徽标从一个死数字变成可展开的链条：
            知道「有 1 条没完成」回答不了「先做哪个、等谁、催谁」
            （问题记录 #21）。
        */}
        <DependencyChain card={card} onOpen={(id) => actions.onOpenById(id)} />
        <span className="text-[11px] text-slate-400">{statusLabel(card.status)}</span>
      </div>
    </div>
  );
}

/**
 * 这张卡现在接得了吗 / Can a human take this over right now?
 *
 * ★★ 与状态机保持一致，不与卡片长相保持一致。
 *   `human_took_over` 只从 executing 出发，`escalated_to_human` 只从
 *   blocked / failed 出发（work-item-machine.ts）—— 服务端会按当前状态
 *   挑触发器，但**没有合法触发器的状态上根本不该出现这个按钮**。
 *   一个点了必然报错的按钮，比没有这个按钮更伤：用户会以为自己点错了。
 *
 * Mirrors the state machine, not the card's appearance. A button that always
 * fails is worse than no button — the user assumes they mis-clicked.
 */
function canTakeOver(card: Card): boolean {
  return card.status === 'executing' || card.status === 'blocked' || card.status === 'failed';
}

/** 把「下一步会发生什么」讲清楚，而不是只说失败了几次 */
function nextActionHint(card: Card): string {
  const remaining = 3 - card.consecutiveFailures;
  if (remaining <= 0) return t('card.retryExhausted');
  if (remaining === 1) return t('card.oneMoreFailure');
  return t('card.retriesLeft', { count: remaining });
}

function CardButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <Button variant="outline" size="xs"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="hover:border-slate-400 hover:text-slate-800">
      {children}
    </Button>
  );
}

export { duration };
