import { useT, type MessageKey } from '../lib/i18n';
import clsx from 'clsx';
import type { HumanGate, RiskLevel } from '@apos/contracts';
import { Badge } from '@/components/ui/badge';
import { duration, riskLabel } from '../lib/format';

/**
 * Human Gate 八种状态（页面文档通用组件 §5.1）。
 *
 * ★ 每种都是「淡色底 + 同色描边 + 亮色字」的三件套。
 *   只给底色的话，深色主题下这些徽标会糊成一片色块 ——
 *   描边是把它们从卡面上「切」出来的那条线。
 */
const GATE_META: Record<HumanGate, { labelKey: MessageKey; icon: string; className: string }> = {
  approval_required: {
    labelKey: 'badge.awaitingApproval' as MessageKey,
    icon: '⚠',
    className: 'border-gate/30 bg-gate/10 text-amber-700',
  },
  waiting_for_decision: {
    labelKey: 'badge.awaitingDecision' as MessageKey,
    icon: '⚡',
    className: 'border-gate/30 bg-gate/10 text-amber-700',
  },
  human_reviewing: {
    labelKey: 'badge.humanReview' as MessageKey,
    icon: '👁',
    className: 'border-sky-300/40 bg-sky-100/60 text-sky-700',
  },
  human_took_over: {
    labelKey: 'badge.humanTakeover' as MessageKey,
    icon: '👤',
    className: 'border-sky-300/40 bg-sky-100/60 text-sky-700',
  },
  approved: {
    labelKey: 'badge.approved' as MessageKey,
    icon: '✓',
    className: 'border-emerald-300/40 bg-emerald-100/60 text-emerald-700',
  },
  rejected: {
    labelKey: 'badge.rejected' as MessageKey,
    icon: '✕',
    className: 'border-slate-300/60 bg-slate-200/60 text-slate-600',
  },
  escalated: {
    labelKey: 'badge.escalated' as MessageKey,
    icon: '↑',
    className: 'border-orange-300/40 bg-orange-100/60 text-orange-700',
  },
  decision_overdue: {
    labelKey: 'badge.expired' as MessageKey,
    icon: '🔴',
    className: 'border-overdue/40 bg-overdue/10 text-red-700',
  },
};

export function HumanGateBadge({
  gate,
  dueInMinutes,
}: {
  gate: HumanGate;
  dueInMinutes?: number | null;
}) {
  const t = useT();
  // 超时压过其他状态显示（HUMAN_GATE_PRIORITY 的前端体现）
  const effective: HumanGate =
    dueInMinutes !== null && dueInMinutes !== undefined && dueInMinutes < 0
      ? 'decision_overdue'
      : gate;
  const meta = GATE_META[effective];

  return (
    /**
     * ★ 底座换成 shadcn Badge，只把「哪种状态什么配色」留在 GATE_META 里。
     *   圆角、内距、字号这些以前在每个徽标里各写一遍，改一次要找八处；
     *   现在它们只存在于 Badge 的基础类里。
     *   variant 用 outline 是因为这八种状态各有各的描边色，
     *   由 meta.className 覆盖 —— 这正是 cn() 里 twMerge 的用武之地。
     */
    <Badge variant="outline" className={meta.className}>
      <span aria-hidden>{meta.icon}</span>
      {t(meta.labelKey)}
      {dueInMinutes !== null && dueInMinutes !== undefined && (
        <span className="font-normal opacity-80">
          {dueInMinutes < 0
        ? t('format.deadline.overdue', { time: duration(dueInMinutes) })
        : t('format.deadline.within', { time: duration(dueInMinutes) })}
        </span>
      )}
    </Badge>
  );
}

const RISK_STYLES: Record<RiskLevel, string> = {
  low: 'text-slate-500',
  medium: 'text-amber-600',
  high: 'text-red-600',
  critical: 'text-red-700 font-semibold',
};

/** 低风险不显示 —— 卡片上每一行都要挣得自己的位置 */
export function RiskBadge({ risk }: { risk: RiskLevel }) {
  if (risk === 'low') return null;
  return (
    <span className={clsx('text-[11px]', RISK_STYLES[risk])}>
      ● {riskLabel(risk)}
    </span>
  );
}

export function PriorityBadge({ priority }: { priority: number }) {
  // 只显示 P0/P1（页面文档 05 §5.3）
  if (priority > 1) return null;
  return (
    <Badge
      variant="outline"
      className={clsx(
        'rounded-sm px-1 font-mono text-[10px] font-semibold leading-4',
        priority === 0
          ? 'border-red-300/40 bg-red-100/70 text-red-700'
          : 'border-amber-300/40 bg-amber-100/70 text-amber-700',
      )}
    >
      P{priority}
    </Badge>
  );
}

/**
 * 成本条。
 *
 * 有预估值时显示占比，没有就只显示金额 ——
 * 造一个假的分母比不显示更糟，用户会以为「才用了一半」。
 */
export function CostMeter({
  spent,
  estimated,
}: {
  spent: string | number;
  estimated: string | number | null;
}) {
  const s = Number(spent ?? 0);
  const e = estimated === null ? null : Number(estimated);

  if (e === null || e <= 0) {
    return <span className="text-[11px] tabular-nums text-slate-500">${s.toFixed(2)}</span>;
  }

  const pct = Math.min((s / e) * 100, 200);
  const over = s > e;

  return (
    <span className="inline-flex items-center gap-1 text-[11px] tabular-nums text-slate-500">
      <span className="h-1 w-8 overflow-hidden rounded-full bg-slate-200">
        <span
          className={clsx(
            'block h-full rounded-full transition-all',
            over ? 'bg-overdue' : 'bg-gradient-to-r from-emerald-500 to-emerald-400',
          )}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </span>
      <span className={over ? 'text-red-600' : undefined}>
        ${s.toFixed(2)} / ${e.toFixed(2)}
      </span>
    </span>
  );
}

/** 阻塞时长。越久颜色越重 —— 让「卡了很久」在扫视时自己跳出来 */
export function BlockedDuration({ minutes }: { minutes: number }) {
  const t = useT();
  const severity = minutes > 240 ? 'text-red-700 font-semibold' : minutes > 60 ? 'text-blocked' : 'text-amber-600';
  return (
    <span className={clsx('text-[11px] tabular-nums', severity)}>{t('badge.blockedFor', { time: duration(minutes) })}</span>
  );
}
