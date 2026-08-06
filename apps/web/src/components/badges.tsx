import clsx from 'clsx';
import type { HumanGate, RiskLevel } from '@apos/contracts';
import { duration, riskLabel } from '../lib/format';

/** Human Gate 八种状态（页面文档通用组件 §5.1） */
const GATE_META: Record<HumanGate, { label: string; icon: string; className: string }> = {
  approval_required: { label: '待审批', icon: '⚠', className: 'bg-gate/15 text-amber-700' },
  waiting_for_decision: { label: '待决策', icon: '⚡', className: 'bg-gate/15 text-amber-700' },
  human_reviewing: { label: '人工审核中', icon: '👁', className: 'bg-sky-100 text-sky-700' },
  human_took_over: { label: '人工接管', icon: '👤', className: 'bg-sky-100 text-sky-700' },
  approved: { label: '已批准', icon: '✓', className: 'bg-emerald-100 text-emerald-700' },
  rejected: { label: '已驳回', icon: '✕', className: 'bg-slate-200 text-slate-600' },
  escalated: { label: '已升级', icon: '↑', className: 'bg-orange-100 text-orange-700' },
  decision_overdue: { label: '决策超时', icon: '🔴', className: 'bg-overdue/15 text-red-700' },
};

export function HumanGateBadge({
  gate,
  dueInMinutes,
}: {
  gate: HumanGate;
  dueInMinutes?: number | null;
}) {
  // 超时压过其他状态显示（HUMAN_GATE_PRIORITY 的前端体现）
  const effective: HumanGate =
    dueInMinutes !== null && dueInMinutes !== undefined && dueInMinutes < 0
      ? 'decision_overdue'
      : gate;
  const meta = GATE_META[effective];

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium',
        meta.className,
      )}
    >
      <span aria-hidden>{meta.icon}</span>
      {meta.label}
      {dueInMinutes !== null && dueInMinutes !== undefined && (
        <span className="font-normal opacity-80">
          {dueInMinutes < 0 ? `超时 ${duration(dueInMinutes)}` : `${duration(dueInMinutes)} 内`}
        </span>
      )}
    </span>
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
    <span
      className={clsx(
        'rounded px-1 text-[10px] font-semibold',
        priority === 0 ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700',
      )}
    >
      P{priority}
    </span>
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
          className={clsx('block h-full', over ? 'bg-overdue' : 'bg-emerald-500')}
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
  const severity = minutes > 240 ? 'text-red-700 font-semibold' : minutes > 60 ? 'text-blocked' : 'text-amber-600';
  return (
    <span className={clsx('text-[11px] tabular-nums', severity)}>⛔ 阻塞 {duration(minutes)}</span>
  );
}
